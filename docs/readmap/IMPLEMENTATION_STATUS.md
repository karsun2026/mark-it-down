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

## What does not work yet

- No READMAP code exists. Nothing has been implemented, wired, or mocked.
- No model integration of any kind exists in this repository (deliberately —
  ADR-001 now approved: the zero-AI rule is scoped to the converter only).
- No database, no queue, no OCR, no vision.

## Development-only adapters or mocks

| Adapter | Purpose | Production blocked? | Removal condition |
|---|---|---|---|
| None created yet | — | — | — |

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

**Phase 1 build**, on branch `feature/readmap-mvp`, per
`docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`. All owner approvals recorded
2026-09-13: ADR-001 (zero-AI scoped to the converter), ADR-004 (Blob
persistence), ADR-006 update (Gemini-only; Perplexity excluded as
search-grounded), ADR-007 (build in this repository). Keys: shared Gemini
key acceptable to start (owner-confirmed); goes only in
`frontend/.env.local` and this Vercel project's env settings — never
committed.

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
5. Read, in this order: `docs/readmap/ARCHITECTURE_DECISIONS.md` →
   `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md` → answer the BLOCKED
   questions, then approve Phase 1.

