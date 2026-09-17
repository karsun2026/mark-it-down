# Handoff — READMAP build, 16 September 2026 (Phase-1 review remediation applied)

This is the handoff for the READMAP work on branch `feature/readmap-mvp`.
It replaces the 13 September handoff in full. **Read it top to bottom before
changing anything.** The original converter handoff is `HANDOFF.md`
(2 September 2026). This document is written for a fresh session with no
chat history.

The 13 September handoff handed off a Phase-1 build the owner judged "not
good enough yet" and an independent code review (`docs/readmap/PHASE_1_CODE_REVIEW.md`,
15 September). That review's §6 fix pack has now been **implemented and committed**
(see §2). This handoff is the post-remediation state: what is done, what is
verified, and the small set of tasks that remain before Phase 1 can exit.

## 1. State at a glance

| Item | State |
|---|---|
| Branch | `feature/readmap-mvp`, **6 new commits on top of `948803e`** (see §2); not yet pushed |
| `main` | Untouched at `86feb79` — **pushing `main` deploys the production converter** |
| Phase-1 review fix pack | **Implemented and committed** per `PHASE_1_CODE_REVIEW.md` §6, in its §5 order (6 commits). M5 was already applied at `948803e`. |
| Frontend tests | **202/202 green** (was 181; +21 new); typecheck clean |
| Converter | Frozen, zero modifications; unchanged this session |
| Live E2E (plan check 11) | **Still not run** — now unblocked by H1 (CDN cache), C3 (concurrency/timeout), and M5 (Gemini schema). This is the one remaining Phase-1 exit item. See §3. |
| Model calls | **Zero tokens ever spent.** All tests offline. First live Gemini calls happen in the pending E2E. |
| `npm run build` | **Not run this session** — run before exit (see §3) |
| `npm run lint` | **Could not run** — eslint is not installed in this environment; run before exit |

## 2. Commit ledger (all on `feature/readmap-mvp`)

Prior commits (unchanged from the 13 September handoff): `790bb53` -> `f115afc`,
ending at `948803e` "Fix READMAP Gemini adapter schema rejection (M5) + add
Phase 1 code review" (M5 was applied there, uncommitted at review time, now
committed). The review itself lives at `docs/readmap/PHASE_1_CODE_REVIEW.md`.

Remediation commits (this session, 2026-09-16), in the review's §5 order:

