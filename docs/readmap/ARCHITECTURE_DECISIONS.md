# READMAP Architecture Decisions

One numbered record per material decision. Every path referenced below was
verified to exist during the Phase 0 audit on 2026-09-13.

## ADR-001 — Scope of the zero-AI constraint

- **Status:** **Approved** (2026-09-13, repository owner): the zero-AI rule
  applies to the Mark It Down converter only; READMAP executes per its
  master spec everywhere else.
- **Date:** 2026-09-13
- **Decision owner:** Repository owner (human)
- **Problem:** `AGENTS.md` states hard constraints "No AI model. No AI
  Gateway. No OpenAI/Anthropic/Gemini. AI token usage must remain zero."
  `README.md` carries the banner "AI tokens consumed per conversion: 0", and
  `converter/app/models.py` asserts `aiTokensUsed: 0` on every convert
  response (§64). The READMAP master build spec (§4, §5, §10) requires
  structured LLM calls (Mapper, Signal Extractor, Skeptic, Compressor) with
  Anthropic and Gemini as first-class providers.
- **Existing repository constraints:** The zero-AI guarantee is a *product
  promise* of the converter: deterministic output, identical Markdown for
  identical input, verifiable at zero marginal model cost. It is load-bearing:
  `ConvertResponse.aiTokensUsed` is asserted in tests, and §64 makes it an
  acceptance criterion.
- **Options considered:**
  1. Build READMAP in a separate repository/service entirely; leave this
     repository untouched.
  2. Build READMAP inside this repository as a new, isolated component; scope
     the zero-AI constraint to the converter service only, and record the
     change in `AGENTS.md`/`DEVIATIONS.md`.
  3. Reject READMAP as incompatible with the repository's charter.
- **Decision (proposed):** Option 2 — the smallest compatible adjustment
  (READMAP spec §0 rule 7). The converter service and its `/converter/v1/convert`
  endpoint remain 100% deterministic and AI-free; their guarantees and tests
  are unchanged. READMAP's model calls live in a separate pipeline that runs
  after conversion, on the conversion *result*, never inside the converter.
  `AGENTS.md` gains one sentence scoping the AI prohibition to the converter
  path, and `DEVIATIONS.md` records the departure.
- **Why:** Option 1 forfeits the mandated reuse of "the existing Mark It Down
  architecture" (`.clinerules/readmap.md` rule 3) and duplicates
  infrastructure. Option 2 preserves every existing guarantee while isolating
  the new surface.
- **Consequences:** The repository stops being uniformly AI-free; the
  converter's per-conversion promise is preserved but the repo-wide banner
  must be reworded. Model API keys enter the environment surface (names only
  in `.env.example`; never values).
- **Security/privacy impact:** Model providers receive converted document
  text (evidence blocks), never raw binaries. Logging rules from
  `.clinerules/readmap.md` rule 16 apply to the new pipeline.
- **Cost/latency impact:** READMAP jobs consume model tokens per document;
  budgeted (`READMAP_MAX_JOB_COST_USD` name reserved in `.env.example`).
- **Reversal or migration path:** All READMAP code lives under `frontend/`
  paths new in Phase 1 (`lib/readmap/`, `app/readmap/`, `app/api/readmap/`);
  deleting those directories plus the `AGENTS.md` sentence fully reverses.
- **Files affected (on approval):** `AGENTS.md`, `README.md` (banner wording),
  `DEVIATIONS.md`, `.env.example` (names already staged).
- **Evaluation coverage:** Injection-resistance suite (READMAP spec §18) must
  pass 100% before any READMAP result is shown.

## ADR-002 — Integration boundary: reuse the conversion data path

- **Status:** Proposed
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** The READMAP spec's proposed tree (§6) assumes a generic
  `MARK_IT_DOWN_BASE_URL` client/server integration and an `app/` Next.js
  root. This repository's real architecture is a Blob-mediated job flow with
  cross-language HMAC job tokens.
- **Existing repository constraints:** `frontend/lib/blob.ts` (presigned URL
  minting), `frontend/lib/job-token.ts` (HMAC mint),
  `converter/app/security/job_token.py` (HMAC verify),
  `frontend/lib/convert-client.ts` (upload → prepare → convert → poll →
  download), `frontend/lib/filename.ts` (job path scoping).
