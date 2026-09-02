# §57 Near-Limit Release Test

ENGINEERING_SPEC.md §57 states: **"The feature is not production-ready until
this passes."** §70 repeats it as a release blocker. Amendment A8.3 requires it
to be re-run for PPTX and PDF after Amendment 01, because the child-process
change alters memory and duration behaviour on large inputs.

The test is in two halves because four of §57's eight checks are properties of
the converter and four are properties of the deployed data path.

| §57 check | Covered by | Status |
|---|---|---|
| 1. browser direct upload succeeds | `release_test_e2e.py` | ✅ passing |
| 2. binary never passes through a Function body | `release_test_e2e.py` | ✅ passing |
| 3. converter streams source | `release_test_local.py` | ✅ passing |
| 4. memory remains bounded | `release_test_local.py` | ✅ passing |
| 5. `/tmp` remains below guard | `release_test_local.py` | ✅ passing |
| 6. result uploads directly to Blob | `release_test_e2e.py` | ✅ passing |
| 7. converter response is small JSON | both | ✅ passing |
| 8. result downloads via signed Blob URL | `release_test_e2e.py` | ✅ passing |

**All eight §57 checks pass**, locally and against a live deployment, for
PPTX and PDF (the two A8.3 names specifically).

---

## 1. Generate the fixtures

Not committed — they are ~97 MB each and gitignored.

```bash
cd converter && ./.venv/Scripts/python.exe scripts/make_large_fixtures.py --mb 97
```

Every embedded image is **unique random noise**, deliberately:

- Identical images would be collapsed by the content-addressed de-duplication
  in `MediaWriter`, so a deck built from one repeated image would produce a
  tiny output tree and prove nothing about behaviour at the ceiling.
- Noise is incompressible, so the archive's compression ratio stays near 1 and
  the file does not trip the §30 ZIP-bomb guard, which tests a different
  failure mode.

Takes about 40 seconds for all three formats.

## 2. Run the local half

```bash
cd converter && ./.venv/Scripts/python.exe scripts/release_test_local.py --format all
```

The source is served over a local HTTP server and pulled through the real
`transfer.download_source`; the result is pushed through the real
`transfer.upload_result` to a sink that discards the body. Memory is sampled
across the whole process tree, including the A1.6 child, and reported **per
phase** — a buffering transfer would add roughly the file size to RSS, a
streaming one adds a few chunks.

Exit code 0 only if every in-scope check passes, so CI can gate on it.

## 3. Run the deployed half

```bash
MARKITDOWN_BASE_URL=https://your-deployment.vercel.app \
  ./.venv/Scripts/python.exe scripts/release_test_e2e.py --format pptx
```

Requires a deployment with a Blob store and `JOB_SIGNING_SECRET` set. Run it
for **PPTX and PDF at minimum** (A8.3), ideally all three.

§57 check 2 is asserted structurally rather than by inspection: the script
tracks how many bytes crossed the app origin versus Blob hosts, and fails if
any Function payload approaches a control-message size. If a future change
starts proxying document bytes through a Function, this fails.

The upload runs through the real `@vercel/blob/client` `upload()` via
`frontend/scripts/e2e-upload.mjs` — the exact function the browser calls.
Reimplementing the Blob upload protocol in Python would have tested the
reimplementation rather than the app. It proves the **data path**, not the UI.

---

## Recorded results

### Local half — 2026-09-01, Windows 11, Python 3.14.7

Run on a developer machine, not the Vercel container. Absolute memory and
duration will differ in production; the ratios are what carry over.

| Metric | PPTX | PDF | DOCX |
|---|---|---|---|
| Source size | 95.0 MB | 97.0 MB | 97.0 MB |
| Pages / slides | 92 | 94 | n/a¹ |
| Media files | 92 | 94 | 94 |
| Output tree | 94.9 MB | 97.0 MB | 96.9 MB |
| Result ZIP | 94.9 MB | 97.0 MB | 97.0 MB |
| **Peak memory** | **249.8 MB** | **544.9 MB** | **375.4 MB** |
| — added by download | 11.1 MB | 11.7 MB | 11.3 MB |
| — added by convert | 172.4 MB | 467.0 MB | 297.9 MB |
| — added by upload | 2.0 MB | 2.3 MB | 2.4 MB |
| **Peak workspace** | **189.9 MB** | **194.0 MB** | **193.9 MB** |
| Duration | 19.5 s | 30.8 s | 18.5 s |
| **Result** | **PASS** | **PASS** | **PASS** |

¹ DOCX has no page count: Word pagination needs a layout engine we deliberately
do not run. §32 types `pages_or_slides` as optional for exactly this reason.

