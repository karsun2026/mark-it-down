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

---

## D-004 — Presigned client uploads instead of `handleUpload`

**Spec:** §12 "Use the current `@vercel/blob/client` upload mechanism";
§13 issues a client upload token.

**Finding:** Vercel's current SDK offers two client-upload flows. The older one
(`handleUpload` + `upload`) mints a single-use client token that travels as a
bearer credential. The newer presigned flow (`handleUploadPresigned` +
`uploadPresigned`) returns presigned `PUT` URLs instead, so no Vercel-managed
bearer token is in flight at all, and the size and content-type constraints are
enforced at the CDN rather than only at token-issue time.

**Resolution:** Use the presigned flow. It satisfies §12's "current mechanism"
instruction, and better matches §13's requirement to restrict content type and
maximum size in the token itself.

Requires `BLOB_WEBHOOK_PUBLIC_KEY` in the project environment so the
upload-completed callback signature can be verified.

**Intent preserved:** the browser still uploads directly to Private Blob; no
store credential ever reaches the client.

---

## D-005 — Status reads must bypass the CDN cache

**Context:** implementation detail of D-002, recorded because getting it wrong
produces a bug that looks like the converter hanging.

Presigned `GET` URLs are served through Vercel's CDN cache. When a blob is
overwritten at the same pathname, the cache can serve the previous body for up
to 60 seconds. The D-002 status object is overwritten at every stage, so a
normally-presigned status URL would return stale stages and make polling
useless — a completed job could appear stuck for a minute.

**Resolution:** status URLs are presigned with `useCache: false`, which appends
`cache=0` so reads come from origin storage. The status `PUT` URL is presigned
with `allowOverwrite: true` and `addRandomSuffix: false`, since the same
pathname is rewritten repeatedly.

The result ZIP download URL keeps normal caching: it is written once and never
overwritten.

---

# Deviations from ENGINEERING_SPEC_AMENDMENT_01.md

Amendment A11 requires that an unworkable A1–A2 requirement be reported with
what was attempted, rather than silently worked around. This section is that
report.

## D-006 — A1 PPTX engine swap declined; `pptx2md` not adopted

**Amendment:** A1 replaces the hand-rolled `PptxConverter` with `pptx2md`.

**Decision:** declined by the owner on 2026-09-01. The existing converter is
retained. Everything else in A1 that does not depend on the swap is adopted
(see D-007, D-008).

**A1.1's rationale does not apply to the current build state.** It argues that
"writing this a second time adds maintenance cost and defect surface for no
gain." The converter was completed in Phase 1 (`aaaa279`): 260 lines,
12 passing tests, satisfying every row of A1.1's own comparison table —
headings, nested bullets, GFM tables, extracted media with relative links,
slide delimiters, top-then-left reading order, recursive group traversal, and
warnings instead of failures. A1.7 anticipates this case and directs that
existing work not be deleted.

**Measured findings that changed the trade (verified, not estimated):**

1. **151 MB of dependencies for a disabled feature.** `pptx2md` is 1 MB but
   requires `scipy` (116 MB) and `numpy` (35 MB); total site-packages 252 MB.
   Both are imported in exactly one module, `multi_column.py`, implementing
   `try_multi_column` — which A1.3 mandates setting to `False`. The import is
   top-level at `parser.py:30`, so it is unavoidable: importing `pptx2md`
   loads scipy and numpy regardless of configuration. A3 defers Docling partly
   on container-inflation grounds; the same standard excludes this.

2. **Licence metadata is self-contradictory.** A1.2 states Apache-2.0. The
   repository `LICENSE` is Apache-2.0, but the **PyPI package metadata
   declares "MIT Licence"**. Automated licence scanners read PyPI metadata, so
   a §51 review would report a different licence than A7.3 records. Both are
   permissive and neither blocks adoption, but the discrepancy must be
   resolved in writing before any §51 submission.

3. **The required adapters exceed the code they replace.** A1.4 (rewrite
   headings, rename all media, rewrite links), A1.5 (retain `python-pptx` and
   re-parse the whole presentation because the library exposes no structured
   warnings) and A1.6 (child-process harness) together mean parsing each
   document twice and post-processing generated Markdown, to replace a single
   pass that emits conforming output directly. Net maintenance increases.

4. **Media de-duplication would regress.** The current `MediaWriter`
   content-addresses images, storing one copy of a logo repeated across
   slides. A1.4's mandated `media/slide-NNN-image-NNN` scheme is
   per-occurrence and reintroduces duplication, pressing on the §22 180 MB
   output ceiling that A2.3 is otherwise careful to protect. A1 does not
   mention de-duplication.

