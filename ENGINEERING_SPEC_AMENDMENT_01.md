# Amendment 01 — Converter Engine Substitutions

## Amendment to `Document_to_Markdown_Vercel_100MB_ENGINEERING_SPEC.md`

**Status:** Active — binding  
**Applies to:** Section 1 hard constraints, Sections 33–35, 39, 49, 51, 55, 56, 64, 71  
**Scope of change:** Converter internals only  
**Architecture impact:** None  
**AI/LLM impact:** None. AI token usage remains exactly zero.  
**Introduced:** mid-build

---

# A0. Claude Code directive for this amendment

Read this file together with `ENGINEERING_SPEC.md`.

Precedence rules:

- Where this amendment contradicts `ENGINEERING_SPEC.md`, **this amendment wins**.
- Where this amendment is silent, `ENGINEERING_SPEC.md` remains in force unchanged.
- Section numbers in this document refer to `ENGINEERING_SPEC.md` unless prefixed with `A`.

This amendment exists because Section 1 of the spec states `PPTX uses python-pptx` and `PDF uses pypdf` as hard constraints, and Section 6 forbids silent architecture change. Without this amendment you would be required to treat the substitutions below as forbidden deviations. They are now authorized.

Do **not** treat this amendment as permission to revisit anything else.

## A0.1 What this amendment does NOT change

The following remain exactly as specified. Do not modify, refactor, or "improve" them under this amendment:

```text
Section 3   Why Blob is mandatory
Section 6   Primary architecture
Sections 11-20  Blob paths, upload flow, job tokens, converter request/response
Sections 21-27  Workspace, scratch budgets, streaming, duration, concurrency
Sections 28-31  FastAPI endpoints, format validation, ZIP safety, filename sanitization
Sections 37-38  Markdown output contract, output package
Sections 40-47  Retention, cleanup, env vars, auth, rate limiting, security, error codes, logging
Sections 52-54  Frontend state machine, cancellation, accessibility
Sections 57-59  Near-100 MB test, resource-failure tests, privacy tests
Section 65      Vercel settings
Section 66      Complete data flow
```

The Blob data path is untouched. The `Python Converter Service / FastAPI container` box in the Section 6 diagram keeps its position, its signed-GET input and its signed-PUT output. Only what runs *inside* that box changes.

## A0.2 Mid-build application

| Current build state | Action |
|---|---|
| Phase 1 in progress | Apply A1–A7 now, before Phase 1 completion. |
| Phase 1 complete, Phase 2/3 in progress | Apply as a **Phase 1b patch**. Do not pause Phase 2/3. Blob and UI work is unaffected. |
| Phase 4 or later | Apply A1–A2, then re-run Sections 57 and A8 tests in full. Do not ship without re-running the near-100 MB test. |

If `PptxConverter` has already been written against raw `python-pptx`, do not delete it. See A1.6.

---

# A1. PPTX — replace the hand-rolled converter (Section 34)

## A1.1 Rationale

Section 34 specifies behaviour that an existing, maintained library already implements:

| Section 34 requirement | `pptx2md` behaviour |
|---|---|
| Slide title as heading | Titles parsed to Markdown headings |
| Bullet paragraphs | Lists at arbitrary depth |
| Pictures extracted to files, relative path inserted | Native behaviour, configurable output directory |
| Native tables to GitHub-style tables | Supported, including merged cells |
| Reading order: top coordinate then left coordinate | Shapes processed top-to-bottom, then left-to-right |
| Recursively process grouped shapes | Grouped shapes recursively flattened |
| Slides separated by `---` | `enable_slides` option |
| Bold / italic / links preserved | Converted to Markdown syntax |

Writing this a second time adds maintenance cost and defect surface for no gain.

## A1.2 Authorized dependency

```text
Package:   pptx2md
Source:    https://github.com/ssine/pptx2md
License:   Apache-2.0
Language:  Python (99.7%)
Requires:  Python >= 3.10   (container is python:3.12-slim — compatible)
Install:   pip install pptx2md
```

