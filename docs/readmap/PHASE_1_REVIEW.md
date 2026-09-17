# READMAP Phase 1 — Independent Acceptance Review

**Reviewer role:** skeptical senior engineer, no prior context.
**Date:** 2026-09-17
**Branch reviewed:** `feature/readmap-mvp` (`git diff main..feature/readmap-mvp`, 25 commits).
**Brief:** `prompts/02_REVIEW_PHASE_1.md`.
**Question:** does the implementation genuinely execute
`structure -> extract -> challenge -> verify -> rank -> compress -> cite`,
and does it meet the Phase-1 exit bar (one document end-to-end; **every claim
opens valid evidence**; honest partial output; no OCR/vision pretence)?

---

## 1. Test results actually run this session

| Check | Command | Result |
|---|---|---|
| Frontend typecheck | `cd frontend && npm run typecheck` | **PASS** (clean) |
| Frontend unit/integration | `cd frontend && npm test` | **PASS — 211/211** (23 files) |
| Frontend lint | `cd frontend && npm run lint` | **PASS** (eslint, no findings) |
| Python converter suite | `PYTHONPATH=converter ./converter/.venv/Scripts/python.exe -m pytest tests/converter -q` | **PASS — 336/336** |
| Deploy gate | `scripts/deploy-gate.sh` | Not run to completion; container step SKIPs when Docker is absent (script exits 2 = INCOMPLETE by design). Frontend/backend steps mirror the four above. |
| Eval harness | `frontend/lib/readmap/evals/evals.test.ts` (part of `npm test`) | PASS — but see HIGH-1 / MEDIUM-1: it scores hand-authored outputs, not the real pipeline. |
| E2E / live model (plan §9 check 11) | — | **Never run** (offline review, no credentials). This is where both blockers below would have surfaced. |

The offline suites are genuinely green. **The green suites do not cover the two
broken paths below**, because no test round-trips the persisted artifacts
through the read routes and no test exercises the real `start -> segment`
wiring. Both are exactly the checks the skipped E2E (plan §9 check 11) would
have caught.

## 2. Pipeline shape — the good news

The intended sequence is real, not a disguised one-shot summarizer:

- Distinct agents with separate prompts/schemas/inputs: mapper, signal
  extractor, skeptic, compressor (`frontend/lib/readmap/agents/*`). No hidden
  "one big prompt" path exists (failure mode 1 — clear).
- Signal identity is pipeline-assigned, never model output
  (`agents/signal-extractor.ts:35`), so citations resolve against a fact the
  code controls (failure mode 2/3 — clear at the contract level).
- The skeptic is a **separate** agent that receives only one candidate + its
  cited evidence + bounded nearby context (`agents/skeptic.ts:30-101`), not the
  model grading its own extraction — rule 14 is honoured in structure.
- Interpretation is a separate output kind; `assembleReadmap` never emits an
  `interpretation` field and the gate rejects non-`VERIFIED` kinds in factual
  fields (`grounding/grounding-gate.ts:199-206`) — failure mode 7 clear.
- Evidence snapshot is persisted **before** any model call
  (`orchestration/pipeline.ts:474-477`); pinned by test
  (`pipeline.test.ts:210-217`).
- Numeric independent validation (§11.4) is explicitly deferred and cannot
  silently pass (`grounding/numeric-guard.ts:19`, gate `deferredChecks`);
  numbers are labelled "not independently verified" in the UI
  (`components/readmap/ReadmapResult.tsx:117`) — failure mode 5 handled honestly.
- No document content, keys, or signed URLs are logged anywhere in
  `frontend/lib/readmap/**` or `frontend/app/api/readmap/**` (grep: zero
  `console.*`); the Gemini adapter emits shape-only errors and puts the key in a
  header (`models/gemini.ts:13-17,226-265`) — failure mode 14 clear.
- Dev adapter is genuinely fail-closed on `READMAP_MODEL_PROVIDER=dev` **and**
  `APP_ENV=development`, re-checked per call, and never fabricates output
  (`models/dev-adapter.ts:49-77`) — failure mode 10 clear for the adapter.