**Secondary observations, not blocking:**

- A1.4 makes an unreferenced file in `media/` a hard `CONVERSION_FAILED`. For
  a third-party library whose extraction behaviour we do not control, a
  warning is the better contract.
- A1.7 requires the retained `native` engine to satisfy every new A8
  assertion while also stating it must not be extended. Those cannot both
  hold.
- `pptx2md` **does** resolve wheels-only on Python 3.14, so it would not have
  triggered the source-build failure recorded in the README.

**Stale facts in the amendment:** A1.2 states the container is
`python:3.12-slim` (it is `3.14-slim`); A1.6 cites
`MAX_LOCAL_CONCURRENT_CONVERSIONS=2` (D-001 set it to 1 with a global disk
budget). A0.2's re-run burden is nil: §57 has not yet been run, so this lands
before the near-100 MB test rather than invalidating it.

**Revisit triggers.** Reconsider `pptx2md` if PPTX fidelity becomes the
dominant complaint in real use, if the 151 MB dependency chain becomes
irrelevant (a slimmer release, or optional scipy), or if maintaining the
converter proves costlier than expected.

## D-007 — Amendment adopted except the engine swap

The following amendment requirements are **implemented** against the retained
converters, since none of them depends on `pptx2md`:

- **A1.6 killable timeout.** The amendment identifies this as the one real
  regression the swap would introduce. It was in fact already a defect in the
  Phase 1 code: `PptxConverter` and `PdfConverter` are libraries running
  in-process and cannot be interrupted the way the Pandoc subprocess can. Both
  now run in a spawned child process with a wall-clock timeout, killed on
  expiry, returning the existing `CONVERSION_TIMEOUT` code as A1.6 requires.
  DOCX is exempt: Pandoc is already a killable subprocess with its own timeout.
  The child runs inside the parent's semaphore slot and workspace reservation,
  so it does not multiply the §27 concurrency ceiling.
- **A1.5 warning taxonomy**, including connectors and WMF/EMF images, one
  warning per class per slide.
- **A1.3 speaker-note exclusion**, opt-in via `PPTX_INCLUDE_NOTES`. This was a
  genuine defect: the Phase 1 converter published notes into the output.
- **A2.3 table budgets** — `PDF_TABLE_EXTRACTION`, `PDF_TABLE_MAX_PAGES`,
  per-page timing, and a global deadline reserve.
- **A7.2/A7.3 notices**, with `Invocation` and `Notes` columns and the
  evaluated-and-rejected table.
- **A8.1 fixtures and A8.2 assertions**, including the cross-format contract.

## D-008 — A2.3 per-page timeout is measured, not pre-emptive

**Amendment:** A2.3 sets `PDF_TABLE_PAGE_TIMEOUT_SECONDS=5` and requires a page
exceeding it to be skipped.

**Problem:** `extract_tables()` is a single blocking library call. It cannot be
interrupted from inside this process — which is precisely the point A1.6 makes
for PPTX. The amendment mandates a child process for PPTX but imposes a
per-page timeout on PDF with no comparable mechanism.

**Resolution:** the per-page budget is enforced by *measuring* each page and
discarding the tables of one that overran, plus a cumulative budget that stops
table extraction entirely once the §26 deadline reserve is reached. The hard
stop is the A1.6 child-process timeout, which now wraps PDF conversion as well
as PPTX for exactly this reason.

**Intent preserved:** tables remain the degradable feature; text and images are
never skipped, and no table failure changes `conversion_status` from
`success`.

## D-009 — PDF text extraction stays on pdfplumber

**Amendment:** A2.2 assigns per-page text extraction to `pypdf` and gives
`pdfplumber` only table detection.

**Problem:** `pypdf.extract_text` has no layout awareness and degrades on
multi-column and irregularly spaced pages — the same weakness A2.1 cites as its
reason for adding table extraction. Adopting the split would fix tables while
regressing ordinary text.

**Resolution:** `pdfplumber` extracts both text and tables; `pypdf` retains
page count, encryption detection and image XObjects. This matches the
already-approved D-003 split.

**Intent preserved:** the library division still confines each tool to what it
does best, no AGPL dependency is introduced, and §35's prohibition on
rewriting or summarising text is untouched.


## D-010 — D-004 reverted: presigned client uploads abandoned

**Supersedes D-004.** Owner decision on first deployment, 2026-09-02.