Apache-2.0 is permissive and satisfies the Section 1 constraint on AGPL runtime dependencies. It is not an AI dependency; it downloads no model weights and makes no network calls.

Pin the exact version that resolves at install time in `requirements.txt`. Do not use a floating specifier. Record the resolved version in `THIRD_PARTY_NOTICES.md` per A7.

## A1.3 Required invocation

Use the programmatic API, not the CLI:

```python
from pathlib import Path
from pptx2md import ConversionConfig, convert

convert(
    ConversionConfig(
        pptx_path=source_path,
        output_path=workspace / "output" / "output.md",
        image_dir=workspace / "output" / "media",
        enable_slides=True,
        disable_notes=True,
        disable_color=True,
        disable_wmf=True,
        try_multi_column=False,
    )
)
```

Each non-default flag is mandatory and has a reason. Do not drop any of them:

- **`enable_slides=True`** — emits the `---` slide delimiter Section 34 requires. Off by default.
- **`disable_notes=True`** — presenter notes are included by default. Section 34 does not list speaker notes as extractable content, and notes routinely contain internal commentary the uploader does not expect to appear in a shared output. Excluding them is the safe default. If notes are later wanted, add `PPTX_INCLUDE_NOTES` as an opt-in env var; do not silently include them.
- **`disable_color=True`** — colour handling emits raw HTML colour tags and converts dark theme colours to bold. Raw HTML conflicts with the clean GFM requirement in Section 37.
- **`disable_wmf=True`** — WMF conversion raises exceptions on Linux without the optional `wand` dependency. Do not install `wand`; leave WMF images untouched and emit a warning instead (A1.5).
- **`try_multi_column=False`** — documented by the library as very slow. It must stay off by default given the Section 26 conversion deadline. Expose as `PPTX_TRY_MULTI_COLUMN` (default `false`) so it can be enabled per-deployment after benchmarking.

`min_block_size` keeps its library default. Expose as `PPTX_MIN_BLOCK_SIZE` for tuning.

## A1.4 Required normalization layer

`pptx2md` output does not match the Section 34 and Section 37 output contract in two respects. Add a normalization module:

```text
converter/pptx/normalize.py
```

**Heading levels.** By default every PPTX title becomes a level-1 Markdown heading. Section 34 requires:

```markdown
## Slide 1 — Title
```

or, where the slide has no title:

```markdown
## Slide 1
```

The library emits no slide numbers. The normalizer must rewrite headings to the Section 34 form, deriving the slide index from the `---` delimiters, and must demote any nested headings accordingly so the document keeps a valid heading hierarchy. Do not use the library's custom title-file feature (`title_path`) for this — it depends on a predefined title list and fuzzy matching, which is unsuitable for arbitrary user uploads.

**Media filenames.** The library names extracted images by its own scheme. Section 34 requires:

```text
media/slide-001-image-001.png
media/slide-001-image-002.jpeg
```

The normalizer must rename files in `output/media/` to the Section 34 convention, preserving the original file extension, and rewrite every corresponding Markdown link. After normalization, assert that no Markdown image link resolves to a missing file and no file in `media/` is unreferenced — either condition is a `CONVERSION_FAILED`.

Normalization runs on the Markdown file inside the job workspace, before the Section 38 output package is assembled and before ZIP creation. It writes nothing outside the workspace.

## A1.5 Required warning layer

`pptx2md` does not expose a structured list of unsupported objects. Section 34 requires warnings rather than a crashed job, and Section 39 requires a populated `warnings` array.

Retain `python-pptx` as a direct dependency and run a **pre-scan pass** over the presentation before conversion. It is already a transitive dependency of `pptx2md`, so this adds no new install.

The pre-scan walks all shapes on all slides, recursing into groups, and emits one warning per distinct unsupported object class per slide:

