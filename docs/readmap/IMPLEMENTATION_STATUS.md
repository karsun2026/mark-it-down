# READMAP Implementation Status

## Current phase

- Phase: 1 (truthful vertical slice)
- Status: **Approved and starting** — all decisions resolved (ADR-001, 004,
  006 update, 007); branch `feature/readmap-mvp` created 2026-09-13
- Owner/model: Cline (VS Code)
- Last updated: 2026-09-13
- Git branch: `main` (audit only; `feature/readmap-mvp` to be created when Phase 1 is approved)
- Latest verified commit: 86feb79 "Add a handoff for whoever picks this up next"

## What currently works

The existing Mark It Down product is complete, deployed, and §57 release-verified:

- Deterministic conversion of `.docx` (Pandoc), `.pptx` (python-pptx), `.pdf`
  (pypdf + pdfplumber) — zero AI tokens, by design.
- Browser → Private Vercel Blob direct upload (max 100 MB); binaries never
  pass through a Vercel Function body.
- HMAC job tokens minted in TypeScript (`frontend/lib/job-token.ts`), verified
  in Python (`converter/app/security/job_token.py`) — cross-language contract
  is test-covered (`tests/converter/test_cross_language_token.py`).
- Stage-by-stage status objects in Blob (DEVIATIONS D-002) polled by the
  browser; converter stages: accepted → downloading → validating → converting
  → packaging → uploading → complete/failed.
- Shared-password auth (`AUTH_MODE=none|password|entra`) with explicit
  per-route guard (`frontend/lib/guard.ts`).
- Result retention and hourly cleanup cron (`/api/blob/cleanup`, `CRON_SECRET`).
- 336 Python tests (`tests/converter`), frontend Vitest suite, CI
  (`.github/workflows/ci.yml`).
- Page/slide-addressable Markdown: PDF emits `## Page N` + `---` per page;
  PPTX emits `## Slide N — Title` per slide; DOCX (Pandoc) emits headings only
  (no page anchors exist for DOCX).
- READMAP evidence layer (Phase 1, first increment): deterministic
  `frontend/lib/readmap/ingestion/segment.ts` segments converter Markdown
  into page/slide-anchored evidence blocks behind the Zod-validated
  `ConvertedDocumentV1` contract (`frontend/lib/readmap/schemas/evidence.ts`);
  13 tests pin it to the converter's real output grammar.
- READMAP routes, UI, and artifact persistence (Phase 1, fifth increment):
  Blob artifact persistence per ADR-004 (`frontend/lib/readmap/artifacts.ts` —
  evidence/signals/tiers/readmap/status .v1.json under the conversion job's
  own `readmap/` prefix, status reads CDN-bypassed per D-005, READMAP-only
  retention via `READMAP_RETENTION_DAYS`, default 7 days, swept by the
  existing hourly cleanup); four routes (`app/api/readmap/start|status|
  result|evidence/[signalId]`), each with `requireSession`, rate limiting on
  start, and the conversion job's HMAC token verified with the exact
  download-url binding pattern (`lib/readmap/route-access.ts`); start is an
  idempotent POST that re-uses a completed analysis instead of re-billing.
  UI: `/readmap` page (server-gated) with the converter flow reused for
  conversion, honest processing stages polled from Blob, a depth slider that
  moves between PRECOMPUTED tiers client-side (no fetch on move), and an
  evidence drawer resolved server-side. Production build passes; 167/167
  tests; typecheck clean; zero live model calls.
- READMAP orchestration + grounding gate (Phase 1, fourth increment): the
  pipeline (`frontend/lib/readmap/orchestration/`) sequences mapper →
  extractor → skeptic → compressor over one `ConvertedDocumentV1`, persists
  the immutable evidence snapshot BEFORE any model call, runs every unit
  under an idempotency key derived from (checksum, pipeline version, stage,
  unit id), assigns globally-unique signal ids, publishes honest fixed stage
  markers (SEGMENTING…GROUNDING, terminal READY | PARTIAL_READY | FAILED),
  caps candidate signals with a visible warning, and assembles the
  `ReadMapV1` result deterministically from verified signals, tiers, and the
  map. The grounding gate (`frontend/lib/readmap/grounding/`) enforces spec
  §11 items 1–3 and 5–10 in code — citation resolution, no unsupported
  signals, interpretation separation, tier nesting, coverage honesty,
  recommendation targets, numeric preservation in renderings — with §11.4
  (independent numeric validation) explicitly DEFERRED to Phase 3 and never
  silently passed; gate failures are repaired by omission, at most one
  round, and an unrepairable thePoint fails the job. 12 tests (162/162
  total); typecheck clean; zero live model calls.