D-004 moved the browser upload from the flow §12/§13 specified
(`handleUpload` + `upload`) to the newer presigned flow
(`handleUploadPresigned` + `uploadPresigned`), on the grounds that no
Vercel-managed bearer token would be in flight.

**Why it was reverted.** `handleUploadPresigned` throws
`"Missing webhook public key"` at the top of the function, *before* it inspects
whether an `onUploadCompleted` callback is registered. We register none:
`prepare-job` verifies the upload with `head()`, which is strictly stronger
because it checks the ACTUAL byte size (§14) rather than trusting a
notification. So the SDK demands `BLOB_WEBHOOK_PUBLIC_KEY` for a feature this
app does not use — and that key is a dashboard opt-in on the Blob store
connection, not settable from the CLI or reproducible in project config.

The deployment therefore depended on a manual console action to enable
something we never call.

**Resolution:** revert to `handleUpload` + `upload`, which is what §12/§13
specified in the first place. It needs only `BLOB_READ_WRITE_TOKEN`, which the
store connection provisions automatically, and it keeps multipart uploads and
real progress reporting.

**What was given up:** a single-use client token now travels to the browser. It
is scoped to one pathname, one content type, and a maximum size, all enforced
by Blob rather than by us (§13 steps 7-8), and it expires in 20 minutes.

Verified end to end on the deployed environment: 95 MB uploaded in 28.3 s with
multipart, with under 4 KB crossing the app origin for the whole job.

## D-011 — Presigned URL shape differs between reads and writes

Not a deviation so much as a correction, recorded because the wrong assumption
produced a security check that rejected valid traffic.

`assert_url_matches_path` binds each presigned URL in a convert request to the
pathname its job token was signed for. It assumed the pathname always appears
in the URL path. In production it does not:

- **read** operations (`get`, `head`) address the blob directly, so the
  pathname is the URL path on the private store host;
- **write** operations (`put`) go to the Blob API, so the pathname is a
  `?pathname=` **query parameter** and the URL path is the fixed endpoint
  `/api/blob/`.

Every legitimate result-upload URL was therefore rejected with
`JOB_TOKEN_INVALID`. `pathname_from_signed_url` now handles both shapes,
preferring the query form (an API endpoint path must never be mistaken for a
blob pathname). The binding still rejects a mismatch in either form, which is
covered by tests in both shapes.

This is exactly the class of defect §57 exists to catch: every unit test passed,
because the tests encoded the same wrong assumption as the code.


## D-012 - Shared-password gate instead of platform SSO

**Spec:** §43 names `none` and `entra`, and says production "should use
Microsoft Entra ID or another approved SSO/access-control method".

**Context:** the deployment's production URL was publicly reachable. Vercel's
Deployment Protection has a free tier ("Standard Protection") that covers
preview and generated deployment URLs but **explicitly excludes production**,
and extending it to all domains is a paid upgrade. Entra needs an app
registration that does not yet exist.

**Resolution:** a third auth mode, `password` - one shared secret, entered
once, held in a signed HttpOnly cookie. This is §43's "another approved
access-control method", not a departure from its intent.

**Honest limitations**, recorded in SECURITY.md rather than glossed: one
secret for everyone means no audit trail, no per-person revocation, and
rotation affects the whole team. It is a locked door, not an identity system.
`AUTH_MODE=entra` remains the intended production answer and is a config
change away.

## D-013 - The gate is per-route, not middleware

Middleware was the first implementation and cannot work in this architecture.
Vercel refuses the deployment outright:

    Edge Runtime is not supported in services. Service "frontend" produced
    Edge Function output "middleware".

`vercel.json` declares a multi-service project, which it must in order to run
the Python converter container (§6, §8). Next.js middleware always compiles to
an Edge Function, so the two are mutually exclusive.

**Resolution:** the check is applied explicitly at each entry point -
`lib/guard.ts` for API routes, and a server component for the page. More
verbose, but a new route is then visibly unguarded rather than silently
depending on a matcher pattern someone must remember to update.

Two related findings from getting this working:

- `node:crypto` cannot be imported by anything middleware touches, and was the
  first failure (`UnhandledSchemeError`). The session module now uses Web
  Crypto, which works in both runtimes. It survived the move away from
  middleware because it is the more portable choice regardless.
- The route guard and `authenticate()` must accept the *same* credentials.
  They briefly disagreed - the guard took a cookie or a bypass header, while
  `authenticate` took only the cookie - so an automated caller cleared the
  gate and was then refused by the identity check. Caught by the §57 release
  test, which is precisely what it is for.