```text
CHART                  -> "Slide 4 contains a chart. Chart data is not converted."
GRAPHIC_FRAME/SmartArt -> "Slide 7 contains SmartArt. SmartArt is not converted."
MEDIA (audio/video)    -> "Slide 9 contains embedded media. Media is not converted."
OLE_OBJECT             -> "Slide 2 contains an embedded object. It is not converted."
LINE/connector         -> "Slide 5 contains connectors or diagram lines. Spatial relationships may be lost."
WMF image              -> "Slide 3 contains a WMF image. It was left unconverted."
```

Warning text must never contain document text, shape text, or absolute paths — Sections 39 and 47 apply unchanged.

The pre-scan also supplies `pages_or_slides` for the conversion report, from the slide count. `media_count` is taken from the file count in `output/media/` after normalization.

Never let the pre-scan fail the job. If the pre-scan itself raises, log the error code only, append a single generic warning, and continue to conversion.

## A1.6 Timeout handling — mandatory

This is the one real regression introduced by the swap and it must be handled explicitly.

Section 26 requires the Pandoc subprocess to have its own timeout. A subprocess can be killed. `pptx2md` runs **in-process**, so a pathological PPTX can block the worker past the 690-second internal deadline with no clean way to interrupt it.

Requirement: run the PPTX conversion in a **child process** with a hard wall-clock timeout, and terminate it on expiry.

```text
PPTX_CONVERSION_TIMEOUT_SECONDS=600
```

On timeout: kill the child, delete the partial workspace output, and return the existing error code:

```text
CONVERSION_TIMEOUT
```

Do not add a new error code. Section 46 stands as written.

The child process must inherit the Section 21 workspace path and write nowhere else. The Section 27 semaphore (`MAX_LOCAL_CONCURRENT_CONVERSIONS=2`) governs total concurrent conversions including these child processes — do not let the child process pool multiply the concurrency ceiling.

## A1.7 Retaining existing work

If `PptxConverter` has already been implemented against raw `python-pptx` under Phase 1, **keep it**. Do not delete completed, tested code mid-build.

```text
PPTX_ENGINE=pptx2md     # default
PPTX_ENGINE=native      # retained fallback
```

Register the existing implementation as `PptxNativeConverter` behind this env var. Both engines must satisfy the same `ConversionResult` dataclass from Section 32 and the same Section 56 assertions. The fallback is an operational escape hatch, not a maintained feature — do not extend it with new capability.

If `PptxConverter` has **not** yet been written, skip this section. Do not write it in order to have a fallback.

---

# A2. PDF — add table extraction (Section 35)

## A2.1 Rationale

Section 35 mandates `pypdf`. Section 71 already concedes that multi-column reading order and complex tables will not survive. `pypdf` provides a text layer and embedded image extraction and no layout analysis whatsoever. Tables in a source PDF currently arrive as unstructured runs of text with no indication that a table was ever there — which for market-research and report PDFs is the most damaging single failure mode.

## A2.2 Authorized dependency

```text
Package:   pdfplumber
License:   MIT
Purpose:   table detection and extraction only
```

`pypdf` is retained. Division of responsibility:

```text
pypdf       -> page count, per-page text extraction, embedded image extraction
pdfplumber  -> table detection and extraction, emitted as GitHub-style Markdown tables
```

`pdfplumber` is built on `pdfminer.six`. Both are permissive and satisfy the Section 1 AGPL constraint. No model weights, no network calls.

## A2.3 Resource guards — mandatory

`pdfplumber` opens its own representation of the document and is materially slower and heavier than `pypdf`. On a document approaching the 100 MB ceiling this is a direct threat to Sections 22, 23 and 26. Table extraction is therefore **budgeted, not unconditional**:

```text
PDF_TABLE_EXTRACTION=true
PDF_TABLE_MAX_PAGES=300
PDF_TABLE_PAGE_TIMEOUT_SECONDS=5
```

Rules:

- If the page count exceeds `PDF_TABLE_MAX_PAGES`, skip table extraction for the whole document and emit one warning: `"Table extraction was skipped because the document exceeds the page budget."`
- If a single page exceeds `PDF_TABLE_PAGE_TIMEOUT_SECONDS`, skip that page's tables, emit a warning naming the page number, and continue.
- If table extraction raises on a page, emit a warning and continue. Never fail the job for a table.
- Table extraction must respect the same global Section 26 deadline. If the remaining deadline budget drops below a safe reserve, abandon table extraction for the remaining pages and emit one warning.

