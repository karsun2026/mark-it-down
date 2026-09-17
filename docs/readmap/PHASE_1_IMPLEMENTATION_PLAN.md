# READMAP Phase 1 Implementation Plan

**Status: BLOCKED** — see the questions in §12. Nothing in this plan has been
implemented. Every path named below was verified to exist in this repository
during the Phase 0 audit (2026-09-13); suggested-but-nonexistent paths are
explicitly marked **(new)**.

Phase 1 target (READMAP spec §21): one text-native PDF/DOCX/PPTX completes
end-to-end through the real conversion path; every claim opens valid
evidence; all six reading depths work from precomputed tiers; no OCR or
vision pretence.

## 1. Preconditions

1. ~~Human approval of ADR-001 (the zero-AI constraint question)~~ —
   **approved 2026-09-13.** The remaining precondition is confirmation of
   placement per ADR-007 (recommendation: build in this repository).
2. Create branch `feature/readmap-mvp` from `main`. Never commit READMAP work
   to `main` — pushing `main` deploys the production converter.
3. Copy the build-pack control files into the repository root as the source
   of truth: `READMAP_MASTER_BUILD_SPEC.md`, `.clinerules/readmap.md`,
   `prompts/`, `readmap-eval-harness/` (currently living in the untracked
   `READMAP_COMPLETE_AGENT_BUILD_PACK/` folder).

## 2. What exists today and what Phase 1 does with it

### Reused unchanged (verified)

| Existing path | Role in Phase 1 |
|---|---|
| `converter/` (entire service) | Produces the `.md` READMAP consumes. **Zero modifications.** |
| `frontend/lib/blob.ts` | Signing helpers reused for READMAP artifacts |
| `frontend/lib/job-token.ts` | Job token mint reused (READMAP artifacts scoped to the job) |
| `frontend/lib/filename.ts` | `pathBelongsToJob` scoping reused for artifact paths |
| `frontend/lib/guard.ts` | `requireSession` on every new route |
| `frontend/lib/rate-limit.ts` | `checkConversionRateLimit` on the start route |
| `frontend/lib/convert-client.ts` | Upload + conversion flow reused (`includeMedia=false`) |
| `frontend/lib/types.ts` | Error-code contract reused; READMAP codes added as a new const |
| `tests/converter/fixtures/generated/` | Fixture sources for segmentation tests |

### Modified (minimal, documented)

| Existing path | Change | Why |
|---|---|---|
| `frontend/package.json` | Add `zod` (MIT) and new scripts (`eval:readmap:*`) | ADR-006 |
| `.env.example` | READMAP variable names, values left empty | Spec §23; staged in Phase 0 |
| `AGENTS.md`, `README.md`, `DEVIATIONS.md` | Scope the zero-AI constraint per ADR-001 | ADR-001 (approval required) |

### New (all under `frontend/` unless noted)

```text
frontend/lib/readmap/
  schemas/           evidence.ts, signal.ts, readmap.ts, status.ts  (Zod)
  ingestion/         segment.ts        # ConvertedDocumentV1 derivation (ADR-003)
  agents/            mapper.ts, signal-extractor.ts, skeptic.ts,
                     compressor.ts, runner.ts
  grounding/         claim-parser.ts, grounding-gate.ts,
                     citation-validator.ts, numeric-guard.ts
  models/            client.ts, anthropic.ts, gemini.ts, dev-adapter.ts,
                     model-router.ts
  scoring/           importance.ts, read-skip.ts
  orchestration/    pipeline.ts, stages.ts
  prompts/           mapper.md, signal-extractor.md, skeptic.md,
                     compressor.md   # versioned files, not string literals
frontend/app/readmap/
  page.tsx                        # upload + processing + results  (new)
frontend/app/api/readmap/
  prepare/route.ts, start/route.ts, status/route.ts,
  result/route.ts, evidence/[signalId]/route.ts     (new)
frontend/components/readmap/
  readmap-shell.tsx, compression-control.tsx,
  evidence-drawer.tsx, reading-guide.tsx             (new)
frontend/lib/readmap/evals/       harness port: deterministic-scorer,
  fixtures/                        synthetic-traps.json, aggregate (new)
docs/readmap/                     exists since Phase 0
```

