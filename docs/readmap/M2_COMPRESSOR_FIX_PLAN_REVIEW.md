# Review: M2_COMPRESSOR_FIX_PLAN.md

_Status: review report for `docs/readmap/M2_COMPRESSOR_FIX_PLAN.md`. Written 2026-09-17. Branch `feature/readmap-mvp`._

All file references use the real on-disk paths (under `frontend/`) so a reviewer can jump to them directly. Every claim was checked against the current working tree; the full suite was executed (205/205 pass, 22 files) and `git log` confirms the stated prior commit.

---

## Overall verdict

**Approve with corrections.** The diagnosis is correct and the proposed fix (have the model rank + render, then assemble the six nested tiers in code from prefixes of one ranked list) is the right one: it makes the two observed failure modes impossible by construction and keeps the assertions as defence-in-depth. The plan accurately describes the current code. The main thing to fix before implementation is risk #4: the checkpoint/key mechanics are misstated, and as written the prompt bump alone would NOT re-bill the compressor (a stale cached v1 result would be reused). A few smaller corrections round it out.

---

## Verified accurate (no change needed)

### Current compressor design - confirmed

- `frontend/lib/readmap/agents/compressor.ts:53-84` - `runCompressor` asks the model to return `CompressedTiersV1` (six tier arrays of `{signalId, text}`) and runs `assertTierNesting` then `assertSelectionsResolve` after the model call. So the model does both jobs at once (select which signals per tier + render each), exactly as the plan describes.
- `frontend/lib/readmap/prompts/compressor.ts:8-18` - the prompt tells the model to "select and concisely render verified signals for every reading-depth tier" and that "the tiers must nest." Confirmed.

### The two post-checks exist where cited - confirmed

- `frontend/lib/readmap/agents/contract.ts:92-117` - `assertTierNesting` enforces `ONE_THING ⊆ ... ⊆ DEEP_DIVE`, exactly one in ONE_THING (line 101-104), and no duplicates inside a tier (line 98-100).
- `frontend/lib/readmap/agents/compressor.ts:37-51` - `assertSelectionsResolve` throws `AgentContractError: tier <name> selects <id>, which is not a verified signal` - matching the plan quoted failure #2 verbatim.

### Grounding gate re-runs assertTierNesting - confirmed (exact line)

- `frontend/lib/readmap/grounding/grounding-gate.ts:144` - `assertTierNesting(input.tiers)` inside `checkTierRenderings`, wrapped in try/catch that emits a `TIER_NESTING` gate failure. The plan line reference is exact.

### Fatal path - confirmed

- The compressor assertions throw inside `runCompressor` `.then()` (compressor.ts:80-81). That throw propagates through `cachedUnit` to the COMPRESSING stage, caught by the pipeline catch at `frontend/lib/readmap/orchestration/pipeline.ts:689`, which publishes `FAILED` (line 693). Confirmed: the failure kills the job and is not repairable.

### Prompt version - confirmed

- `frontend/lib/readmap/prompts/compressor.ts:6` - currently `COMPRESSOR_PROMPT_VERSION = "compressor.v1"`. A grep shows this is the only `compressor.v1` literal in source (the other hits are this plan doc). So the v1 to v2 bump is genuinely pending future work here (unlike the PDF plan where v2 was already in the tree).

### Depth slider has six stops - confirmed

- `frontend/components/readmap/CompressionControl.tsx:35-46` - `<input type="range" min={0} max={COMPRESSION_TIERS.length - 1} step={1}>` with `COMPRESSION_TIERS` being the six names. The target sizes 1/3/6/12/20/all map onto these six stops. `DEFAULT_PRESET = "READMAP"` (`frontend/lib/readmap/orchestration/pipeline.ts:58`), i.e. the size-20 stop.

### Current-state claims - confirmed

- `git log --oneline` shows `dbe1f9d READMAP: make PDFs analysable by anchoring sections to pages` - the PDF fix is committed, matching the plan.
- `git status` shows a clean working tree (only untracked `docs/readmap/M2_COMPRESSOR_FIX_PLAN.md` and `READMAP_COMPLETE_AGENT_BUILD_PACK/`) - matching "the working tree is clean."
- Full suite executed: 205/205 pass across 22 test files - matching "the suite is at 205 tests."