Text and image extraction via `pypdf` are never skipped. Tables are the degradable feature.

## A2.4 Unchanged

Section 35's page heading format, `---` page separators, image naming, per-image failure tolerance, and the prohibition on rewriting or summarizing text all stand. Section 36 scanned-PDF heuristic and warning behaviour stands. OCR remains out of scope for v1.

Interleave extracted tables at their detected position within the page's content where the library gives usable positional data; where it does not, append tables after the page text under the existing page heading. Do not invent a new heading level for tables.

---

# A3. Docling — evaluated, deferred

**Decision: do not adopt in v1. Do not install.**

Docling (`docling-project/docling`, MIT, hosted under the LF AI & Data Foundation) is the strongest available quality upgrade for PDF, and `docling-serve` ships as a FastAPI container that maps onto the Section 6 converter box almost exactly. Its licence is compatible and it runs fully locally, so the Section 45 privacy requirements are satisfiable.

It is deferred on resource grounds, not licence or quality grounds:

- It downloads and runs layout vision models. Model weights inflate the container image and, if fetched at runtime, consume scratch space that Section 22 has already budgeted to 425 MB total.
- CPU-only layout inference on a document near the 100 MB ceiling is a credible breach of the 690-second internal deadline in Section 26. Vercel Fluid Compute is not a GPU runtime.
- Cold-start cost is incompatible with the Section 2 expectation that a non-technical user clicks convert and watches a progress state.

Adopting it would require reopening Sections 22, 26 and 48 simultaneously. That is a different project shape, not an amendment.

**Revisit triggers.** Re-evaluate Docling as an opt-in second PDF engine (`PDF_ENGINE=docling`) if any of these becomes true:

1. PDF output quality is the dominant complaint after real usage.
2. A GPU-capable or longer-running compute target becomes available and approved.
3. Scanned-PDF OCR moves into scope, superseding the Section 36 heuristic.

Any such evaluation must be benchmarked against the Section 57 near-100 MB fixture before adoption, and must be gated behind an env var with `pypdf` + `pdfplumber` remaining the default.

---

# A4. Marker — rejected

**Decision: prohibited. Add to the Section 1 hard constraints.**

`datalab-to/marker` produces the best Markdown of the options surveyed for complex PDFs. It cannot be used here.

```text
Code license:    GPL-3.0
Model weights:   modified AI Pubs Open RAIL-M
Free tier:       research, personal use, and organizations under
                 ~$2-5M revenue / funding, depending on the version's terms
Commercial use:  paid dual license required above that threshold
```

The organization is well past any of the published waiver thresholds, and the weights licence restricts commercial use independently of the code licence. Section 51 requires licence confirmation through the appropriate organizational process before production use; Marker would not clear it, and a GPL-3.0 runtime dependency plus a non-commercial weights licence is precisely the class of exposure Section 51 exists to prevent.

It also requires PyTorch and GPU-class compute to perform, which fails A3's constraints as well.

Do not install `marker-pdf`. Do not vendor it. Do not call a hosted Marker or Datalab API — that would additionally breach the zero-external-service posture in Sections 1 and 45.

---

# A5. MarkItDown — rejected

**Decision: prohibited. Add to the Section 1 hard constraints.**

`microsoft/markitdown` is MIT-licensed and lightweight, so it clears the licence and resource bars. It fails on the output contract, which is not fixable by configuration:

- It returns a single text string. It does not write extracted images to disk as files. Saving embedded images as separate files with relative Markdown links is an open upstream feature request, not shipped behaviour. Sections 34, 35, 37 and 38 all require a populated `media/` directory with relative forward-slash links — the entire output package depends on it.
- Its default PDF backend is `pdfminer.six` / `pdfplumber` for text only, which is no better than the amended A2 pipeline for our purposes.
- Its DOCX path routes through `mammoth` to HTML and then to Markdown, discarding media, which is strictly worse than Pandoc `--extract-media` (see A6).
- Its image-description and higher-quality document paths depend on an LLM client or Azure Document Intelligence. Both breach the zero-AI and zero-external-service constraints in Section 1.

