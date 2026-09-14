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

- No READMAP routes or UI exist yet — the pipeline runs as a library unit
  with injected hooks; nothing is reachable from the browser. Blob artifact
  persistence (ADR-004) is wired as an injectable hook, not yet connected.
- No live model call has ever been made: every test runs offline against a
  scripted client. Zero tokens spent.
- No database, no queue, no OCR, no vision; numeric checks deferred to
  READMAP Phase 3 by plan §8.

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
| Frontend suite re-run | 162/162 pass — no regressions | 2026-09-13 | `npm run test` |
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

## Next approved task

**Phase 1, increment 5 — routes, UI, and artifact persistence**: wire the
pipeline to Blob per ADR-004 (`evidence.v1.json`, `signals.v1.json`,
`readmap.v1.json`, `status.v1.json` under `jobs/<date>/<job-id>/readmap/`,
written under READMAP's own retention), the five API routes
(`app/api/readmap/prepare|start|status|result|evidence/[signalId]`, each with
`requireSession` + rate limiting on start), and the `/readmap` page with
upload, honest processing view, depth slider (precomputed tiers — zero model
calls on move), evidence drawer. Then the full Phase 1 acceptance run
(plan §9, including the 336 Python tests and the production build) before the
independent review. Work stays on `feature/readmap-mvp`.

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