**What the numbers show.**

- **Streaming is real.** Downloading a 95 MB file added 11 MB to RSS; uploading
  a 95 MB ZIP added 2 MB. A buffering implementation would have added ~95 MB.
- **Memory has generous headroom.** The worst case (PDF, 545 MB) is 13% of the
  4 GB container ceiling in §65.
- **The workspace guard holds with margin.** Peak ~194 MB against the 425 MB
  budget — and that peak is the moment when source and output coexist, which is
  precisely why §22 orders source deletion *before* ZIP creation. Without that
  ordering the peak would be ~290 MB.
- **Duration is not close to the limit.** 31 s worst case against the 690 s
  §26 deadline, so the A1.6 child timeout never fires on a well-formed file.

**PDF is the format to watch.** It costs roughly twice the memory and 1.6× the
time of PPTX, because `pdfplumber` builds its own layout representation per
page. If a memory ceiling is ever approached in production, PDF reaches it
first, and `PDF_TABLE_EXTRACTION=false` is the lever (A2.3 makes tables the
degradable feature).

### Deployed half — 2026-09-02, https://mark-it-down-blue.vercel.app

| Metric | PPTX | PDF |
|---|---|---|
| Source uploaded | 95.0 MB | 97.0 MB |
| Upload time (browser SDK, multipart) | 28.3 s | 30.1 s |
| Converted | 92 slides | 94 pages |
| Result downloaded | 94.9 MB | 97.1 MB |
| **Moved via Blob hosts** | **189.9 MB** | **194.0 MB** |
| **Crossed the app origin** | **5,240 bytes** | **5,236 bytes** |
| Largest Function payload | 3,731 bytes | 3,723 bytes |
| End-to-end | 62.8 s | 64.4 s |
| **Result** | **PASS** | **PASS** |

**This is the number the whole architecture exists to produce:** ~190 MB of
document moved per job, of which **under 4 KB** touched a Vercel Function. The
4.5 MB payload cap is never approached because the bytes never go near it.

Measured on the deployed container at the same time:

- **`/tmp` is 512 MB.** §4 assumed "approximately 500 MB" and Vercel does not
  document it. The startup probe (D-001) now reports it from the running
  container: `total=512MB free=512MB budget=425MB concurrency=1`. The 425 MB
  budget fits with 87 MB spare — and the spec's original 2 × 425 MB pairing
  would have oversubscribed a 512 MB disk by 338 MB.
- **Pandoc is present in the production container** (`/converter/ready`
  reports `pandoc: true`), clearing that §70 blocker.
- **§40 retention behaves as designed.** After each successful conversion the
  source blob is gone and only the result and status remain. The two runs that
  failed still hold their sources, which is correct: they are left for the
  hourly cleanup cron, exactly the crash-recovery path §40 describes.
- **§41 cleanup cron works.** Unauthenticated requests are refused with 401;
  authenticated it scanned 6 blobs and deleted 0, nothing yet being past its
  retention window.

### What the deployed run found

Two real defects that only a live deployment could expose. Both are fixed and
covered by tests.

1. **The presigned-URL binding check rejected every valid result upload.**
   Vercel presigns reads and writes differently: a `get` URL addresses the blob
   directly, so the pathname is the URL path, while a `put` URL goes to the
   Blob API, so the pathname is a **query parameter** and the path is a fixed
   endpoint. The check assumed the read shape and returned
   `JOB_TOKEN_INVALID` for correct URLs. See `pathname_from_signed_url`.

2. **The upload route depended on a key that cannot be set from the CLI.**
   `handleUploadPresigned` throws "Missing webhook public key" *before* it
   checks whether a callback is registered — and we register none. Reverted to
   the flow §12/§13 originally specified (DEVIATIONS D-010).

---

## Also required before release (§70)

- [x] Near-100 MB behaviour measured for all three formats — local half
- [x] **Near-100 MB test passed against a deployment** (PPTX, PDF)
- [x] No large binary crosses a Function body — under 4 KB per job, measured
- [x] Private Blob source/result confirmed live
- [x] Signed download confirmed live
- [x] Workspace guards tested
- [x] Cleanup cron confirmed live (401 unauthenticated, runs authenticated)
- [x] DOCX/PPTX/PDF smoke tests pass
- [x] **Pandoc present in the production container**
- [x] No AI dependency exists
- [x] No AGPL PDF runtime exists
- [x] No document contents appear in logs
- [ ] DOCX near-limit run against the deployment (local passes; e2e not run)
- [ ] Auth (§43) — still `AUTH_MODE=none`, Phase 5
- [ ] Rate limiting (§44) — Phase 5
