# Handoff â€” READMAP build, 13 September 2026 (updated after live E2E attempt)

This is the handoff for the READMAP work on branch `feature/readmap-mvp`.
It replaces the previous version in full. **Read it top to bottom before
changing anything.** The original converter handoff is `HANDOFF.md`
(2 September 2026). This document is written for a fresh session with no
chat history, and specifically for a **review of the Phase 1 build**, which
the owner has judged not good enough yet â€” see Â§5, "The open issue", and
Â§6, "Where to scrutinise the code".

## 1. State at a glance

| Item | State |
|---|---|
| Branch | `feature/readmap-mvp`, pushed to origin at `f115afc`, PR open against `main` |
| `main` | Untouched at `86feb79` â€” **pushing `main` deploys the production converter** |
| Build increments | 0 (audit) + 5 increments, all committed; see Â§2 |
| Offline acceptance checks (plan Â§9) | **1â€“10 and 12 pass**; recorded in `docs/readmap/IMPLEMENTATION_STATUS.md` Â§"Phase 1 acceptance run" |
| Live E2E (plan check 11) | **BLOCKED mid-conversion** â€” see Â§5. This is the reason for the review. |
| Converter | Frozen, zero modifications; 336/336 Python tests green throughout |
| Frontend tests | 179/179 green; typecheck clean; production build green |
| Model calls | **Zero tokens ever spent.** The Gemini adapter has never talked to the real API. |

## 2. Commit ledger (all on `feature/readmap-mvp`)

| Commit | What |
|---|---|
| `790bb53` | Phase 0: audit, ADRs 001â€“007, charter scoping (D-016), control files |
| `8a55fb7` | Increment 1: evidence schemas + segmentation, 13 tests |
| `08447dd` | Increment 2: model client layer â€” spec Â§5 `StructuredModelClient`, Gemini over plain `fetch` (no SDK), fail-closed dev adapter, per-role router, 29 tests |
| `cd285a9` | Increment 3: agent skeletons â€” signal schema, versioned prompts (TS modules), mapper/extractor/skeptic/compressor with deterministic contract checks, 32 tests |
| `07b38ec` | Increment 4: orchestration pipeline + deterministic grounding gate (spec Â§11 items 1â€“3, 5â€“10; Â§11.4 deferred to Phase 3), ReadMap/status schemas, 12 tests |
| `4a5a49e` | Increment 5: Blob artifacts (ADR-004), 4 API routes, `/readmap` UI, retention sweep extension, 5 tests |
| `da40c75` | Acceptance run (offline): eval-harness port with synthetic-trap injection tests, fail-closed model pre-flight, scanned-document honesty pin |
| `8ee73fb` | Local runbook: dev proxy to converter, launcher script, health pre-flight, upload progress |
| `f115afc` | Fail fast on definitive conversion refusals (4xx aborts the status poll) |

## 3. Architecture in one paragraph

Upload → the EXISTING Mark It Down conversion (browser → Blob → converter
container → Blob result `.md`, unchanged and AI-free) → `/api/readmap/start`
downloads that `.md`, segments it into page/slide-anchored evidence blocks
(`ConvertedDocumentV1`), and runs the pipeline: Mapper → Signal Extractor →
Skeptic → Compressor, each a thin unit over a provider-neutral
`StructuredModelClient` (Gemini over plain `fetch`, one schema-repair attempt,
per spec §5/§10). A deterministic grounding gate (spec §11 items 1–3, 5–10;
§11.4 numeric validation explicitly deferred to Phase 3) validates the
assembled `ReadMapV1` before anything is returned. Artifacts persist to Blob
per ADR-004. All docs: `docs/readmap/` (status, ADRs 001–009, Phase 1 plan).

## 4. Verified by tests vs. NOT verified

Verified offline (automated): segmentation against the converter's real
Markdown grammar; agent contracts (verbatim-quote citations, pipeline-assigned
signal ids, bounded skeptic input, tier nesting); grounding gate checks (spec
§11 items 1–3, 5–10); pipeline sequencing with idempotency keys and
evidence-persisted-before-model-calls; artifact path scoping; fail-closed
model configuration (`modelConfigured()`); eval-harness synthetic traps
(injection-obeying outputs flagged); scanned-document honesty (converter's
real §36 warning → PARTIAL_READY, never READY).

NOT verified — this is the heart of the review:

1. **The Gemini adapter has never made a real API call.** Request shape
   (`responseMimeType` + `responseSchema`), the Zod-to-JSON-Schema
   conversion (`const` to `enum`, keyword pruning), auth header, and error
   mapping are untested against the live endpoint. A first-contact 400 from
   Gemini on the schema is a plausible failure offline tests cannot catch.
2. **The live E2E has never completed** (see §5).
3. The dev adapter cannot serve a live E2E by design — it only returns
   pre-registered fixtures and has no runtime registration path — so live
   testing REQUIRES a real `GEMINI_API_KEY`.
4. Prompt quality is untested against real model output; the prompts are
   spec §24 constraint skeletons.

## 5. THE OPEN ISSUE — live E2E blocked mid-conversion

Timeline of the owner's first live run (2026-09-13, localhost):

1. `/readmap` 404'd — cause: port 3000 was serving the **market-intel suite**
   (a different repo). Fixed by running the mark-it-down frontend on port
   3001.
2. Upload froze at "Preparing" for many minutes — cause: the conversion POST
   goes to `/converter/v1/convert` on the same origin; `next dev` has no such
   route (production routes it via `vercel.json` to the converter container)
   and the converter service was not running. The status poll correctly
   tolerates a missing status object — which locally meant a silent
   12-minute wait. Fixed in `8ee73fb`: dev proxy in `next.config.ts`
   (`MARK_IT_DOWN_BASE_URL=http://localhost:8000` in `frontend/.env.local`),
   launcher `run-converter-local.ps1` (injects the matching
   `JOB_SIGNING_SECRET` into the converter process), health pre-flight, and
   upload progress in the UI.
3. **CURRENT BLOCKER**: on retry, upload reached **100%**, then the UI froze
   at "Uploading your document... 100 percent" — no converter stage
   (accepted / downloading / ...) was ever observed and no error appeared.
   Root cause **unconfirmed**. Fix `f115afc` (pushed AFTER this run) makes a
   definitive 4xx refusal fail immediately instead of hanging; the retry
   under `f115afc` has NOT been done yet.

Ranked hypotheses, each with the check that confirms it:

- **H1 - job-token secret mismatch (most likely).** The converter verifies
  the frontend-minted HMAC token with its own `JOB_SIGNING_SECRET`. If the
  converter was started manually instead of via `run-converter-local.ps1`,
  it has no/mismatched secret, giving 401/403, which pre-`f115afc` hung
  silently. CHECK: the uvicorn access-log line for
  `POST /converter/v1/convert` — the status code decides (401/403 = H1;
  422 = malformed request; 200 = accepted, look at H2/H3).
- **H2 - converter crashed or stalled after accepting.** A 4.5 MB annual
  report is a heavy PDF; `MAX_LOCAL_CONCURRENT_CONVERSIONS=1` plus a wedged
  prior job would stall without ever publishing a stage. CHECK: uvicorn log;
  `/converter/health` while stalled; python process CPU.
- **H3 - status publishing broken locally.** The converter publishes stages
  by PUT to a presigned Blob URL; if that write failed, no stage would ever
  appear while conversion proceeds. CHECK: after a retry, look for
  `jobs/<date>/<job-id>/status.json` and `readmap/` blobs in the Vercel Blob
  store; check the uvicorn log for Blob write errors.
- **H4 - the retry never ran under `f115afc`.** The freeze predates the fix;
  the browser tab needs a refresh and the retry repeated. CHECK: retry once
  on current HEAD and read the immediate error, if any.

Next diagnostic step, in order: retry the upload on current HEAD; capture
(a) the immediate browser error if any, (b) the uvicorn access-log line for
the convert POST, (c) whether `jobs/<date>/<job-id>/status.json` appears in
Blob. These three facts decide between H1-H4. The converter terminal's log
lines are shape-only and safe to share.

## 6. Where to scrutinise the code (reviewer checklist)

The owner judged the Phase 1 build "not good enough" after the live run
froze. Beyond §5's blocker, these are the areas a reviewer should examine
hardest, ranked by risk:

1. `frontend/lib/readmap/models/gemini.ts` — never exercised against the real
   API. Specifically: (a) the `responseSchema` produced by
   `toGeminiResponseSchema` — Gemini may reject pruned schemas or the newer
   AQ-prefixed key format may behave differently; (b) the repair prompt
   construction; (c) 429/5xx handling (no retry/backoff at all — one attempt,
   one repair, fail).