- READMAP agent skeletons (Phase 1, third increment): Zod agent contracts
  (`frontend/lib/readmap/schemas/signal.ts` — DocumentMap, candidate signals,
  skeptic verdicts, nested compression tiers), four versioned system prompts
  (`frontend/lib/readmap/prompts/`), and thin agent units
  (`frontend/lib/readmap/agents/` — mapper, signal-extractor, skeptic,
  compressor) that consume the model layer only via `StructuredModelClient`.
  Deterministic contract checks pin the honesty properties: extractor
  citations must resolve to supplied evidence with verbatim quotes; signal
  ids are pipeline-assigned (`s0001`…), never model output; the skeptic sees
  only cited + bounded nearby evidence; compressor selections must resolve to
  verified signals and tiers must nest
  (`ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE`). 32
  offline tests (150/150 total); typecheck clean; zero live model calls.
- READMAP model client layer (Phase 1, second increment): the spec §5
  `StructuredModelClient` contract (`frontend/lib/readmap/models/client.ts`),
  a Gemini adapter over plain `fetch` — no provider SDK — with Zod-validated
  structured output, a Gemini-subset `responseSchema` conversion, and exactly
  one schema-repair attempt (`models/gemini.ts`); the labelled dev adapter
  that serves only pre-registered fixtures and fails closed outside
  development (`models/dev-adapter.ts`); and the per-role router
  (`models/model-router.ts`). 29 tests pin the wire contract, the
  one-repair-attempt rule (spec §10), and the fail-closed behaviour.

## What does not work yet

- No live model call has ever been made: every test runs offline against a
  scripted client. Zero tokens spent. First real end-to-end run (real Gemini
  key or the labelled dev adapter) happens in the Phase 1 acceptance run.
- No database, no queue, no OCR, no vision; numeric checks deferred to
  READMAP Phase 3 by plan §8.
- Known limitation (documented in plan §4): if the start route dies
  mid-analysis, the status object stays at its last stage until the browser's
  request timeout — the result route is the authority, and a retry re-uses or
  re-runs honestly.

## Local runbook (development only)

The browser POSTs conversions to `/converter/v1/convert` on its own origin.
Production routes that path to the converter container via `vercel.json`;
`next dev` has no such route. To run the full READMAP flow locally:

1. `frontend/.env.local` sets `MARK_IT_DOWN_BASE_URL=http://localhost:8000`
   (added this session) — `next.config.ts` proxies `/converter/*` to it, only
   when the variable is set, only in dev. Production behaviour is unchanged.
2. Start the converter with `run-converter-local.ps1` (repo root) in a second
   terminal — it injects the matching `JOB_SIGNING_SECRET` from
   `frontend/.env.local` into the converter process (the token check fails
   otherwise) and warns if pandoc is missing (DOCX only; PDF/PPTX need none).
3. `npm run dev` (restart required after config/env changes).
4. The UI now pre-flights `/converter/health` and fails in seconds with the
   fix in the message if the converter is down — the twelve-minute silent
   status-poll wait is no longer reachable from the READMAP page. Upload
   progress is shown during the direct-to-Blob upload.

## Development-only adapters or mocks

| Adapter | Purpose | Production blocked? | Removal condition |
|---|---|---|---|
| `frontend/lib/readmap/models/dev-adapter.ts` | Labelled dev model adapter serving ONLY pre-registered fixture responses (`registerDevResponse`); never invents output | Yes — requires `READMAP_MODEL_PROVIDER=dev` AND `APP_ENV=development`, re-checked on every call | Serves until agents are wired against the real Gemini adapter in this environment; delete when no longer used |

Phase 1 will introduce a labelled development model adapter if no provider key
exists. It must fail closed outside development (`.clinerules/readmap.md` rule 15).