### Prefix construction guarantees nesting - sound

- Building every tier as a prefix of one ranked list makes `ONE_THING ⊆ ... ⊆ DEEP_DIVE` hold by construction; `ONE_THING = rank[0..1)` is always exactly one; every id is a real verified id copied by code. The two observed failures (drop, merge) become impossible. Keeping `assertTierNesting` / `assertSelectionsResolve` as post-checks is correct defence-in-depth.
- `CompressedTiersV1` shape is at `frontend/lib/readmap/schemas/signal.ts:147-157`; keeping it as the built/internal type while adding a new model-output schema is a clean split.

---

## Corrections / things to fix in the plan

### C-1 - Risk #4 is wrong: the prompt bump alone does NOT re-bill the compressor (most important)

The plan says: "Prompt version bump (compressor.v1 to v2) changes the compressor checkpoint key; an in-flight retry re-bills the compressor once." That is not how the checkpoint key works.

- `frontend/lib/readmap/orchestration/stages.ts:24-26` - `deriveStageKey` returns `<checksumSha256>:<PIPELINE_VERSION>:<stage>:<unitId>`. The version in the key is the SINGLE global `PIPELINE_VERSION = "readmap-pipeline.v1"` (stages.ts:13), whose comment says it is "Bumped whenever prompt/schema versions move, invalidating old checkpoints."
- The per-prompt `COMPRESSOR_PROMPT_VERSION` does NOT enter the key. The compressor key is `<checksum>:readmap-pipeline.v1:COMPRESSING:whole` regardless of compressor.v1 or v2.
- `frontend/lib/readmap/orchestration/pipeline.ts:594-614` - `compressorKey` is derived from `deriveStageKey` and passed to `cachedUnit`; a checkpoint hit reports ZERO usage and skips the model call entirely.

Consequence: if you only bump `COMPRESSOR_PROMPT_VERSION` to `compressor.v2`, a retried run on the same document HITS the cache and reuses the OLD v1 `CompressedTiersV1` result. The v2 model call never runs. The plan stated effect ("re-bills the compressor once") does not happen.

To actually invalidate the compressor cache you must do one of:
1. Bump `PIPELINE_VERSION` (e.g. to `readmap-pipeline.v2`) - simplest, matches the documented design. Cost: it invalidates EVERY stage checkpoint (mapper, extractor, skeptic, compressor, grounding), so the next run re-bills the whole pipeline once, not just the compressor. State this blast radius honestly.
2. Fold the per-stage prompt version into `deriveStageKey` (a code change to `StageKeyInput` / `deriveStageKey`) so a compressor-only bump invalidates only the compressor cache. More surgical, but it is a change to the shared stage-key contract and its tests.

Either is defensible; pick one and rewrite risk #4 to reflect it. Also add a test that a prompt-version bump actually invalidates the relevant cache entry (the existing checkpoint test at `frontend/lib/readmap/orchestration/pipeline.ts` / `start-route.test.ts` only covers same-version reuse).

### C-2 - Risk #5 mischaracterizes the eval scorer

The plan lists `evals/deterministic-scorer.ts` as a downstream consumer of `CompressedTiersV1` and says to verify the scorer nesting check still passes. The scorer is NOT a direct consumer of `CompressedTiersV1`:

- `frontend/lib/readmap/evals/types.ts:41-50` - `ReadMapEvalOutput.tiers` is `Record<CompressionTier, string[]>` - arrays of signal-id STRINGS, not `TierEntry[]`.
- `frontend/lib/readmap/evals/deterministic-scorer.ts:125-127` - the nesting check is `shorter.every((signalId: string) => longer.has(signalId))` over those string arrays, i.e. a signalId subset check. It never sees `TierEntry` objects or renderings.
- The repo eval test builds tiers directly as string arrays via `nestedTiers()` (`frontend/lib/readmap/evals/evals.test.ts:28-37`); there is no in-repo `CompressedTiersV1` to `ReadMapEvalOutput` adapter to break.

So the conclusion (scorer keeps passing) is right, but the reasoning should be: the scorer is unaffected as long as whatever produces `ReadMapEvalOutput.tiers` keeps extracting `entry.signalId` from the (unchanged) `CompressedTiersV1` shape. Reword risk #5 to point at that adapter boundary, not at the scorer itself.