2. `frontend/lib/readmap/orchestration/pipeline.ts` — runs minutes of
   sequential model calls inside ONE request handler (`maxDuration = 300`).
   Local dev is unbounded, but a Vercel function ceiling may kill it
   mid-flight (plan ADR-002 accepts this for Phase 1 and documents the stale
   status consequence). Also: candidate-signal cap discards silently-capped
   sections with only a warning; extraction chunking is one-block-stream
   sequential (no parallelism).
3. `frontend/app/api/readmap/start/route.ts` — synchronous long request; the
   idempotency keys exist but there is no checkpoint persistence yet (a
   crashed run re-runs everything); `modelConfigured()` pre-flight covers
   config but not quota/cost.
4. `frontend/lib/readmap/evals/` — the harness port is verbatim except one
   documented type-level adaptation; the offline "obeying output" test proves
   the scorer catches bad text but does NOT prove the agents won't produce it
   — that needs the live E2E.
5. Prompt files (`frontend/lib/readmap/prompts/`) — constraint skeletons;
   real-output quality, extraction precision/recall, and compressor ranking
   are entirely unmeasured.
6. `frontend/lib/readmap/readmap-client.ts` — the polling lifecycle uses
   `window.setInterval` and the start request has no timeout of its own;
   verify cancellation and tab-background behaviour.
7. Cost controls — `READMAP_MAX_JOB_COST_USD` is reserved in `.env.example`
   but NOT implemented; a large document could spend freely within the
   candidate cap.

## 7. Environment and runbook (owner's machine)

- Repo: `c:\Users\Test User\Documents\mark-it-down` (NOT the pack folder
  `READMAP_COMPLETE_AGENT_BUILD_PACK`, which stays untracked).
- Frontend: `frontend/`, Next 15, runs on port 3001 (3000 is occupied by the
  market-intel suite): `cd frontend && npm run dev -- -p 3001`.
- Converter: `converter/`, Python 3.14 venv, start with
  `powershell -File run-converter-local.ps1` (repo root) — serves
  `127.0.0.1:8000` with `JOB_SIGNING_SECRET` injected from
  `frontend/.env.local`. Pandoc missing locally → DOCX fails, PDF/PPTX fine.
- `frontend/.env.local` (gitignored) currently holds: APP_PASSWORD,
  BLOB_READ_WRITE_TOKEN, CRON_SECRET, JOB_SIGNING_SECRET, VERCEL_OIDC_TOKEN,
  GEMINI_API_KEY (newer Google "AQ.A..." key format — valid), and
  MARK_IT_DOWN_BASE_URL=http://localhost:8000. Never print these values;
  presence/format checks only.
- Pip: `--only-binary=:all:` (enforced by converter/.venv/pip.ini). npm:
  `--ignore-scripts` if installing.
- The vitest config now maps the repo's `@/` alias; `npm run test` runs
  179 tests; typecheck and `npm run build` are green at `f115afc`.

## 8. Suggested order of work for the next session

1. Read `docs/readmap/IMPLEMENTATION_STATUS.md`, then §5 above, then
   `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md` §9.
2. Reproduce the blocker: two terminals per §7; upload the same PDF; capture
   the uvicorn access-log status for the convert POST (decides H1-H4).
3. Fix whatever it shows; the fail-fast net (f115afc) will surface the real
   error in seconds instead of minutes.
4. Once conversion completes, the pipeline's first live Gemini call happens —
   watch for adapter/schema first-contact failures (§6 item 1) and capture
   any reader-facing error.
5. Complete E2E (plan check 11): result renders, slider moves with zero
   network calls, evidence drawer resolves, refresh keeps state.
6. Then run the independent Phase 1 review (`prompts/02_REVIEW_PHASE_1.md`)
   with fresh eyes before ANY Phase 2 discussion.

## 9. Cost ledger and session log

- Cost: one npm dependency (`zod`, MIT) in Phase 1 so far; **zero model
  tokens ever spent** (all tests offline). First live calls happen in the
  blocked E2E.
- Session log: Phase 0 `790bb53`; increment 1 `8a55fb7`; increment 2
  `08447dd`; increment 3 `cd285a9`; increment 4 `07b38ec`; increment 5
  `4a5a49e`; acceptance-offline `da40c75`; local runbook `8ee73fb`; fail-fast
  `f115afc`; this handoff `(this commit)`.