## 3. The Mark It Down integration contract actually present

This repository has **no** `MARK_IT_DOWN_BASE_URL` service and no structured
`MarkItDownPackageV1`. The real contract, verified end to end:

1. Browser uploads the source directly to Private Blob via
   `@vercel/blob/client` (`frontend/lib/convert-client.ts` `uploadSource`).
2. `POST /api/blob/prepare-job` (`frontend/app/api/blob/prepare-job/route.ts`)
   verifies the blob exists and its real size, enforces per-job path scoping
   (`pathBelongsToJob`), signs five URLs (source GET/DELETE, result PUT,
   status PUT/GET), and mints an HMAC job token binding job id, paths,
   filename and size.
3. `POST /converter/v1/convert` (`converter/app/api.py`) receives **only**
   the token and presigned URLs; the Python side re-verifies the token
   (`converter/app/security/job_token.py`), downloads, converts, publishes
   stage status objects, uploads the result (bare `.md` when
   `includeMedia=false`, per D-015).
4. The result's Markdown is page/slide-addressable: PDF `## Page N`, PPTX
   `## Slide N — Title`, DOCX headings only (no page anchors).

Phase 1 therefore derives `ConvertedDocumentV1` (ADR-003) inside the READMAP
layer: segment the `.md` on those markers into `EvidenceBlock`s carrying
block id, page/slide number (where available), section path, block type,
`normalizedText`, `sourceText`, extraction method `MARKDOWN`, and content
hash. The derivation is pinned by tests against real converter fixtures.


## 4. How asynchronous processing works here

There is **no queue, no database, no durable job system** (D-002). The
existing pattern for a 690-second job is:

- The client POSTs and, in parallel, polls a per-job `status.json` in Blob
  (presigned with `useCache: false` to defeat CDN staleness — documented in
  `converter/app/services/status.py`).
- The server publishes honest stage markers with fixed progress values; it
  never fakes a ramp (§52).
- Idempotency: the job token carries the identity; a retry attaches to the
  running job.

Phase 1 READMAP stages map onto this pattern **without new infrastructure**:

```text
UPLOADING (existing) -> CONVERTING (existing) -> SEGMENTING ->
MAPPING -> EXTRACTING -> VERIFYING -> COMPRESSING -> GROUNDING -> READY
```

Published to `jobs/<date>/<job-id>/readmap/status.v1.json` with the same
best-effort, never-fail-the-job semantics as `StatusPublisher`. Terminal
states: `READY | PARTIAL_READY | FAILED`. Stage-level idempotency keys derive
from (checksum, pipeline version, stage, unit id) as the spec §14 requires,
enforced in the pipeline before any model call so a retry does not re-bill.

**Known limitation (documented, not hidden):** unlike the converter, a Node
route that dies mid-analysis leaves a stale status until the poll timeout.
Phase 1 accepts this and says so in the UI ("job interrupted — retry"); the
spec's durable-job requirement lands in its Phase 4.

## 5. Persistence and retention

Per ADR-004, artifacts are version-named Blob JSON objects under
`jobs/<date>/<job-id>/readmap/`:

- `evidence.v1.json` — immutable evidence blocks (never overwritten)
- `signals.v1.json` — candidate + verified signals with verdicts
- `readmap.v1.json` — gated final output with per-tier signal-id selections
- `status.v1.json` — the only object rewritten in place

