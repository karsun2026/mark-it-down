# Third-Party Notices

Per ENGINEERING_SPEC.md §51 and Amendment A7.3.

No AGPL runtime dependencies. No AI SDKs. No dependency downloads model
weights, and none makes an outbound network call during conversion.

`Invocation` records how the dependency is used: `library` (imported into this
process) or `subprocess` (executed as a separate program). The distinction
matters for licence analysis, so it is recorded rather than inferred.

**Confirm licensing through the appropriate organisational process before
internal production use.** The Pandoc entry in particular is flagged for that
review rather than assumed to pass.

## Runtime — Python

| Dependency | Purpose | Version | License | Source | Invocation | Notes |
|---|---|---|---|---|---|---|
| fastapi | HTTP service | 0.141.1 | MIT | PyPI | library | — |
| uvicorn | ASGI server | 0.52.4 | BSD-3-Clause | PyPI | library | — |
| httpx | Streaming Blob transfer | 0.28.1 | BSD-3-Clause | PyPI | library | — |
| pydantic | Request/response models | 2.13.5 | MIT | PyPI | library | — |
| python-pptx | PPTX parsing (§34) | 1.0.2 | MIT | PyPI | library | — |
| pypdf | PDF structure, encryption, image XObjects (§35) | 6.16.2 | BSD-3-Clause | PyPI | library | `[crypto]` extra pulls `cryptography` |
| pdfplumber | PDF text layout and table extraction | 0.11.10 | MIT | PyPI | library | DEVIATIONS D-003; Amendment A2 |
| pdfminer.six | PDF text engine | via pdfplumber | MIT | PyPI | library | transitive |
| Pillow | Image decoding for pypdf extraction | 12.3.0 | MIT-CMU | PyPI | library | — |
| cryptography | Encrypted-PDF detection | via pypdf[crypto] | Apache-2.0 OR BSD-3-Clause | PyPI | library | transitive |

## Runtime — system

| Dependency | Purpose | Version | License | Source | Invocation | Notes |
|---|---|---|---|---|---|---|
| Pandoc | DOCX conversion (§33) | container package | **GPL-2.0-or-later** | Debian package in `Dockerfile.vercel` | **subprocess** | See below — flagged for §51 review |

### Pandoc licence note (required by Amendment A7.2)

Pandoc is **GPL-2.0-or-later**. §1 prohibits **AGPL** runtime dependencies, not
GPL.

Pandoc is invoked as a **separate binary via subprocess**, using an argument
array, and is **not linked into this application**. **No Pandoc source or
object code is incorporated** into our codebase or our deployment artifact
beyond the unmodified upstream Debian package installed in the container image.
This is the conventional basis for treating it as a system tool rather than as
a derived-work dependency.

This reasoning is recorded here rather than left for a reviewer to
reconstruct. **It is flagged for the §51 organisational licensing
confirmation and is not assumed to pass.** If the no-AGPL rule originates in a
corporate policy that also restricts GPL, this entry is the one to escalate.

## Evaluated and rejected

Recorded per Amendment A7.3 so the licensing review question is answered before
it is asked.

| Dependency | Evaluated for | License / terms | Decision | Reason |
|---|---|---|---|---|
| PyMuPDF / PyMuPDF4LLM | PDF conversion | **AGPL-3.0** | **Prohibited** | Excluded outright by §35 and §51 |
| marker-pdf | PDF conversion | **GPL-3.0** code + **modified AI Pubs Open RAIL-M** weights | **Prohibited** (A4) | Weights licence restricts commercial use independently of the code licence; the organisation is past the published waiver thresholds. Also requires PyTorch and GPU-class compute |
| markitdown (+ plugins) | All formats | MIT | **Prohibited** (A5) | Licence is fine; output contract is not. Returns a single string and does not write extracted images to disk, which §34/§35/§37/§38 all require. Higher-quality paths depend on an LLM client or Azure Document Intelligence, breaching the zero-AI and zero-external-service constraints |
| docling / docling-serve | PDF conversion | MIT | **Deferred, not prohibited** (A3) | Best available quality upgrade and licence-compatible, but downloads and runs layout vision models. Container inflation and CPU-only inference conflict with the §22 scratch budget and the §26 deadline. Revisit triggers recorded in A3 |
| pptx2md | PPTX conversion | Apache-2.0 (repo `LICENSE`) — **but PyPI metadata declares "MIT Licence"** | **Declined** (DEVIATIONS D-006) | Owner decision: the existing tested converter is retained. Independently, it requires `scipy` (116 MB) and `numpy` (35 MB) — imported only by `multi_column.py`, the feature A1.3 mandates disabling, via a top-level import that cannot be avoided. **The licence metadata discrepancy must be resolved before any future adoption** |
| wand | WMF image conversion | MIT | **Prohibited** (A7.1) | Not needed. WMF/EMF images are left unconverted by design, with a warning |
| torch | Model inference | BSD-3-Clause | **Prohibited** (A7.1) | No model inference in v1 |

## Development only — never imported by runtime code

| Dependency | Purpose | Version | License | Source | Invocation | Notes |
|---|---|---|---|---|---|---|
| pytest | Test runner | 9.1.1 | MIT | PyPI | library | — |
| pytest-asyncio | Async test support | 1.3.0 | Apache-2.0 | PyPI | library | — |
| ruff | Lint | 0.15.4 | MIT | PyPI | library | — |
| python-docx | DOCX fixture generation | 1.2.0 | MIT | PyPI | library | test fixtures only |
| fpdf2 | PDF fixture generation | 2.8.8 | **LGPL-3.0** | PyPI | library | **Test fixtures only. Not shipped in the container** (`.dockerignore` excludes dev requirements) |
| psutil | Memory sampling in the §57 release-test harness | 7.2.2 | BSD-3-Clause | PyPI | library | Release test only. Not shipped in the container |

## Frontend

| Dependency | Purpose | Version | License | Source | Invocation | Notes |
|---|---|---|---|---|---|---|
| next | Web framework | 15.5.25 | MIT | npm | library | — |
| react / react-dom | UI | 19.x | MIT | npm | library | — |
| @vercel/blob | Private Blob client and signed URLs | 2.8.0 | Apache-2.0 | npm | library | — |
| typescript, vitest | Build and test | — | Apache-2.0 / MIT | npm | library | dev only |