## Current architecture

Two Vercel services from one repository (`vercel.json`):

| Piece | Location | Stack | Notes |
|---|---|---|---|
| Converter | `converter/` | Python 3.14, FastAPI, container | Deterministic, network-free core; sync job up to 690 s |
| Web app | `frontend/` | Next.js 15 App Router, React 19, TS 5.9 | Reference implementation; the production front door is the suite in the separate `market-intel-site` repo |

Data path: browser uploads directly to Private Blob → `/api/blob/prepare-job`
verifies the blob, signs five URLs, mints the job token → browser POSTs
`/converter/v1/convert` with token + presigned URLs only → converter
downloads, converts, publishes status, uploads result → browser polls status →
`/api/blob/download-url` mints a signed link on click.

Deployment: pushing to `main` deploys the converter to production. The Vercel
CLI deploys the working tree, not `git HEAD`.

Full details: `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`.

## Verification results

| Check | Result | Date | Evidence/report |
|---|---|---|---|
| Repository audit (Phase 0 exit) | Complete | 2026-09-13 | This file + `ARCHITECTURE_DECISIONS.md` + `PHASE_1_IMPLEMENTATION_PLAN.md` |
| Existing frontend suite re-run | 76/76 pass — no regressions | 2026-09-13 | `npm run test` |
| New segmentation tests | 13/13 pass | 2026-09-13 | `frontend/lib/readmap/ingestion/segment.test.ts` |
| New model-layer tests | 29/29 pass (11 gemini, 9 dev-adapter, 9 model-router) | 2026-09-13 | `frontend/lib/readmap/models/*.test.ts` |
| New agent-layer tests | 32/32 pass (12 contract, 5 extractor, 8 skeptic, 3 mapper, 4 compressor) | 2026-09-13 | `frontend/lib/readmap/agents/*.test.ts` |
| New grounding/pipeline tests | 12/12 pass (8 gate, 3 pipeline, 1 chunking) | 2026-09-13 | `frontend/lib/readmap/grounding/*.test.ts`, `frontend/lib/readmap/orchestration/pipeline.test.ts` |
| New artifact-layer tests | 5/5 pass (paths, job scoping, retention, sweep detection) | 2026-09-13 | `frontend/lib/readmap/artifacts.test.ts` |
| Frontend suite re-run | 167/167 pass — no regressions | 2026-09-13 | `npm run test` |
| Production build | Pass — /readmap + 4 READMAP routes compile | 2026-09-13 | `npm run build` |

## Phase 1 acceptance run (plan §9, 2026-09-13)

