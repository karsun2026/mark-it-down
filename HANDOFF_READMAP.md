# Handoff — READMAP build session, 13 September 2026

This is the running handoff for the READMAP work on branch
`feature/readmap-mvp`. The original converter handoff is `HANDOFF.md`
(2 September 2026); this file picks up where that one ended. Keep it updated
after every meaningful task — it is the chat-history-free record for whoever
continues the build.

## Where things stand

| Item | State |
|---|---|
| Branch | `feature/readmap-mvp`, pushed to origin, PR open against `main` |
| `main` | Untouched at 86feb79 — **pushing it deploys the converter to production** |
| Commits | 790bb53 Phase 0 close-out · 8a55fb7 Phase 1 increment 1 · this commit: handoff |
| Controlling spec | `READMAP_MASTER_BUILD_SPEC.md` (repo root); audit and decisions in `docs/readmap/` |
| Live code | Evidence layer only. No routes, no UI, no model calls yet — nothing user-facing |
| Converter | **Frozen.** Zero modifications; its guarantees and tests are unchanged |

## What this session established

1. **Phase 0 audit complete** (2026-09-13): `docs/readmap/IMPLEMENTATION_STATUS.md`,
   `ARCHITECTURE_DECISIONS.md` (ADR-001…007), `PHASE_1_IMPLEMENTATION_PLAN.md`
   with exact acceptance checks. Verdict at close: all four owner questions resolved.
2. **Owner decisions** (2026-09-13):
   - ADR-001 approved — the zero-AI rule applies to the converter only
     (`DEVIATIONS.md` D-016 records the charter change).
   - ADR-004 approved — Vercel Blob JSON artifacts for Phase 1; no database.
   - ADR-006 update — **Gemini only**; Perplexity excluded (search-grounded).
   - ADR-007 approved — READMAP is built in this repository; the market-intel
     suite links to it via a second "Other Useful Stuff" tile (suite-side,
     link-only change, done at integration time).
3. **Build-pack control files** copied into the repo root: the master spec,
   `.clinerules/readmap.md`, `prompts/`, `readmap-eval-harness/`.
4. **Phase 1, increment 1 shipped**: the deterministic evidence layer —
   `frontend/lib/readmap/schemas/evidence.ts` (Zod `ConvertedDocumentV1`
   contract) and `frontend/lib/readmap/ingestion/segment.ts` (Markdown →
   page/slide-anchored evidence blocks), with 13 tests pinning them to the
   converter's real output grammar. Frontend suite: **89/89 pass**
   (76 existing — no regressions — + 13 new); typecheck clean.

## API keys (the question everyone asks next)

- Phase 1 uses **Gemini only** (Anthropic remains an optional adapter per the
  spec; Perplexity is excluded from agent roles — its API is search-grounded
  and could import outside facts, violating "the uploaded document is the
  only source of truth").
- The owner approved sharing the MarketIntel-site Gemini key with this
  project. A **separate key is still recommended** so either project can be
  rotated without touching the other; swapping later is a one-line env change.
- Where values live, and only there: `frontend/.env.local` (local dev,
  gitignored) and this Vercel project's Environment Variables (deployment).
  Variable names are listed in the commented READMAP section of
  `.env.example`; **values are never committed or pasted into chat**.

## How to run the checks

```bash
# Frontend (evidence layer included)
cd frontend && npm run typecheck && npm run test

# Python converter suite (unchanged; run at Phase 1 exit)
cd converter && ./.venv/Scripts/python.exe -m pytest ../tests/converter -q
```

npm installs must use `--ignore-scripts`. pip installs must use
`--only-binary=:all:` (enforced by `converter/.venv/pip.ini` — see the
rustup/EDR incident in `HANDOFF.md` for why this is non-negotiable).

## What's next, in order

1. Model client layer (`frontend/lib/readmap/models/`): Gemini adapter over
   plain `fetch`; a clearly-labelled dev adapter that fails closed outside
   `APP_ENV=development`.
2. Agent skeletons — Mapper, Signal Extractor, Skeptic, Compressor — with
   Zod contracts and versioned prompts under `frontend/lib/readmap/prompts/`.
3. Grounding gate: citation resolution, tier nesting, interpretation
   separation (numeric checks land in READMAP Phase 3).
4. Routes (`frontend/app/api/readmap/*`) and UI (`frontend/app/readmap/`,
   `frontend/components/readmap/`) — every route calls `requireSession`.
5. Eval-harness wiring + the full acceptance-check run from
   `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md` §9 (including the 336
   Python tests and the production build). Then the independent Phase 1
   review (`prompts/02_REVIEW_PHASE_1.md`) before Phase 2 is even discussed.

## Things that will bite you

- **Never push `main`** — it deploys the converter to production. All READMAP
  work stays on `feature/readmap-mvp` until the PR is reviewed and merged
  deliberately.
- The converter's Markdown grammar (`## Page N`, `## Slide N — Title`, DOCX
  headings-only) is a pinned contract: `frontend/lib/readmap/ingestion/segment.test.ts`
  fails loudly if it ever changes.
- Model-call code must never log evidence text, quotes, keys, or prompts
  (`.clinerules/readmap.md` rule 16); structured events carry ids/counters only.
- No OCR or vision in Phase 1, and no pretence of it in any state the user
  can see (rule 24). Scanned PDFs surface as converter warnings → coverage
  limitations, never confident summaries.
- Compression tiers are precomputed; moving the depth slider must never
  trigger a model call.

## Cost ledger

- This session: one npm dependency added (`zod`, MIT). **Zero model calls so
  far — zero AI tokens spent.** First token-bearing calls happen when the
  model client layer is wired and exercised.

## Session log

| Date | What | Commit |
|---|---|---|
| 2026-09-13 | Phase 0: audit docs, owner decisions, charter scoping (D-016), control files | 790bb53 |
| 2026-09-13 | Phase 1 increment 1: evidence schemas + segmenter + 13 tests (89/89 green, typecheck clean) | 8a55fb7 |
| 2026-09-13 | Session handoff document; branch pushed; PR opened | (this commit) |