Because **source blobs are deleted immediately after conversion** and results
expire after `RESULT_BLOB_MAX_AGE_MINUTES` (120), READMAP copies nothing
lazily: the SEGMENTING stage reads the `.md` result once and writes
`evidence.v1.json` under READMAP's own retention
(`READMAP_RETENTION_DAYS`, name reserved in `.env.example`). Evidence
quotations therefore outlive the expiring `.md` — the evidence drawer reads
only from `evidence.v1.json`.

## 6. How model providers are currently abstracted

They are not — the repository has zero model integration (by charter).
Phase 1 adds the abstraction (ADR-006): a `StructuredModelClient` interface
with `anthropic`, `gemini`, and a fail-closed `dev` adapter; per-role model
selection via `READMAP_{EXTRACTION,VERIFICATION,COMPRESSION}_MODEL`; Zod
schema enforcement with one repair attempt; provider-neutral idempotency
keys; no provider SDKs.

## 7. Phase 1 security risks and controls

| Risk | Control |
|---|---|
| Prompt injection from uploaded documents (spec §17) | Agents receive only evidence blocks; system rules from versioned prompt files forbid obeying document instructions; injection fixtures in the eval set must pass 100% |
| Document contents or quotes leaking into logs (rule 16) | Structured events carry ids/counters only; no `console.log` of block text; trace route pattern (`/api/trace`) reused with step names only |
| Evidence drawer authorization | `requireSession` + `pathBelongsToJob` on every route; the `[signalId]` route resolves evidence server-side, never via client-supplied blob path |
| Oversized analysis cost | Per-job block/token budget; stop or downgrade honestly, never silently skip verification (spec §15) |
| Dev adapter mistaken for production (rule 15) | `READMAP_MODEL_PROVIDER=dev` + `APP_ENV=development` both required; otherwise the route fails closed with `SERVICE_UNAVAILABLE` |
| Result `.md` expiring mid-analysis | SEGMENTING writes `evidence.v1.json` before any model call (§5) |
| Keys in the repo | Names only in `.env.example`; values gitignored (`.env.deploy.local` precedent) |

## 8. Agent and grounding contracts (Phase 1 scope)

- Mapper, Signal Extractor, Skeptic, Compressor per spec §10, all Zod-validated.
- Numeric Checker is **deferred to READMAP Phase 3**; Phase 1's grounding gate
  still runs the deterministic checks it can (citation resolution, tier
  nesting, interpretation separation, signal-id validity) — numeric values are
  preserved verbatim in quotes but not independently validated, and the UI
  must not label numbers "verified" beyond the §11 wording.
- No OCR, no vision, no Document Doctor in Phase 1 (READMAP Phase 2). A
  scanned PDF reaches READMAP only through the converter's existing warning
  ("Page N may be scanned..."), which must surface as a coverage limitation —
  honest partial output, never a confident full summary.


## 9. Acceptance checks (exact, run at the end of Phase 1)

All must pass on the Phase 1 branch before commit. Failures are reported
honestly, never papered over (`.clinerules/readmap.md` rule 17).

**Existing suites still green (regression):**

1. `cd converter && ./.venv/Scripts/python.exe -m pytest ../tests/converter -q`
   — 336 tests, unchanged converter must stay green.
2. `cd frontend && npm run typecheck`
3. `cd frontend && npm run test` (existing Vitest suite)
4. `cd frontend && npm run build`

**New READMAP checks (deterministic, offline where possible):**

5. Segmentation unit tests: PDF fixture yields blocks with correct
   `## Page N` anchors; PPTX fixture yields slide anchors; DOCX fixture
   yields section-path anchors. Pinned against
   `tests/converter/fixtures/generated/` outputs.
6. Grounding-gate unit tests: every deterministic check in spec §11
   (items 1–3, 5–10) enforced; §11 item 4 (numbers) explicitly marked
   deferred and cannot silently pass.
7. Tier-nesting test: `ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE`.
8. Citation-resolution test: 100% of output claims resolve to blocks in
   `evidence.v1.json` of the same job (release-gates.json:
   `minimumCitationValidity: 1`).