- **Options considered:**
  1. New standalone upload + conversion path for READMAP.
  2. Reuse the existing conversion flow unchanged; READMAP starts *after* the
     `.md` result lands in Blob.
- **Decision (proposed):** Option 2. Phase 1 runs the existing conversion with
  `includeMedia=false` (bare `.md` deliverable — D-015), then READMAP reads
  that result from Blob. No converter changes in Phase 1.
- **Why:** Rule 3 forbids duplicating document conversion without a
  documented decision; option 1 would duplicate validation, quota, archive
  safety, and status machinery that is already release-tested.
- **Consequences:** READMAP inherits the converter's honest limitations
  (scanned PDFs flagged, not OCR'd — Phase 2 of READMAP addresses this).
  READMAP jobs are two-stage (convert, then analyze) and must publish a
  status object per stage.
- **Security/privacy impact:** Unchanged for conversion; READMAP analysis
  runs on the converted text only.
- **Cost/latency impact:** Adds model-call minutes on top of the ≤690 s
  conversion; status polling keeps this observable.
- **Reversal or migration path:** The READMAP stage is a consumer of the
  existing result path; removing it leaves conversion intact.
- **Files affected:** New `frontend/lib/readmap/*`; no existing file modified
  in Phase 1.
- **Evaluation coverage:** End-to-end fixture test through the real flow
  (READMAP spec §19).

## ADR-003 — Evidence-block derivation from deterministic output markers

- **Status:** Proposed
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** The READMAP spec (§8 stage 2) asks for a versioned
  `MarkItDownPackageV1` with structured `blocks: EvidenceBlockInput[]`.
  The converter produces human-facing Markdown, not a structured package.
- **Existing repository constraints:** Verified during the audit — the
  converter's output already carries deterministic, machine-parseable anchors:
  - PDF (`converter/app/converters/pdf.py`, `_convert_page`): `---` separator
    then `## Page N` heading per page.
  - PPTX (`converter/app/converters/pptx.py`, `_convert_slide`): `---`
    separator then `## Slide N` or `## Slide N — Title` per slide.
  - DOCX: Pandoc heading output; **no page anchors exist** (Word documents
    are not paginated by this path).
- **Options considered:**
  1. Modify the converter to emit a structured sidecar (the spec's
     `MarkItDownPackageV1`).
  2. Build a deterministic parser in the READMAP pipeline that segments the
     `.md` into evidence blocks using the existing markers, behind a
     versioned contract.
- **Decision (proposed):** Option 2 for Phase 1. A versioned
  `ConvertedDocumentV1` contract is *derived* in the READMAP layer
  (`lib/readmap/ingestion/segment.ts`) from the marker grammar, and pinned by
  tests against the converter's actual fixtures (`tests/converter/fixtures/`).
  The converter's public output contract (§37, D-014, D-015) is untouched.
- **Why:** The converter is deployed to production from `main` and is
  release-verified; the smallest compatible change keeps its contract frozen.
  Option 1 can be revisited when READMAP needs bounding boxes (Phase 2/OCR).
- **Consequences:** Block boundaries are only as good as the marker grammar;
  heading-level anomalies in DOCX degrade block precision (evidence anchors
  fall back to section paths). A converter output change would break the
  parser — pinned fixture tests must fail loudly.
- **Security/privacy impact:** None; parsing is local and deterministic.
- **Cost/latency impact:** Negligible (string parsing).
- **Reversal or migration path:** Swap the segmentation module for a
  structured sidecar later without touching agents.
- **Files affected:** New `frontend/lib/readmap/ingestion/*`.
- **Evaluation coverage:** Unit tests over generated fixtures; citation
  validity gate must resolve 100% of block IDs (release-gates.json).

## ADR-004 — Persistence: Blob artifacts, no database in Phase 1

- **Status:** **Approved** (2026-09-13, repository owner): use Vercel Blob
  artifacts for now; a hosted database remains a later option.
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** The READMAP spec proposes PostgreSQL with Prisma/Drizzle and
  immutable versioned records. This repository has **no database** — state is
  Blob objects (`jobs/<date>/<job-id>/status.json` per D-002) and the
  environment deliberately avoids new infrastructure (D-002: "no queue, no
  Redis, no new infrastructure").
- **Existing repository constraints:** Private Vercel Blob only; hourly
  cleanup cron exists; source blobs are deleted immediately after conversion;
  results expire after `RESULT_BLOB_MAX_AGE_MINUTES` (default 120).
- **Options considered:**
  1. Introduce hosted PostgreSQL + Drizzle now.
  2. Store READMAP artifacts as immutable, version-named Blob JSON objects
     under `jobs/<date>/<job-id>/readmap/` (evidence.v1.json, signals.v1.json,
     readmap.v1.json), read via authorized signed URLs.
- **Decision (proposed):** Option 2 for Phase 1. Blob is already the system of
  record for job state; adding a database now is a Phase-4-scale decision
  (spec §21 Phase 4 covers durability) and a new vendor/secret surface.
- **Why:** Smallest compatible change; consistent with D-002; no schema
  migration risk during the vertical slice.
- **Consequences:** No cross-job queries (no "my documents" list) in Phase 1;
  the READMAP result is reachable only while its artifacts exist under
  READMAP's own retention (`READMAP_RETENTION_DAYS` name reserved). Immutability
  is by versioned pathname, not transactional guarantees.
- **Security/privacy impact:** Private Blob with per-job path scoping already
  enforced by `frontend/lib/filename.ts` (`pathBelongsToJob`); the same
  scoping must apply to READMAP artifacts.
- **Cost/latency impact:** Small JSON PUTs; no new service.
- **Reversal or migration path:** Artifacts are JSON; importing into a
  database later is a one-off script.
- **Files affected:** New `frontend/app/api/readmap/*` routes; reuse of
  `frontend/lib/blob.ts` signing helpers.
- **Evaluation coverage:** Evidence-drawer authorization test (spec §19).

## ADR-005 — Where READMAP runs in Phase 1

- **Status:** Proposed
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** READMAP's multi-stage analysis (minutes of model calls) must
  run somewhere. Candidates: inside the converter container, inside
  `frontend/` API routes, or a third service.
- **Existing repository constraints:** The converter container is
  deliberately network-free in its core and AI-free by charter (ADR-001);
  the existing long-job pattern is POST + Blob status polling (D-002).
- **Decision (proposed):** New routes inside `frontend/`
  (`app/api/readmap/prepare`, `app/api/readmap/start`, `app/api/readmap/status`,
  `app/api/readmap/result`, `app/api/readmap/evidence/[signalId]`) with the
  pipeline in `frontend/lib/readmap/`. Stage status follows the D-002
  status-object pattern. If model latency exceeds Node function ceilings in
  practice, the pipeline splits into resumable stages (spec §14 checkpoints)
  before any third service is introduced — a Phase-4 concern.
- **Why:** Keeps one deployable surface for Phase 1, reuses `requireSession`
  and signing, and avoids touching the production converter. `frontend/` is
  the reference implementation, so code is written to be portable to the
  `market-intel-site` suite later.
- **Consequences:** READMAP's fate is coupled to the `frontend/` service
  deployment; the suite port is manual until someone mirrors it.
- **Security/privacy impact:** New routes must each call `requireSession`
  (`frontend/lib/guard.ts`) — the repo convention is explicit per-route
  guards (D-013), never middleware-only.
- **Cost/latency impact:** Analysis latency is minutes; progress must be
  honest stage markers, not fake ramps (§52 discipline, `status.py` precedent).
- **Reversal or migration path:** Route + lib directories are new; deletable.
- **Files affected:** All new; listed in `PHASE_1_IMPLEMENTATION_PLAN.md`.
- **Evaluation coverage:** E2E test: upload → progress → READMAP → depth
  change → evidence drawer → refresh retains state.

## ADR-006 — Model provider abstraction and new dependencies

- **Status:** Proposed
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** The spec requires a provider-neutral `StructuredModelClient`
  with Zod-validated structured output, Anthropic and Gemini as first-class
  options, and per-role model configuration. This repository has **no model
  dependencies and no schema-validation library**.
- **Existing repository constraints:** `frontend/package.json` has only
  `@vercel/blob`, `@vercel/firewall`, `next`, `react`, `react-dom`;
  installs run with `--ignore-scripts`; `AGENTS.md` forbids AGPL runtime
  dependencies.
- **Decision (proposed):**
  1. Add `zod` (MIT) for schema validation — the only new Phase-1 dependency.
  2. Call providers over plain `fetch` behind
     `frontend/lib/readmap/models/client.ts`; **no provider SDK** is added,
     keeping the dependency surface minimal and `--ignore-scripts`-safe.
  3. A development adapter (`models/dev-adapter.ts`) is explicitly labelled,
     enabled only by `READMAP_MODEL_PROVIDER=dev` **and**
     `APP_ENV=development`, and fails closed otherwise (rule 15).
- **Why:** Rule 19 requires checking existing capabilities first: none exist,
  so the dependency is new but minimal; hand-rolled fetch keeps the audit
  surface small and honors the no-AGPL rule.
- **Consequences:** Structured-output handling is ours (one schema-repair
  attempt per spec §10, then the unit fails); no SDK conveniences.
- **Security/privacy impact:** Provider keys are server-side env only; model
  requests are never logged (rule 16); the dev adapter cannot run in production.
- **Cost/latency impact:** Token budget tracked per job;
  `READMAP_MAX_JOB_COST_USD` reserved.
- **Reversal or migration path:** Adapters are per-file; swapping providers
  does not touch agents.
- **Files affected:** New `frontend/lib/readmap/models/*`, `frontend/package.json`.
- **Evaluation coverage:** Contract tests: provider structured output; dev
  adapter fail-closed test outside development.
- **Update (2026-09-13, increment 2 build):** The model layer was implemented
  per this decision — `models/client.ts` (the spec §5
  `StructuredModelClient` contract), `models/gemini.ts` (plain-`fetch`
  adapter, no SDK; `responseMimeType` JSON with a responseSchema pruned to
  Gemini's supported subset; one schema-repair attempt per spec §10; usage
  accounting across attempts), `models/dev-adapter.ts` (the labelled dev
  adapter: gated on `READMAP_MODEL_PROVIDER=dev` **and** `APP_ENV=development`,
  fail-closed, serving only pre-registered fixtures — never inventing output),
  and `models/model-router.ts` (per-role model ids from
  `READMAP_EXTRACTION_MODEL` / `READMAP_VERIFICATION_MODEL` /
  `READMAP_COMPRESSION_MODEL`; honest config errors for unconfigured or
  unsupported providers). **The Anthropic adapter was deliberately NOT built**
  in this increment: no key exists, and shipping an unexercised adapter would
  be untested code. The contract is provider-neutral, so adding it later
  behind the same interface needs no agent changes.
- **Update (2026-09-13, owner input):** Available keys are **Gemini** (in use
  on the market-intel suite) and **Perplexity**. Phase 1 uses the **Gemini
  adapter only**. Perplexity is **excluded from all agent roles**: its API is
  search-grounded and can draw on live web content, violating READMAP's core
  rule that the uploaded document is the only source of truth. A future,
  clearly-labelled external-research feature could use it, but only behind a
  new ADR. Anthropic remains an optional adapter per the master spec when a
  key is obtained. Keys are configured **per project**: this repo's
  `frontend/.env.local` for local development and this Vercel project's
  environment settings for deployment — they are not inherited from the
  suite repository. A separate Gemini key for READMAP is recommended over
  reusing the suite's key, so either can be rotated independently.

## ADR-007 — Placement: build READMAP in this repository

- **Status:** **Approved** (2026-09-13, repository owner): READMAP is built in
  this repository; the market-intel suite links to it via a second
  "Other Useful Stuff" tile.
- **Date:** 2026-09-13
- **Decision owner:** Repository owner
- **Problem:** The owner is unsure whether READMAP should be developed in
  this repository (where the Mark It Down tool lives) or in the main
  market-intel suite repository, which hosts the "Other Useful Stuff"
  category and currently holds the Gemini/Perplexity keys.
- **Existing repository constraints:** The suite reaches tools via tiles —
  Mark It Down is already a tile linking cross-origin to this repo's deployed
  app (the converter's CORS allow-list exists for exactly this). The
  converter, job-token contract, status machinery, and Phase 0 audit that
  READMAP builds on all live in this repository. The master build spec and
  the build pack are written against this repository.
- **Options considered:**
  1. Build in this repository (recommended): a `/readmap` surface inside the
     deployed frontend, plus a second "Other Useful Stuff" tile in the suite
     linking to it — the same pattern as the existing Mark It Down tile.
  2. Build in the suite repository: requires a fresh audit of that repo, and
     cross-repo rewiring of the converter/token/Blob contract that already
     exists here.
- **Decision (recommended):** Option 1. Keys are not a forcing factor either
  way — Vercel environment variables are configured per project, so Gemini is
  added to this project's own environment regardless of location.
- **Why:** Reuses audited infrastructure without duplication; users
  experience READMAP as another tool in the category either way, because
  tiles are links, not embedded code.
- **Consequences:** The READMAP page is a linked tool, not an embedded part
  of the suite; porting later is possible but manual.
- **Security/privacy impact:** Same-origin deployment reuse of
  `requireSession`; CORS unchanged (the READMAP page is served from this
  project, like the existing frontend).
- **Cost/latency impact:** None relative to the alternative.
- **Reversal or migration path:** The suite tile is a link; moving the tool
  later means changing one URL.
- **Files affected:** None existing in this repo; the tile is added in the
  suite repository as a link-only change.
- **Evaluation coverage:** E2E test from the suite origin (CORS behaviour
  already precedented by the Mark It Down tile).

## ADR-008 — Agent layer: versioned prompts as TS modules and deterministic contract checks

- **Status:** Implemented (Phase 1, increment 3, 2026-09-13)
- **Date:** 2026-09-13
- **Decision owner:** READMAP build
- **Problem:** Spec §24 requires versioned prompt files, not scattered string
  literals; the Phase 1 plan sketched raw `.md` assets. Raw `.md` files are
  not bundle-guaranteed in a Next.js deployment without new build
  configuration, and a missing prompt file at runtime would be a silent
  failure mode.
- **Decision:**
  1. Agent system prompts live as one reviewed TypeScript module each
     (`frontend/lib/readmap/prompts/mapper.ts`, `signal-extractor.ts`,
     `skeptic.ts`, `compressor.ts`) exporting a version constant
     (`*.v1`) and the prompt text. Same properties as `.md` files — separate,
     versioned, diffable — plus guaranteed presence in the deployed bundle.
  2. Contracts Zod cannot express are enforced deterministically beside the
     agents (`agents/contract.ts`): extractor citations must resolve to the
     supplied evidence with verbatim (whitespace-insensitive) quotes; signal
     ids are assigned by the pipeline, never the model; the skeptic receives
     only cited + bounded nearby evidence; compressor selections must resolve
     to verified signals and tiers must nest (spec §10.5). A violation throws
     `AgentContractError` — the unit fails, nothing is silently repaired.
  3. Agents depend only on `StructuredModelClient` (increment 2); no agent
     imports a provider module.
- **Why:** Keeps the honesty rules (8, 9, 13) enforceable in code rather than
  trusting prompt compliance; keeps the bundling surface dependency-free.
- **Consequences:** Prompt edits are code reviews; prompt version constants
  must move in lockstep with content changes (recorded in each agent run).
- **Security/privacy impact:** Error messages carry ids/counts only (rule 16);
  evidence text is never embedded in errors or logs.
- **Cost/latency impact:** Skeptic context is bounded (`NEARBY_CONTEXT_LIMIT`)
  to keep per-verdict cost linear and capped.
- **Reversal or migration path:** Prompts could move to `.md` + build step
  later without changing agent code (only the prompt modules change).
- **Files affected:** `frontend/lib/readmap/schemas/signal.ts`,
  `frontend/lib/readmap/prompts/*`, `frontend/lib/readmap/agents/*` (new).
- **Evaluation coverage:** 32 offline agent/contract tests; tier-nesting and
  citation-resolution tests feed acceptance checks 7–8 at Phase 1 exit.