| Commit | What |
|---|---|
| `473b384` | H1: `useCache: !fresh` in `presignedGet` (the inverted CDN-cache flag that reintroduced D-005's "looks stuck" bug). Same commit lands the C2 checkpoint helpers (`readmapUnitPath`/`getReadmapUnit`/`putReadmapUnit`) and M4 immutability on `putReadmapArtifact`, which later commits depend on. Test: `artifact-io.test.ts` (mocked Blob asserts the flag). |
| `f000512` | C1: the idempotent-reuse branch now reads the persisted `ReadMapV1` itself (the old `existing?.readmap` check was dead code — every retry re-billed). Returns `PARTIAL_READY` from the stored status. Wires C2 checkpoints + M4 immutable persist. Route-level test `start-route.test.ts` asserts `reused:true` and that the pipeline never runs. |
| `e417258` | C3: VERIFYING parallelized via `mapWithConcurrency` (`VERIFY_CONCURRENCY=6`, order-preserving); `MAX_CANDIDATE_SIGNALS` 100->40 with the warning kept. Same commit: C2 `cachedUnit` (checkpoint hit -> zero usage, a retry never re-bills), M3 (thePoint only cites a usable signal), L2 (`READMAP_MAX_JOB_COST_USD` enforced -> honest PARTIAL_READY), L3 (no redundant third gate pass). Tests for concurrency order/limit, zero-call checkpointed re-runs, thePoint usability. |
| `7cafe3f` | M1: numeric guard compares canonical VALUES (`$1.5bn` = `1.5 billion`, `12%` = `12 percent`, `1,000` = `1000`) — no more false-positive NUMBER_DROPPED on rewordings. L5: deleted the unused `locatedTierClaims`. Tests in `numeric-guard.test.ts`. |
| `07b41de` | H2/H3/H4: de-Tailwinded `ReadmapApp` onto the existing `globals.css` design system (the project has no Tailwind; the shell was unstyled) + appended a READMAP CSS block so the child classes exist; determinate progress (`onProgress` from polled unit counts -> a real `.progress-fill` bar); `ReadmapResult` now renders the coverage line, the read/skip guide, `rememberThese`, and `documentShape` the pipeline already produced. |
| `cd7e872` | L1: one bounded 429/503 retry with backoff in the Gemini adapter. L4: status-route comment (`STARTING`, not `UNKNOWN`). L7: prose-only word count (anchors/`---` skipped, table pipes not counted). |

## 3. Pending tasks (the only things left before Phase 1 exits)

These are ranked. Do them in order.

1. **Push the branch** — `git push origin feature/readmap-mvp` (the 6 remediation
   commits are local only). Never push `main`.
2. **Run `npm run build`** in `frontend/` — production build was not run this
   session. Typecheck is clean and the route + UI compile, but a green build
   is a Phase-1 exit requirement (ENGINEERING_SPEC / repo AGENTS.md).
3. **Run `npm run lint`** — eslint is not installed in this environment, so it
   could not be verified. Install/run it before exit; fix any findings.
4. **The live E2E (plan check 11)** — the one remaining acceptance item. It
   is now unblocked by H1 (status polling no longer looks stuck), C3 (a real
   document fits the 300s ceiling), and M5 (the first Gemini call no longer
   400s on `additionalProperties`/`prefixItems`). Runbook in §5. This is the
   first time any model token will be spent.
5. **Then the independent Phase-1 review** (`prompts/02_REVIEW_PHASE_1.md`)
   with fresh eyes before **any** Phase 2 discussion.

## 4. What is NOT implemented (documented design debt, do not silently skip)

- **M2** — compressor nesting/selection brittleness (`assertTierNesting`/
  `assertSelectionsResolve` throw inside the compressor unit -> the pipeline
  `catch` returns FAILED; a `TIER_NESTING` failure is not repairable). The
  review only **sketches** the fix (construct nested tiers deterministically
  in code from a single ranked signal list, instead of trusting the model to
  nest). There is no drop-in patch in the review's §6, so it was not
  implemented. Expect frequent total failures on first live runs until this
  is addressed; consider it the most likely live-E2E failure mode after
  conversion succeeds.
- **L6 (UI-component tests)** — there is no React test harness in the repo
  (vitest is configured for `lib/**/*.test.ts` only). The route-level C1 test
  was added; the UI rendering (H4) is verified by the pipeline producing the
  data and a manual E2E note, not an automated component test. The review
  allowed "a manual E2E note" for H4.
- **Resumable-stage split (ADR-005)** — C2's checkpoints make a retry not
  re-bill, but a single run still dies if it exceeds the 300s ceiling mid-way;
  C3's concurrency + the 40-candidate cap are the Phase-1 mitigation, not the
  durable fix. The durable fix is the resumable-stage split, which C2's
  checkpoints now enable.

## 5. Environment and runbook (owner's machine)

- Repo: `c:\Users\test user\documents\mark-it-down` (NOT the pack folder
  `READMAP_COMPLETE_AGENT_BUILD_PACK`, which stays untracked).
- Frontend: `frontend/`, Next 15, runs on port 3001 (3000 is occupied by the
  market-intel suite): `cd frontend && npm run dev -- -p 3001`.
- Converter: `converter/`, Python 3.14 venv, start with
  `powershell -File run-converter-local.ps1` (repo root) — serves
  `127.0.0.1:8000` with `JOB_SIGNING_SECRET` injected from
  `frontend/.env.local`. Pandoc missing locally -> DOCX fails, PDF/PPTX fine.
- `frontend/.env.local` (gitignored) holds: APP_PASSWORD,
  BLOB_READ_WRITE_TOKEN, CRON_SECRET, JOB_SIGNING_SECRET, VERCEL_OIDC_TOKEN,
  GEMINI_API_KEY (newer Google "AQ.A..." key format — valid), and
  MARK_IT_DOWN_BASE_URL=http://localhost:8000. Never print these values;
  presence/format checks only.
- Pip: `--only-binary=:all:` (enforced by converter/.venv/pip.ini). npm:
  `--ignore-scripts` if installing.
- E2E reproduction (§3 task 4): two terminals — converter (`run-converter-local.ps1`)
  and frontend (`npm run dev -- -p 3001`). Upload a real PDF at
  `http://localhost:3001/readmap`. Watch: (a) the status poll no longer looks
  stuck (H1); (b) the first Gemini call does not 400 (M5); (c) VERIFYING
  finishes inside the ceiling on a non-trivial document (C3); (d) the result
  renders the coverage line, read/skip guide, rememberThese, and the evidence
  drawer resolves (H4); (e) the depth slider moves with zero network calls.
  Capture any reader-facing error. The first live run is also the first time
  M2 is likely to surface — if the compressor fails to nest, see §4.

## 6. Cost ledger and session log

- Cost: one npm dependency (`zod`, MIT) in Phase 1 so far; **zero model tokens
  ever spent** (all tests offline). First live calls happen in the pending E2E.
- Session log: Phase 0 `790bb53`; increments 1-5 `8a55fb7`...`4a5a49e`;
  acceptance-offline `da40c75`; local runbook `8ee73fb`; fail-fast `f115afc`;
  M5 + review `948803e`; remediation `473b384`/`f000512`/`e417258`/`7cafe3f`/
  `07b41de`/`cd7e872`; this handoff `(this commit)`.