Do not install `markitdown` or any `markitdown-*` plugin.

---

# A6. DOCX — confirmed unchanged (Section 33)

No change. Section 33 stands in full.

Recorded here so it is not reopened: Pandoc with `--extract-media` is the correct choice and is better than every library alternative surveyed, specifically because it writes media out as files. The library-based DOCX converters discard embedded images or inline them as base64, both of which break the Section 38 output package.

Keep the argument-array invocation. Keep `shell=True` prohibited. Keep the Pandoc subprocess timeout required by Section 26. Keep the Section 33 limitations list as written.

See A7.2 for the licence note Pandoc requires.

---

# A7. Licensing and dependency records (Sections 49, 51)

## A7.1 Amended dependency list

Section 49 minimum becomes:

```text
fastapi
uvicorn
httpx
python-multipart
python-pptx        # retained: slide inventory + unsupported-object pre-scan
pptx2md            # NEW: PPTX conversion engine          (Apache-2.0)
pypdf              # retained: PDF text, images, page count
pdfplumber         # NEW: PDF table extraction            (MIT)
```

Testing dependencies unchanged (`pytest`, `pytest-asyncio`).

Explicitly prohibited, extending Section 1:

```text
PyMuPDF / PyMuPDF4LLM     (AGPL)
marker-pdf                (GPL-3.0 code + restricted weights)
markitdown / markitdown-* (output contract incompatible; LLM-dependent paths)
docling / docling-serve   (deferred, not prohibited — see A3)
wand                      (not needed; WMF is left unconverted)
torch                     (no model inference in v1)
```

Pin every version. Do not add transitive convenience packages.

## A7.2 Pandoc licence note — required entry

Pandoc is **GPL-2.0-or-later**. Section 1 prohibits AGPL runtime dependencies, not GPL, and Pandoc is invoked as a separate binary via subprocess rather than linked into the application, which is the conventional basis for treating it as a system tool rather than a derived-work dependency.

This reasoning must be written down, not left for a reviewer to reconstruct. Add an explicit entry to `THIRD_PARTY_NOTICES.md` recording: the licence, the fact that invocation is by subprocess and not by linking, and that no Pandoc source or object code is incorporated into the application. Flag it for the Section 51 organizational licensing confirmation rather than assuming it passes.

## A7.3 `THIRD_PARTY_NOTICES.md`

Section 51 already requires dependency, purpose, version, licence, source. Add two columns:

```text
| Dependency | Purpose | Version | License | Source | Invocation | Notes |
```

`Invocation` records `library` or `subprocess`. `Notes` carries the A7.2 reasoning and any waiver-threshold or weights-licence facts for anything evaluated and rejected. Record the A4 and A5 rejections in a separate **Evaluated and rejected** table with the reason — this is the artifact that answers the licensing review question before it is asked.

---

# A8. Test additions (Sections 55, 56)

## A8.1 New fixtures

Add to the Section 55 PPTX set:

```text
smartart.pptx           unsupported-object warning, job still succeeds
charts.pptx             unsupported-object warning, job still succeeds
speaker-notes.pptx      notes must NOT appear in output
merged-cells.pptx       merged-cell table renders as valid GFM table
multi-column.pptx       reading order, try_multi_column off
coloured-text.pptx      no raw HTML colour tags in output
wmf-image.pptx          no exception, warning emitted
```

Add to the Section 55 PDF set:

```text
tables.pdf              tables render as GFM tables
two-column.pdf          documents current reading-order limitation
many-pages.pdf          exceeds PDF_TABLE_MAX_PAGES, skip warning emitted
```

## A8.2 New assertions

Extend Section 56. For every format, in addition to the existing assertions:

- No raw HTML tags in the Markdown output except where the output contract explicitly permits them.
- Every Markdown image link resolves to a file present in `media/`.
- Every file in `media/` is referenced by at least one Markdown link.
- Media filenames match the Section 34 / Section 35 naming convention exactly.

PPTX-specific:

- Every slide heading matches `## Slide N` or `## Slide N — <title>`.
- Slide numbering is contiguous and starts at 1.
- No speaker-notes content appears in the output.
- A fixture containing SmartArt or a chart produces `conversion_status: "success"` with a non-empty `warnings` array.

PDF-specific:

- A table fixture produces at least one valid GFM table.
- Skipping table extraction never changes `conversion_status` from `success`.

Timeout-specific:

- A synthetic PPTX conversion that exceeds `PPTX_CONVERSION_TIMEOUT_SECONDS` returns `CONVERSION_TIMEOUT`, leaves no workspace residue, and does not leak the child process.

## A8.3 Re-run requirement

The Section 57 near-100 MB release test must be re-run after this amendment lands, for **PPTX and PDF specifically**. The new engines change memory and duration behaviour on large inputs. A pass recorded before this amendment does not carry over.

---

# A9. Amended acceptance criteria (Section 64)

Add to the **Conversion** block:

```text
- [ ] PPTX converted via pptx2md with normalization applied.
- [ ] Slide headings match the Section 34 format.
- [ ] Media filenames match the Section 34/35 convention.
- [ ] Speaker notes excluded by default.
- [ ] Unsupported PPTX objects produce warnings, not failures.
- [ ] PDF tables render as Markdown tables.
- [ ] Table extraction degrades gracefully under budget limits.
```

Add to the **Resource safety** block:

```text
- [ ] PPTX conversion runs in a killable child process with its own timeout.
- [ ] Child processes counted against the concurrency semaphore.
```

Add to the **Zero AI** block — unchanged in substance, restated because new dependencies were added:

```text
- [ ] No new dependency downloads model weights.
- [ ] No new dependency makes outbound network calls during conversion.
```

---

# A10. Amended known limitations (Section 71)

Replace the PPTX and PDF entries with:

PPTX may not preserve:

- charts and their underlying data;
- SmartArt and diagrams;
- connectors and spatial relationships;
- animations and transitions;
- embedded audio, video, and OLE objects;
- WMF images (left unconverted by design);
- multi-column slide layouts, unless `PPTX_TRY_MULTI_COLUMN` is enabled.

Speaker notes are excluded by default and are not a conversion failure.

PDF may not preserve:

- multi-column reading order;
- table structure on pages where detection fails, or where the page or document table budget is exceeded;
- scanned text (no OCR in v1);
- text inside charts and vector diagrams.

Table extraction is a best-effort, degradable feature. Its absence from an output is not a failed conversion.

---

# A11. Deviation reporting

Section 69's phase report format gains one required heading:

```text
## Deviations from ENGINEERING_SPEC.md
## Deviations from ENGINEERING_SPEC_AMENDMENT_01.md
```

If any A1–A2 requirement proves unworkable in practice — in particular the A1.4 normalization or the A1.6 child-process timeout — do not silently fall back to a hand-rolled converter. Report it, state what was attempted, and stop for a decision.

---

# A12. Definition of done for this amendment

```text
- [ ] Section 1 hard constraints updated per A7.1.
- [ ] pptx2md integrated with all A1.3 flags set.
- [ ] Normalization layer implemented and asserted (A1.4).
- [ ] Warning pre-scan implemented (A1.5).
- [ ] Child-process timeout implemented and tested (A1.6).
- [ ] pdfplumber table extraction implemented with A2.3 budgets.
- [ ] No prohibited dependency present in requirements.txt or the lockfile.
- [ ] THIRD_PARTY_NOTICES.md updated, including the Pandoc entry and the rejected-dependency table.
- [ ] A8 fixtures and assertions added and passing.
- [ ] Section 57 near-100 MB test re-run for PPTX and PDF.
- [ ] Acceptance criteria in A9 met.
- [ ] AI token usage still exactly zero.
```