The problems below are integration/wiring and coverage-honesty defects, not a
collapse of the pipeline.

---

## 3. Findings

### BLOCKER-1 — The evidence drawer cannot resolve any signal in the real flow (defeats the Phase-1 exit criterion)

**Evidence.**
- The pipeline persists `signals.v1.json` as a **bare array**:
  `orchestration/pipeline.ts:586-589`
  (`const signals: VerifiedSignalV1[] = ...; await persist(..., "signals.v1.json", signals)`).
  The start route forwards the value unchanged
  (`app/api/readmap/start/route.ts:173-186`).
- The evidence route reads it as a **wrapped object** and dereferences
  `.signals`:
  `app/api/readmap/evidence/[signalId]/route.ts:61-62`
  ```ts
  const store = await getReadmapArtifact<{ signals: VerifiedSignalV1[] }>(signalsPath);
  const signal = store?.signals.find((candidate) => candidate.id === signalId);
  ```
  At runtime `store` is the array, `store.signals` is `undefined`, and
  `undefined.find(...)` throws an unguarded `TypeError` → HTTP 500.

**Consequence.** Every "source" click in the results UI
(`ReadmapResult.tsx` → `fetchEvidence`) 500s. Spec §2 step 10 and the Phase-1
exit bar — *"every claim opens valid evidence"* (spec §21, plan §8) — is not
met in a real deployment. This is invisible to the suite: there is **no
evidence-route test** (only `start-route.test.ts` and `route-access.test.ts`),
and the pipeline tests use a `persistArtifact` stub that records names but never
round-trips the shape.

**Smallest correction.** Make writer and reader agree on one shape. Least code:
in `evidence/[signalId]/route.ts` treat the artifact as the array it is —
`const signals = (await getReadmapArtifact<VerifiedSignalV1[]>(signalsPath)) ?? []; const signal = signals.find(...)`.
Then add a route-level test that resolves a signal through the real artifact
JSON so the contract is pinned.

### BLOCKER-2 — Converter warnings and true page count are never wired in; coverage honesty is defeated in the shipped path

**Evidence.**
- The conversion flow surfaces converter warnings
  (`lib/convert-client.ts:78-86,271-283,420-429` — `ConversionOutcome.warnings`),
  but `runReadmapFlow` **discards them** and never sends a page count:
  `lib/readmap/readmap-client.ts:126-132,153-157` destructures only
  `{ jobToken, resultPathname }` and POSTs `start` with just
  `{ jobToken, resultPathname, originalFilename }`.
- The start route calls segmentation **without** converter warnings and with a
  body `pagesOrSlides` that the client never sends (so always `null`):
  `app/api/readmap/start/route.ts:155-160`.
- With `pagesOrSlides === null`, `assembleReadmap` sets
  `totalPages = readablePages = <distinct anchor values that produced blocks>`,
  so `ratio` is a tautological **1.0**: `orchestration/pipeline.ts:264-268`.
  Segmentation's own page-mismatch warnings are also gated on
  `pagesOrSlides !== null` (`ingestion/segment.ts:224-236`) and therefore never
  fire.

**Consequence.** A partially-unreadable document — e.g. a 10-page PDF whose
pages 6–10 are scanned, for which the converter emits per-page
*"Page N may be scanned…"* warnings and produces blocks only for pages 1–5 —
is presented as **"Covered 5/5 pages · 100%"**, `READY`, with no limitation
(`ReadmapResult.tsx:28-43` only shows the notice when `PARTIAL_READY` with
warnings). This is precisely the "confident full-document summary when part was
unreadable" that spec §3 principle 7 forbids, and it violates plan §8's explicit
Phase-1 requirement that the converter's scan warning *"must surface as a
coverage limitation."* Failure mode 13.

The passing acceptance evidence is misleading: `pipeline.test.ts:411-457`
(plan check 12) only works because it **hand-injects** both
`warnings: [SCAN_WARNING]` and `pagesOrSlides: 2` into the document — neither of
which the real client/route path provides. The mechanism exists end-to-end in
the types; it is simply never connected.