### C-3 - Eval test tier sizes differ from the proposed policy (note, not a conflict)

`frontend/lib/readmap/evals/evals.test.ts:28-37` `nestedTiers()` builds prefixes of sizes 1/2/3/4/5/all, NOT the plan proposed 1/3/6/12/20/all. This is fine - the test only asserts the subset invariant, which is size-agnostic - but add a line in the plan noting the test helper sizes are illustrative and deliberately decoupled from the production policy, so a reader does not assume they must match or that changing policy breaks the eval test.

### C-4 - State the ONE_THING == thePoint coherence win explicitly

The plan does not mention how `thePoint` is chosen. `frontend/lib/readmap/orchestration/pipeline.ts:224-226` takes `readTier = tiers.tiers[DEFAULT_PRESET]` (the READMAP tier, size 20) and picks the first usable entry as the headline. Under deterministic prefixes, READMAP = rank[0..20), so its first usable entry is rank[0] = the ONE_THING signal. Because the compressor only ever receives usable signals (`pipeline.ts:593` `usable = signals.filter(isUsableSignal)`, passed at `pipeline.ts:604`), rank[0] is always usable, so `thePoint` and ONE_THING automatically coincide. That is a real consistency improvement over the old design (where the model could pick different signals for ONE_THING vs thePoint). State this in the plan and add a test asserting `thePoint.signalIds[0] === tiers.tiers.ONE_THING[0].signalId` so a future refactor does not desync them.

### C-5 - Label the fallback as correctness-preserving, not quality-preserving

The plan fallback ("if too few valid ids survive, fall back to ranking by the pipeline existing signal order so a result still ships") is good for reliability, but the pipeline signal order is the extractor assignment order (s0001, s0002, ...) - insertion order, not importance. So the fallback ships a valid, nested, but possibly mis-ranked result. Say this plainly: the fallback preserves correctness (nesting, verified ids, one in ONE_THING) but not ranking quality, and consider emitting a visible warning via the compressor warnings / `extraWarnings` channel when it engages so the degradation is observable, not silent (rule 18: a quality improvement must not override honesty, and a silent downgrade is the opposite).

### C-6 - Note the gate does not re-run assertSelectionsResolve

The plan says keep both assertions as defence-in-depth. Worth noting: the grounding gate re-runs ONLY `assertTierNesting` (`grounding-gate.ts:144`), not `assertSelectionsResolve`. So the "unknown signal id" class is caught only at the compressor unit (compressor.ts:80-81), not at the gate. After the fix that class is impossible by construction, so this is fine - but the plan should state it so the reviewer knows the gate does not independently re-check id resolution for tiers (the gate does check id resolution for CLAIMS separately, via its own `UNKNOWN_SIGNAL` checks, which is unaffected).

---

## Process / acceptance criteria

- The test plan (plan lines 118-131) is appropriate: pure `buildTiers()` unit tests plus a model-facing test that scripts a malformed id and asserts a valid nested result. Add the C-4 coherence test and a C-1 cache-invalidation test.
- The full gate (frontend `npm test` + typecheck + lint; backend tests; container build; DOCX/PPTX/PDF smoke tests) matches repo `AGENTS.md`. The plan already lists these.
- The plan proposes re-running the live PDF E2E a few times to confirm the post-fix rate is 0. Good, but note the failure was ~1-in-10 on dense documents, so a few runs is a weak signal; reuse the deleted probe approach (or a scripted N-run harness) on a dense 38-signal-class fixture to measure the rate with enough runs to be meaningful.

---

## Suggested next action

Implement in this order: (1) decide the cache-invalidation approach per C-1 and wire it (bump `PIPELINE_VERSION` or extend `deriveStageKey`), with a test; (2) add the new model-output schema in `frontend/lib/readmap/schemas/signal.ts`, rewrite `frontend/lib/readmap/prompts/compressor.ts` to rank+render at v2, add `buildTiers()` in `frontend/lib/readmap/agents/compressor.ts` with the sanitisation/fallback; (3) add the unit + coherence tests; (4) run the full gate (frontend tests, backend tests, typecheck, lint, container build, DOCX/PPTX/PDF smoke tests) and a measured dense-document E2E.
