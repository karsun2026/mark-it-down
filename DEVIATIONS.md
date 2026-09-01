# Deviations from ENGINEERING_SPEC.md

`ENGINEERING_SPEC.md` §1 requires that architectural departures be verified against
current official documentation, preserve the spec's intent, and be documented.
This file is that record. Three deviations were reviewed and approved before Phase 1.

---

## D-001 — Workspace budget vs. concurrency

**Spec:** §22 `MAX_TMP_WORKSPACE_MB=425`; §27 `MAX_LOCAL_CONCURRENT_CONVERSIONS=2`.

**Problem:** These multiply. Two concurrent jobs at a 425 MB budget need 850 MB against an
assumed ~500 MB `/tmp`. Vercel Fluid compute deliberately runs concurrent invocations
*inside one instance*, so both jobs share a single `/tmp`. Two near-limit files arriving
together exhaust the disk — precisely the failure §23 forbids.

Separately, `/tmp` capacity is **not documented** on Vercel's current Functions limits page.
The ~500 MB figure in §4 is inherited AWS Lambda folklore and is treated here as unverified.

**Resolution:**
- `MAX_LOCAL_CONCURRENT_CONVERSIONS=1` by default.
- The workspace budget is enforced as a **global** ceiling across all in-flight jobs on the
  instance, not a per-job one, so raising concurrency can never oversubscribe the disk.
- `converter/app/services/workspace.py` probes actual free space at startup and logs it, so
  the real ceiling is measured rather than assumed.

**Intent preserved:** the job still fails cleanly with `DOCUMENT_EXPANDS_TOO_LARGE` rather
than dying on a full disk.

---

## D-002 — Recoverable conversion status

**Spec:** §17 the browser POSTs to `/converter/v1/convert` and awaits the result;
§26 allows up to 720 s; §52 shows an indeterminate spinner.

**Problem:** This asks a browser to hold one HTTP request open for up to twelve minutes.
Mobile network handoffs, corporate proxies, and background-tab throttling all break that
connection well inside the window. The spec defines no idempotency key, so a client retry
re-runs the entire conversion and double-bills the compute.

**Resolution:** The converter writes a small `jobs/<date>/<job-id>/status.json` to Private
Blob as it passes each stage. The browser still issues the same POST, but a dropped
connection degrades to polling that status object instead of failing the job. The POST
carries an idempotency key derived from the job token, so a retry attaches to the running
job rather than starting a second one.

**Intent preserved:** no queue, no Redis, no new infrastructure (§27). Status objects obey
the same retention and privacy rules as every other job artifact, and contain no document
content.

---

## D-003 — PDF text and table extraction

**Spec:** §35 use `pypdf`; do not use PyMuPDF/PyMuPDF4LLM.

**Problem:** `pypdf` has no table extraction and no multi-column reading-order handling.
For the document classes this app targets — market studies, methodology decks — tables
carry much of the meaning, and losing them undermines §73's "usable Markdown".

**Resolution:** Add **pdfplumber** (MIT, built on pdfminer.six, MIT) for text layout and
table extraction. `pypdf` is retained for document structure, encryption detection, page
count, and image XObject extraction.

**Intent preserved:** PyMuPDF and PyMuPDF4LLM remain excluded. Both added libraries are
permissively licensed, so §51's no-AGPL rule still holds. No AI is involved; extraction
stays fully deterministic.