| Check | Result | Evidence |
|---|---|---|
| 1. Python converter suite | **336/336 pass** — converter untouched and green | `pytest ../tests/converter -q` (51s) |
| 2. Frontend typecheck | Pass (clean) | `npm run typecheck` |
| 3. Frontend Vitest suite | **179/179 pass** (167 + 12 acceptance-run tests) | `npm run test` |
| 4. Production build | Pass | `npm run build` |
| 5. Segmentation units | Pinned since increment 1 (13 tests, real grammar) | `segment.test.ts` |
| 6. Grounding-gate unit tests | §11 items 1–3, 5–10 enforced; §11.4 deferred and reported, cannot silently pass | `grounding-gate.test.ts` |
| 7. Tier nesting | `ONE_THING ⊆ … ⊆ DEEP_DIVE` enforced in agent + gate + scorer tests | `contract.test.ts`, `grounding-gate.test.ts`, `evals.test.ts` |
| 8. Citation resolution | 100% of output-claim citations resolve (scorer gate `minimumCitationValidity: 1`); pipeline gate UNKNOWN_* checks | `evals.test.ts`, `citation-validator.ts` |
| 9. Fail-closed without a key | `modelConfigured()` pre-flight refuses `/api/readmap/start` with SERVICE_UNAVAILABLE before any token spend, in every unconfigured configuration (6 tests) | `route-access.test.ts` |
| 10. Injection fixtures | Harness scorer ported to `lib/readmap/evals/`; honest outputs pass all critical checks; outputs obeying embedded instructions are flagged in every trap and fail the release gate | `evals/evals.test.ts` |
| 11. E2E | **Not run this session** — needs a live server with a real Gemini key (or the labelled dev adapter) and a browser. Remaining item for the Phase 1 exit. | — |
| 12. Scanned-document honesty | A scanned-like fixture (page 2 yields no blocks + the converter's REAL §36 warning, pinned verbatim) yields PARTIAL_READY with the limitation surfaced, ratio < 1 — never a confident summary | `pipeline.test.ts` (check-12 block) |

Remaining before Phase 1 closure: the E2E check (11) with credentials, then the independent review (`prompts/02_REVIEW_PHASE_1.md`).
| Frontend typecheck | Pass (clean) | 2026-09-13 | `npm run typecheck` |
| Production build | Not yet run this phase | — | At Phase 1 exit |
| Python converter suite | Not run — converter unchanged | 2026-09-13 | To run at Phase 1 exit (336 tests) |
| README/spec conflict review | 1 blocking conflict found → resolved | 2026-09-13 | ADR-001 approved |

## Known risks

| Risk | Severity | Mitigation | Owner/status |
|---|---|---|---|
| ~~Zero-AI charter vs. READMAP's LLM agents~~ | Resolved | ADR-001 **approved 2026-09-13**: zero-AI applies to the converter only | Closed |
| Perplexity API is search-grounded; could import outside facts and break grounding | Medium | Excluded from all agent roles (ADR-006 update); Gemini-only for Phase 1 | Documented |
| ~~Placement of READMAP~~ | Resolved | ADR-007 **approved 2026-09-13**: build in this repo; suite adds a second "Other Useful Stuff" tile | Closed |
| Source blobs are deleted immediately after conversion; results expire after ~120 min | High for READMAP | READMAP artifacts must be written under their own retention; plan §5 | Open — plan addresses |
| Shared-password auth gives no per-user identity (`ownerId`) | Medium | Spec §25 defers auth model; Phase 1 uses job-scoped ownership | Deferred by spec |
| DOCX output has no page anchors | Medium | Phase 1 anchors DOCX evidence to headings/sections, not pages | Documented in plan |
| Push to `main` deploys production | Medium | Phase 1 work must happen on `feature/readmap-mvp` | Plan §1 |
| New npm dependency (zod) needed for schema validation | Low | MIT license, widely used; recorded in ADR-006 | Approval at Phase 1 |

## Phase 1 code-review remediation (2026-09-16)

`docs/readmap/PHASE_1_CODE_REVIEW.md` (independent review, 2026-09-15) was
implemented per its §6 fix pack, in its §5 order. All work on
`feature/readmap-mvp`:

- **H1** — `artifacts.ts` `presignedGet`: `useCache: !fresh` (status reads now
  really bypass the CDN, matching D-005). Test added (`artifact-io.test.ts`).
- **C1** — `start/route.ts` reuse branch now reads the persisted `ReadMapV1`
  object itself (the old `existing?.readmap` check was dead code), returns
  `PARTIAL_READY` when the stored status says so. Route-level test added
  (`lib/readmap/start-route.test.ts`); asserts `reused: true` and that the
  pipeline never runs.
- **C2** — per-unit checkpoints wired: `readmapUnitPath` +
  `get/putReadmapUnit` in `artifacts.ts`, a `checkpoint` hook in
  `ReadmapPipelineInput`, `cachedUnit` in the pipeline, and the start route
  backs it with `readmap/units/<key-hash>.json`. A checkpoint hit reports
  ZERO usage — a retry does not re-bill. Test: a fully checkpointed re-run
  makes zero model calls.
- **C3** — VERIFYING parallelized with `mapWithConcurrency`
  (`VERIFY_CONCURRENCY = 6`, order-preserving, unit-tested) and
  `MAX_CANDIDATE_SIGNALS` lowered to 40 for the slice with the warning kept.
- **M1** — numeric guard compares canonical VALUES (`$1.5bn` ≡ `1.5 billion`,
  `12%` ≡ `12 percent`, `1,000` ≡ `1000`); no more false-positive
  NUMBER_DROPPED on rewordings. Tests in `numeric-guard.test.ts`.
- **M3** — `thePoint` only cites a USABLE signal (falls through otherwise);
  tested at the assembly boundary.
- **M4** — `putReadmapArtifact` gained an `immutable` option
  (`allowOverwrite: false` for `evidence`/`signals`; pre-existing immutable
  artifacts are kept on retry instead of failing the write).
- **M5** — Gemini schema subset + live-400 fallback (applied 2026-09-15,
  verified live; unchanged this session).
- **H2** — READMAP UI restyled onto the existing `globals.css` design system
  (Tailwind classes removed from `ReadmapApp.tsx`; a READMAP block appended to
  `globals.css` so `.notice`, `.claim`, `.drawer`, etc. actually exist).
- **H3** — determinate progress: `onProgress` in `readmap-client.ts` derives a
  percentage from the polled unit counts; `ProcessingView` renders a real
  `.progress-fill` bar (indeterminate fallback when no counts).
- **H4** — `ReadmapResult` now renders the coverage line, the read/skip guide
  (`actuallyRead`/`safelySkip`), `rememberThese`, and `documentShape` the
  pipeline already produced (component-level test pending — no React test
  harness exists yet; noted for the E2E).
- **L1** — one bounded 429/503 retry with backoff in the Gemini adapter
  (`transientRetryBackoffMs` test seam). Two tests added.
- **L2** — `READMAP_MAX_JOB_COST_USD` enforced in the pipeline: extraction and
  verification stop at the cap with a disclosed limitation → PARTIAL_READY.
- **L3** — no redundant third grounding-gate pass (the recheck is reused).
- **L4** — status-route comment fixed (`STARTING`, not `UNKNOWN`).
- **L5** — dead `locatedTierClaims` deleted from `claim-parser.ts`.
- **L7** — `segment.ts` word count is prose-only (anchors/`---` skipped,
  table pipes not counted as words).

Not implemented (documented design debt, no patch in the review's fix pack):
**M2** (compressor nesting/selection brittleness — the review only sketches
the deterministic-tier-construction alternative) and **L6** beyond the route
test added for C1 (no UI-component test harness exists).

Verification this session: `npm run typecheck` clean; `npm run test`
**202/202 pass** (181 prior + 21 new: 6 numeric-guard, 2 mapWithConcurrency,
2 checkpoint, 1 thePoint-usability, 2 artifact-io, 2 unit-path, 2 start-route,
2 gemini-429, plus the pre-existing 429 test updated for the retry contract).
`npm run lint` could not run (eslint not installed in this environment).
Converter untouched; smoke tests not re-run (no converter change).

## Next approved task

**Phase 1 exit — acceptance run + independent review**: the full §9 run from
`docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md` — 336 Python converter tests,
typecheck, full Vitest suite, production build, tier-nesting and
citation-resolution gates, dev-adapter fail-closed behaviour, injection
fixtures through the deterministic scorer, the honesty check on a
scanned-like fixture, and an E2E pass with a real Gemini key or the labelled
dev adapter. Then the independent Phase 1 review (`prompts/02_REVIEW_PHASE_
1.md`) before Phase 2 is even discussed. Work stays on `feature/readmap-mvp`.

## Handoff note

The next engineer/model needs to know, without chat history:

1. This repository is a finished, deployed, deterministic document-to-Markdown
   converter. Its zero-AI charter is now scoped to the converter only
   (ADR-001, approved 2026-09-13); READMAP's model calls are permitted
   outside the converter path.
2. READMAP must reuse the existing Blob/job-token/status architecture, not
   duplicate it (`.clinerules/readmap.md` rule 3). The converter's Markdown
   output is already page/slide-addressable for PDF and PPTX — the evidence
   layer can be built by parsing those deterministic markers, with no change
   to the converter in Phase 1.
3. `frontend/` is a reference implementation; the real user-facing front door
   lives in the separate `market-intel-site` repository. Anything built in
   `frontend/` here should be designed for later porting.
4. Pip installs must use `--only-binary=:all:`; npm installs must use
   `--ignore-scripts`. Pushing to `main` deploys the converter to production.
5. Read, in this order: `HANDOFF_READMAP.md` (the dated session handoff at
   the repo root) → `docs/readmap/ARCHITECTURE_DECISIONS.md` →
   `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`; then continue the Phase 1
   build sequence it lists.