**Smallest correction.** Thread the two values that already exist: have
`runReadmapFlow` pass `outcome.warnings` and the converter's page count to
`/api/readmap/start`, and have the start route pass them into
`segmentDocument({ ..., converterWarnings, pagesOrSlides })`. (The converter's
page count is available via its status/response; if not plumbed, derive
`totalPages` from it rather than from the recovered anchors.)

### HIGH-1 — The Phase-1 acceptance run is incomplete and overstates readiness

**Evidence.** `IMPLEMENTATION_STATUS.md` "Phase 1 acceptance run" marks checks
8 (citation resolution) and 12 (scanned honesty) as satisfied, but both are
unit-level: the real citation-resolution path is broken (BLOCKER-1) and the real
coverage path is broken (BLOCKER-2). Check 11 (E2E: evidence drawer opens the
cited block; depth slider makes no fetch; refresh preserves state) and any live
model call are recorded as **not run** — that is the exact gap that hides both
blockers. The injection suite (`evals/evals.test.ts`) proves only that the
deterministic **scorer** flags hand-authored "obeying" outputs; the real agents'
resistance to embedded instructions (spec §17) is unexercised (failure modes 8
& 12). The status file itself concedes "No live model call has ever been made."

**Consequence.** "Phase 1 acceptance run" reads as near-complete when the two
hardest guarantees (evidence resolution, coverage honesty) are unverified in the
real path and in fact broken. Failure mode 10 (mocks/tests that appear
operational) applies at the acceptance-report level.

**Smallest correction.** Do not treat checks 8/11/12 as passed until they run
against the real routes (dev adapter is sufficient, no live tokens needed): one
end-to-end run through `start` → `status` → `result` → `evidence` on a
text-native fixture, plus a partial-coverage fixture.

### MEDIUM-1 — Segmentation tests pin a hand-copied grammar, not the converter's real output

**Evidence.** `ingestion/segment.test.ts:17-55` uses inline string literals that
"mirror" the converter grammar. Plan §9 check 5 and `IMPLEMENTATION_STATUS.md`
state the tests are "pinned against `tests/converter/fixtures/generated/`
outputs" / "the converter's real output grammar," but no generated fixture is
imported.

**Consequence.** If the converter's Markdown grammar drifts (e.g. the `## Page N`
or `## Slide N — Title` shape changes), these tests keep passing against the
stale copy — the opposite of the "fail loudly" claim in the file header.
Failure mode 12.

**Smallest correction.** Load one real generated fixture from
`tests/converter/fixtures/generated/` and segment it, asserting the anchor/block
invariants against actual converter output.

### MEDIUM-2 — No idempotency lock for concurrent/duplicate start requests

**Evidence.** The reuse branch (`start/route.ts:117-136`) and per-unit
checkpoints (`pipeline.ts:405-436`) only help **after** a prior run has
persisted results. Two simultaneous `start` POSTs for the same job both fall
through to a full pipeline run and both bill; nothing serializes them. The
documented durability limitation covers only the "route dies mid-analysis" case,
not concurrency.

**Consequence.** Double-submit (or a client retry before the first completes)
re-bills the whole analysis. Failure mode 11. `checkConversionRateLimit`
mitigates volume but does not make the operation idempotent.

**Smallest correction.** Take a best-effort lease (a `readmap/lock` blob with
`allowOverwrite:false`, or check `status.v1.json` for an in-flight stage) before
running, and attach to / short-circuit the in-flight job.

### MEDIUM-3 — Coverage ratio is structurally incapable of dropping below 1 without an externally supplied page count

**Evidence.** `assembleReadmap` (`pipeline.ts:257-268`) divides the count of
distinct anchor values that produced blocks by that same count when
`pagesOrSlides` is absent. This is the root cause under BLOCKER-2, but is worth
recording as a design point: even with warnings forwarded, interior/trailing
pages that produced no blocks are undetectable without the converter's true page
count.

