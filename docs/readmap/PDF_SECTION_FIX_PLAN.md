# READMAP PDF fix — implementation plan (Option A)

_Status: draft for review. Branch `feature/readmap-mvp`. Written 2026-09-17._

This plan is written to be reviewed by another model or engineer before
implementation. Each part has a plain-language line first, then the technical
detail.

---

## Problem being solved

READMAP fails on any PDF that has visible sections. PDFs convert to `## Page N`
+ plain text; real headings ("Executive Summary") become ordinary body text, not
markdown headings. In `lib/readmap/ingestion/segment.ts`, a `## Page N` anchor is
recorded as a *page number* and the section path is reset to empty — so every PDF
block ends up with `sectionPath: []`.

The mapper agent (the AI) returns the document's real section names. The safety
check `validateMapSections` compares them to the union of block `sectionPath`s —
which is empty for a PDF — decides the sections are invented, and aborts the run
at the MAPPING stage with `AgentContractError: mapper output section
"<name>" does not exist in the supplied evidence`.

### Evidence (from a live diagnostic run)

```
mapper raw sectionPaths: [["Executive Summary"],["Market Overview"], …]  ← model returned the real sections
known parts: []                                                          ← blocks carry NO section path
still-invalid after resolve: [all of them]
```

The section-path machinery (validation, `recommendationFor`, grounding gate) is
effectively DOCX-oriented: DOCX keeps Pandoc headings, so its blocks have real
`sectionPath`s. PDFs have only page numbers (`block.pageNumber`), which never
enter `sectionPath`.

---

## The fix — two parts

### Part 1 — Give PDF/PPTX blocks a real section anchor (the core change)

**Plain version:** treat each page as a section, so there's something honest to
check the AI's output against.

- File: `lib/readmap/ingestion/segment.ts`
- Today, on a `## Page N` line (`PAGE_ANCHOR`), the code sets `pageNumber` and
  does `headingStack = []`, then emits a `Page N` heading block. `Page N` is
  never pushed onto the heading stack, so subsequent blocks get `sectionPath: []`.
- Change: seed the heading stack with a base entry
  `{ level: 0, text: "Page N" }` so every block on that page gets
  `sectionPath: ["Page N"]`. A real sub-heading (rare in PDFs) nests as
  `["Page N", "Heading"]` because the pop-condition only removes entries with
  `level >= incoming level`, and the base entry is `level: 0`.
- Do the same for PPTX slides (`SLIDE_ANCHOR`): base entry `"Slide N"` or
  `"Slide N — Title"`.
- DOCX is untouched (no page/slide anchors; it already carries real headings).

### Part 2 — Map the AI's real section names onto those anchors (already drafted)

**Plain version:** let the AI keep using real names, then quietly pin each to the
page it's on.

- File: `lib/readmap/agents/mapper.ts` (`resolveSectionPaths` helper — already
  written).
- After the AI returns sections named by heading, find the block whose
  `normalizedText` contains that heading (case-insensitive substring) and rebind
  the section's `sectionPath` to that block's anchor (now `["Page 1"]`),
  preserving the human name in `purpose`
  (e.g. `"Executive Summary — the headline results"`).
- `validateMapSections` then passes. If the AI ever names a section that appears
  **nowhere** in the text, it still fails loudly — the anti-fabrication guarantee
  is preserved.
- **Correctness fix needed in the drafted helper:** only count a match as
  resolved when the block's anchor is non-empty (guard against `[]`, which was
  the bug that made the first resolution attempt silently fall back to the
  invalid original path). With Part 1 in place the anchor is `["Page N"]`, so
  this guard mostly matters for safety.
- The mapper prompt was bumped to `mapper.v2` (ask for the document's own
  headings; do not invent structure).

---

## Downstream — expected to work automatically (verify, don't assume)

- `recommendationFor(["Page 1"], blocks, …)` now matches page-1 blocks (their
  `sectionPath` includes `"Page 1"`) → returns a real page range → the read/skip
  guide shows "Read page 1."
- Grounding gate `checkRecommendationTargets` sees page-anchored recommendations
  with valid page ranges → passes.
- `documentShape` lists page-anchored sections with their semantic `purpose`.

---

## Tests

- `lib/readmap/ingestion/segment.test.ts`:
  - Plain page blocks become `["Page N"]` (add an explicit assertion).
  - "carries section paths from headings" becomes `["Page N", "Risks"]`.
  - PPTX slide case similar (`["Slide N — Title", …]`).
  - DOCX unchanged.
- `lib/readmap/agents/mapper.test.ts`:
  - Keep "rebinds a prose heading to its page anchor."
  - Keep "fails when the section appears nowhere in the text."
- Run `npm test` (full suite) + `npm run typecheck` + `npm run lint`, all green.
- Then the **live PDF end-to-end** and confirm the five acceptance checks:
  1. status polling stays live (never looks "stuck"),
  2. the first AI call does not error,
  3. analysis finishes inside the time ceiling,
  4. the result renders the reading guide (coverage line, read/skip, remember-these, evidence drawer),
  5. the depth slider works with no network calls.

---

## Risks for the reviewer to scrutinise

1. **Blast radius:** every PDF/PPTX block's section path gains a `Page N` /
   `Slide N` prefix. Consumers of `sectionPath`: `signal-extractor.ts`,
   `skeptic.ts`, `grounding-gate.ts`, `pipeline.ts`
   (`recommendationFor`, `documentShape`). Confirm none break on the new prefix.
2. **Heading matching** in resolution is a case-insensitive substring search — a
   short heading name that also appears in body text elsewhere could match the
   wrong page (it takes the first hit). Acceptable for page-level anchoring, but
   worth noting.
3. **Duplicate sections on one page** both resolve to the same `Page N` —
   consider de-duplicating the reading guide.
4. **Prompt version bump (v1 → v2)** changes the mapper's checkpoint key, so a
   retried run re-bills the mapper once. Intended.
5. Confirm nothing else pins the old prompt version `mapper.v1`.

---

## Current state of the branch

On `feature/readmap-mvp`, uncommitted work-in-progress:

- Part 2 (mapper resolution + prompt v2 + mapper tests) is drafted and green in
  unit tests.
- **Part 1 (segment.ts) is not done yet — it is the missing piece.**
- Already committed and pushed earlier: ESLint setup + fixes, and a converter
  env-quote bug fix in `run-converter-local.ps1` (the local converter and the
  app were signing/verifying job tokens with a mismatched secret because the
  launcher didn't strip the quotes around `JOB_SIGNING_SECRET` the way Next's
  dotenv does).
- Temporary debug logging has been removed.

---

## Alternatives that were considered and rejected

- **Force the AI to label sections by page number** ("Page 1" instead of
  "Executive Summary"): the model refuses even when handed the explicit list —
  it insists on the real names, which is the sensible behaviour. Verified failing
  twice in live runs.
- **Swap the converter** (e.g. AnyDoc2MD / Microsoft `markitdown`): its PDF path
  is also plain-text extraction with no semantic headings, so it wouldn't help;
  and it's a desktop GUI, not a drop-in for the deployed FastAPI converter.
- **ML layout converter** (Docling / Marker / unstructured): would genuinely
  recover headings, but it's a large, heavy change to a serverless container —
  Phase 2+ territory, overkill for this fix.