9. Dev-adapter fail-closed test: with `APP_ENV != development`, every route
   that needs a model returns `SERVICE_UNAVAILABLE`, never a mock result.
10. Injection fixture test: `synthetic-traps.json` cases run through the
    deterministic scorer; instructions embedded in documents do not appear
    as obeyed actions.
11. E2E (dev, with dev adapter or real keys): upload one text-native
    fixture → progress stages → READMAP renders → depth change makes no
    network call (assert: no fetch on slider move) → evidence drawer opens
    the cited block → refresh preserves job state.
12. Honesty check: a scanned-like fixture (`scanned-like.pdf`) produces a
    visible coverage limitation, not a confident summary.

**Explicitly NOT claimed in Phase 1** (no pretence, rule 24): OCR, vision,
table-image recovery, independent numeric verification, durable resume,
multi-document features.

## 10. Exact files proposed for addition or modification

**Modified (3):** `frontend/package.json`, `.env.example` (staged in Phase 0),
`AGENTS.md`/`README.md`/`DEVIATIONS.md` (ADR-001 wording, on approval).

**Added:** everything in §2 "New" — summarized:
`frontend/lib/readmap/` (schemas, ingestion, agents, grounding, models,
scoring, orchestration, prompts, evals), `frontend/app/readmap/page.tsx`,
five `frontend/app/api/readmap/*` routes,
`frontend/components/readmap/*`, plus copied control files from the build
pack (§1 precondition 3).

**Untouched:** `converter/**` (zero changes), all existing
`frontend/app/api/**`, `frontend/lib/**` except none, `tests/converter/**`.

## 11. Architecture conflicts found (summary)

| # | Conflict | Resolution path |
|---|---|---|
| 1 | Zero-AI charter vs. READMAP's LLM agents | ADR-001 — **BLOCKING, human decision** |
| 2 | No database vs. spec's PostgreSQL proposal | ADR-004 — Blob artifacts for Phase 1 |
| 3 | No queue vs. durable background jobs | Follow D-002 status pattern; durability deferred to READMAP Phase 4 |
| 4 | Spec's `app/` root tree vs. existing `frontend/` structure | Adapt names; keep repo conventions (spec §6 allows this) |
| 5 | `aiTokensUsed: 0` contract | READMAP never calls `/converter/v1/convert`; the converter's guarantee is scoped to conversions (ADR-001) |
| 6 | Shared-password auth vs. per-user `ownerId` | Job-scoped ownership in Phase 1; auth model deferred (spec §25) |
| 7 | Immediate source deletion + 120-min result expiry vs. evidence retention | Evidence snapshot written before analysis (§5) |
| 8 | DOCX has no page anchors | Section-path anchors for DOCX; read/skip recommendations worded accordingly |

## 12. Verdict

**Updated 2026-09-13 after owner input — all questions resolved.**

- **Q1 (ADR-001): APPROVED.** The zero-AI rule applies to the Mark It Down
  converter only; READMAP executes per its master spec everywhere else.
- **Q3 (ADR-004): APPROVED.** Vercel Blob JSON artifacts for Phase 1.
- **Q4 (providers): ANSWERED.** A Gemini key is available (in use on the
  market-intel suite); Phase 1 uses the **Gemini adapter only**. Perplexity
  is excluded from agent roles — its API is search-grounded and could import
  outside facts, violating "the uploaded document is the source of truth."
  Keys are configured **per project**: add them to this repo's
  `frontend/.env.local` (local dev) and this Vercel project's environment
  settings (deployment) — they are not inherited from the suite repo. A
  separate Gemini key for READMAP is recommended over reusing the suite's.
- **Q2 (placement): APPROVED (ADR-007, 2026-09-13).** READMAP is built in
  **this repository**; the market-intel suite links to it via a second
  "Other Useful Stuff" tile — the same pattern as the existing Mark It Down
  tile.

**All four decisions are resolved. Phase 1 is unblocked.**