**Smallest correction.** Always derive `totalPages` from the converter's
reported page count; treat "an anchor is missing between 1..totalPages" as lost
coverage.

### LOW-1 — Mapper section validation accepts any substring match

`agents/mapper.ts:64-76` (`anchorForHeading`) resolves a model-named section to
the first block whose `normalizedText` merely *contains* the heading string,
then rebinds the section to that block's anchor. A common word ("growth")
"validates" and binds to some page. Structure is only loosely grounded; the
`actuallyRead`/`safelySkip` page ranges are still range-checked by the gate
(`grounding-gate.ts:106-135`), so this is a quality issue, not a false citation.

### LOW-2 — `thePoint` fallback cites an unrelated signal for a non-factual placeholder

`pipeline.ts:306-308`: when no tier entry cites a usable signal but some usable
signal exists, `thePoint` renders the literal string "No core conclusion could
be verified." while citing `usable[0].id` — a status message pinned to an
arbitrary, unrelated signal. Rare in practice (tier entries are drawn from the
usable set) but sloppy; prefer the empty-signalId path (which fails the job
honestly) or a clearly non-cited empty state.

### LOW-3 — Evidence access is job-token-scoped, with no per-user ownership

`lib/readmap/route-access.ts` authorizes on the conversion job's HMAC token +
path binding + `requireSession` (shared password). Anyone holding a valid job
token and result path can read the evidence. This is **documented and deferred**
(spec §25; plan §11 item 6), so it is informational for Phase 1, not a new gap.
Authorization endpoints are otherwise sound: server-side signal resolution, no
client-supplied blob path, signalId regex-guarded (`evidence/[signalId]/route.ts:34-36`).

### LOW-4 — "Exactly one repair attempt" can be up to three model round-trips

`models/gemini.ts:317-335` retries once in mime-type-only mode on an HTTP-400
`responseSchema` rejection, then still allows the one schema-repair turn
(`:358-399`), and each `callOnce` may itself retry once on 429/503. The spec §10
"one repair attempt" invariant (about schema repair) is preserved, but the
worst-case call count per unit is larger than the wording implies. Bounded cost;
no correctness impact.

---

## 4. Failure-mode scorecard (brief §20)

| # | Failure mode | Verdict |
|---|---|---|
| 1 | Hidden one-shot summarization path | Not present |
| 2 | Invented/display-only citations | Not present (ids pipeline-assigned; gate resolves) |
| 3 | Claims not linked to immutable evidence | Structurally sound, **but BLOCKER-1 makes evidence unreachable at runtime** |
| 4 | Verification via self-critique | Not present (separate skeptic agent) |
| 5 | Numeric claims bypassing validation | Handled honestly (deferred + labelled) |
| 6 | Tiers regenerated from prose | Not present (tiers built in code from verified ids; M2 fix sound) |
| 7 | Interpretations as facts | Not present |
| 8 | Prompt-injection exposure | **Untested against real agents** (HIGH-1) |
| 9 | Authorization gaps in evidence endpoints | None beyond documented shared-token model (LOW-3) |
| 10 | Mocks that appear operational | Dev adapter fine; **acceptance report overstates (HIGH-1)** |
| 11 | Retries/races/duplicate jobs/non-idempotent | **Concurrent duplicate start re-bills (MEDIUM-2)** |
| 12 | Tests verifying execution not invariants | **Segmentation & injection tests (MEDIUM-1, HIGH-1)** |
| 13 | Unreported low document coverage | **BLOCKER-2** |
| 14 | Logged document contents or secrets | Not present |

---

## 5. Verdict

Two independent defects each defeat a hard Phase-1 exit criterion in the real
(non-test) path — the evidence drawer cannot resolve a single signal
(BLOCKER-1), and a partially-unreadable document is presented as fully covered
with no limitation (BLOCKER-2) — and both are masked by an acceptance run whose
E2E was never executed. The underlying pipeline architecture is honest and
largely well-built; these are fixable wiring/coverage defects plus a set of
test-fidelity gaps. But as it stands the branch does not meet the Phase-1 bar.

**PHASE 1 REJECTED**
