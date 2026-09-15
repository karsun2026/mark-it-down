# READMAP Phase 1 — Code Review

**Reviewer:** Claude (Opus 4.8), independent read of branch `feature/readmap-mvp`
**Date:** 2026-09-15
**Scope:** the READMAP vertical slice — `frontend/lib/readmap/**`, `frontend/app/(api/)readmap/**`,
`frontend/components/readmap/**`, and the integration points in `frontend/lib/{blob,convert-client,filename}.ts`.
The converter (`converter/**`) was treated as frozen and not re-audited.
**Nature of this pass:** static review only. No code was changed, no tests run, no tokens spent.

---

## 1. Verdict

The skeleton is genuinely good: clean provider-neutral model contract, a deterministic
grounding gate, honest fail-closed model config, evidence-before-model-calls ordering,
and disciplined "no document text in logs". The offline test suite is real.

But the owner's "not good enough" judgment is correct, and the reasons are concrete and
findable in the code — they are **not** mysterious. There are three classes of problem:

1. **Two headline honesty claims are false in the code** — "idempotent retries never
   re-bill" (the reuse branch is dead code; idempotency keys are computed but never
   consulted).
2. **The live experience is broken twice over** — the results/processing UI is
   effectively unstyled (CSS classes defined nowhere), and the analysis wait screen has
   no real progress; plus a reintroduced CDN-cache bug that makes status polling look
   stuck (the exact D-005 failure the converter already solved).
3. **The pipeline shape will not survive a real document** — the whole analysis runs
   synchronously in one function with one sequential model call per candidate (up to
   100), so it will exceed the 300 s ceiling on anything non-trivial.

None of these is fatal to the design. All are fixable within the Phase-1 architecture.
This report ranks them so the next session fixes the E2E blocker and the credibility
gaps first.

---

## 2. How this maps to the handoff's own open issues

`HANDOFF_READMAP.md` already flags the untested Gemini adapter (§6.1), the synchronous
long pipeline (§6.2), missing checkpoint persistence (§6.3), the numeric/prompt-quality
gaps, and the polling client (§6.6). This review **confirms those and adds specifics**,
plus finds issues the handoff did **not** call out:

- The idempotent-reuse branch is **dead code** (new — C1).
- The status CDN-cache flag is **inverted**, reintroducing D-005 (new — H1).
- The results/processing UI is **unstyled** — classes exist in no CSS file (new — H2).
- Core spec §12 features (read/skip guide, rememberThese, document shape) are **computed
  but never rendered** (new — H4).
- Numeric guard causes **false-positive** gate failures on normal rewordings (new — M1).

---

## 3. Findings (severity-ranked)

### CRITICAL

#### C1 — The idempotent-reuse branch never runs; every retry re-bills the full pipeline
`frontend/app/api/readmap/start/route.ts:110-120`

```ts
const existing = await getReadmapArtifact<{ readmap: unknown }>(paths["readmap.v1.json"]);
if (existing?.readmap) { /* reuse */ }
```

The pipeline persists the result as the `ReadMapV1` object **directly**
(`orchestration/pipeline.ts:493` → `persist(..., "readmap.v1.json", finalReadmap)`),
and `ReadMapV1` has no `.readmap` property (its fields are `thePoint`, `coverage`, …).
So `existing?.readmap` is **always `undefined`** and the reuse path is dead. Every
re-POST for a completed job re-runs the entire analysis and re-bills it.

This directly contradicts `IMPLEMENTATION_STATUS.md` ("start is an idempotent POST that
re-uses a completed analysis instead of re-billing").

**Fix:** test the stored object itself (e.g. `existing?.thePoint`) or persist a wrapped
`{ readmap, tiers, status }` and read that shape back consistently; return
`PARTIAL_READY` when that is what was stored, not a hard-coded `READY`.

#### C2 — Idempotency keys are computed but never used to skip work
`frontend/lib/readmap/orchestration/stages.ts:24`, `orchestration/pipeline.ts` (all stages)

`deriveStageKey(checksum, PIPELINE_VERSION, stage, unit)` is threaded through every agent
as `idempotencyKey`, but nothing consults a checkpoint store keyed by it: the Gemini
adapter merely echoes the key back (`models/gemini.ts:298`), and the dev adapter only
uses it as a fixture lookup. There is no per-unit result cache. A retried or resumed run
re-executes **every** model call.

ADR-009 and `IMPLEMENTATION_STATUS.md` state this is "enforced in the pipeline before any
model call so a retry does not re-bill." It is not. (The handoff §6.3 concedes "no
checkpoint persistence yet" — so this is a claim/code mismatch, not a surprise, but the
authoritative docs overstate it.)

**Fix (Phase 1, cheap):** before each unit, read a per-unit artifact
(`readmap/units/<key>.json`); if present, skip the call. Combined with C1 this makes
"retry does not re-bill" actually true. **Do not claim it until it is wired.**

#### C3 — The whole pipeline runs synchronously in one request and will time out on real documents
`frontend/app/api/readmap/start/route.ts:40` (`maxDuration = 300`),
`frontend/lib/readmap/orchestration/pipeline.ts:401-423` (VERIFYING),
`orchestration/pipeline.ts:51` (`MAX_CANDIDATE_SIGNALS = 100`)

VERIFYING issues **one sequential Gemini call per candidate signal** (up to 100), on top
of the mapper, N extraction chunks, and the compressor. At even 2-4 s/call this is well
past 300 s for an ordinary report. On Vercel the function is killed; the client's `start`
fetch 504s; the status blob is left mid-stage. This is the most probable first failure
**after** conversion succeeds, and it is the real cost of ADR-002's "minutes of analysis
in one Node function."

**Fix options, in order of preference for Phase 1:**
1. Bound the slice honestly: cap candidates far below 100 for the vertical slice and
   parallelize VERIFYING with a small concurrency limit (e.g. 4-6), so a modest document
   finishes inside the ceiling.
2. Implement the resumable-stage split ADR-005 already anticipates (needs C2's checkpoints
   to avoid re-billing on resume).
3. At minimum, make the failure honest: detect the approaching ceiling and publish a
   `PARTIAL_READY`/`FAILED` status the UI can show, rather than a silent 504.

### HIGH

#### H1 — Inverted CDN-cache flag on status reads reintroduces the D-005 "looks stuck" bug
`frontend/lib/readmap/artifacts.ts:85-100` vs `frontend/lib/blob.ts:145-160`

The converter's convention (established, tested) is `useCache: false` on status GETs to
defeat CDN staleness (`blob.ts:156`, D-005). The READMAP helper does the opposite:

```ts
async function presignedGet(pathname: string, fresh: boolean) {
  ... presignUrl(token, { ..., useCache: fresh, ... })   // fresh===true → useCache:true
}
```

The status route calls `getReadmapArtifact(statusPath, { fresh: true })` **intending to
bypass the cache**, but that yields `useCache: true` (cache **on**). So an overwritten
status blob can serve a stale stage for up to ~60 s — a finished/advancing analysis reads
as stuck. (`fetch(url, { cache: "no-store" })` only affects the undici fetch cache, not
the Vercel CDN edge, so it does not save this.)

This is a strong candidate for part of the "froze" symptom in the handoff §5.

**Fix:** pass `useCache: !fresh` (or invert the parameter and its call sites). Non-status
reads should keep the cache; status must bypass it.

#### H2 — The entire READMAP surface is unstyled: two clashing styling systems, neither present (core of "not good enough")
`frontend/app/globals.css`, `frontend/components/readmap/*`, `frontend/components/readmap/ReadmapApp.tsx`

This is worse than "missing a stylesheet". Two independent problems combine:

1. **The project does not use Tailwind.** `frontend/package.json` has no Tailwind
   dependency and `app/globals.css` is a hand-rolled design system with tokens
   (`--bg`, `--surface`, `--accent`, `.card`, `.overlay`, `.dialog`, `.progress-track` +
   `.progress-fill`, `.error-panel`, `.dropzone`). But `ReadmapApp.tsx` — the shell — is
   written entirely in **Tailwind utility classes** (`mx-auto flex min-h-screen max-w-3xl
   … text-2xl font-semibold … rounded border border-gray-300`). None of those resolve, so
   the shell itself is unstyled.
2. **The child components invented class names that were never added to `globals.css`.**
   `ReadmapResult`, `ProcessingView`, `EvidenceDrawer`, `CompressionControl` use
   `.notice`, `.notice-title`, `.readmap-tier`, `.tier-title`, `.claim-list`, `.claim`,
   `.cite`, `.processing`, `.stage`, `.progress-indeterminate`, `.secondary`,
   `.drawer-backdrop`, `.drawer`, `.drawer-head`, `.claim-text`, `.evidence-list`,
   `.evidence-block`, `.compression-control`, `.depth-label` — a grep across every `*.css`
   returns **zero** matches for all of these. Only `.muted` and `.progress-track` exist;
   and `ProcessingView` even names its inner bar `.progress-indeterminate` while the
   stylesheet defines `.progress-fill[data-indeterminate="true"]`, so the wait bar is
   invisible even where the track isn't.

So a good design system exists and is simply not used. **Fix (see §6-H2):** drop the
Tailwind classes from `ReadmapApp.tsx` and restyle every READMAP component onto the
existing `globals.css` tokens/classes (`.card`, `.overlay`+`.dialog`, `.progress-track`+
`.progress-fill`, `.error-panel`, `button.primary`), and add one CSS block for the
genuinely new READMAP classes. This is likely the single biggest driver of the owner's
verdict and is independent of the pipeline work.

#### H3 — No real progress on a multi-minute wait screen
`frontend/components/readmap/ProcessingView.tsx:21-23`

The wait screen shows a text stage label plus an indeterminate track (which, per H2, is
invisible). The pipeline already publishes `unitsDone`/`unitsTotal` for EXTRACTING and
VERIFYING (`pipeline.ts:395,402,422`) and the client already builds `"(n/total)"` labels
(`readmap-client.ts:169-175`), so a real percentage is available but unused. The owner's
documented wait-screen preference elsewhere in the suite is that a % completion bar is a
must-have, with inspirational copy demoted. Phase 1 should render an actual determinate
bar from the unit counts.

#### H4 — Headline spec §12 features are computed and gated but never shown
`frontend/components/readmap/ReadmapResult.tsx` vs `orchestration/pipeline.ts:143-247`

`assembleReadmap` builds `actuallyRead`, `safelySkip`, `rememberThese`, `documentShape`,
and `coverage`, all pass the grounding gate, and all are persisted — but `ReadmapResult`
renders only the active tier, `numbersWorthRemembering`, and `caution`. The
**"what to read vs. safely skip" reading guide** — a defining READMAP feature, and the
`reading-guide.tsx` component the plan §2 listed — is absent, as are `rememberThese`, the
document-shape overview, and the coverage summary. Phase 1 acceptance check 11 ("READMAP
renders") is only partially satisfiable as built.

### MEDIUM

#### M1 — Numeric guard fails legitimate rewordings (false-positive gate failures)
`frontend/lib/readmap/grounding/numeric-guard.ts:26-46`

`numbersPreserved` requires exact normalized numeric tokens to reappear. Real compressor
output will reword units and separators: `"$1.5bn" → "1.5 billion"`, `"12%" → "12 percent"`,
`"1,000" → "1000"` all fail the check, raising `NUMBER_DROPPED`. Consequence: legitimate
tier entries get dropped by repair-by-omission, and if it lands on `thePoint`, the whole
job FAILs. The comment claims false positives were the thing avoided; the implementation
produces exactly them. **Fix:** normalize numeric *values* (parse magnitude, canonicalize
`bn/billion/m/million/k`, strip thousands separators) before comparing, or restrict this
check to digit-run presence rather than token identity.

#### M2 — Any non-nesting / non-resolving compressor output fails the entire job
`frontend/lib/readmap/agents/compressor.ts:80-81`, `grounding/grounding-gate.ts:137-168`,
`orchestration/pipeline.ts:517-530`

`assertTierNesting` / `assertSelectionsResolve` throw inside the compressor unit → the
pipeline `catch` returns FAILED; and a `TIER_NESTING` gate failure isn't repairable (its
location is `"tiers"`, which `omitGateFailures` can't match) → FAILED. Requiring a model
to emit six perfectly nested tiers (a strict subset chain) with exact verified signal IDs
and preserved numbers, in one shot, is fragile — expect frequent total failures on first
live runs. **Consider** constructing the nested tiers deterministically in code from a
single ranked signal list the model returns, instead of trusting the model to nest.

#### M3 — `thePoint` may cite a non-usable signal → spurious hard failure
`frontend/lib/readmap/orchestration/pipeline.ts:157,234-236`

`rememberThese` filters entries to usable signals, but `thePoint` is taken from
`readTier[0]` without that filter. If the compressor puts a non-usable signal in
`ONE_THING`, the gate raises `SIGNAL_NOT_USABLE` at `thePoint`, which is treated as
unrepairable → the whole job FAILs. Filter `thePoint`'s source the same way, or fall back
to the top usable signal.

#### M4 — "Immutable" artifacts are written with `allowOverwrite: true`
`frontend/lib/readmap/artifacts.ts:72-82`

`putReadmapArtifact` always sets `allowOverwrite: true`, including for `evidence.v1.json`
and `signals.v1.json`, despite the module doc's "written once and never overwritten."
Immutability is convention-only; a re-run overwrites the "immutable" evidence snapshot.
Low blast radius today (same input → same content), but weaker than claimed. Use
`allowOverwrite: false` for the immutable set and `true` only for `status.v1.json`.

#### M5 — Gemini rejects our `responseSchema` on the FIRST real call (CONFIRMED live — effectively a hard E2E blocker)
`frontend/lib/readmap/models/gemini.ts:59-74,227-241`

**Verified against the real Gemini API on 2026-09-15** (`gemini-2.5-flash`, `v1beta`),
not predicted:

- Zod v4's `z.toJSONSchema` emits `"additionalProperties": false` on **every** object.
  Confirmed locally: `z.object({...})` → `{ ..., "additionalProperties": false }`.
- `GEMINI_SCHEMA_KEYS` (gemini.ts:59-74) **keeps** `additionalProperties`, so it is sent.
- A live POST with `additionalProperties` returns **HTTP 400**:
  `Unknown name "additionalProperties" at 'generation_config.response_schema': Cannot find field.`
- A live POST with `prefixItems` (Zod emits it for `z.tuple`) returns **HTTP 400** too:
  `Unknown name "prefixItems" ... Cannot find field.`
- The same schema with those keys removed returns **HTTP 200**.

Because every agent schema is an object, **every** READMAP model call 400s on first
contact — the pipeline has never completed a live run and cannot until this is fixed. The
schema-less fallback only triggers when *building* the schema throws
(`toGeminiResponseSchema` returns null); a live 400 from a built-but-unsupported schema is
not caught, so the unit (and the job) just fails. This is the concrete, now-proven shape of
the handoff's §6.1 risk. Given it guarantees failure of the first real call, treat it as
**critical** for the Phase-1 exit alongside C3.

**Correction from the first draft of this review:** `title` was hypothesised as an
offender; the live test shows Gemini **accepts** `title` (HTTP 200). Keep it; drop only
`additionalProperties` and `prefixItems`. **Fix in §6-M5.**

> **STATUS: FIXED in the working tree (2026-09-15), not yet committed.** `gemini.ts` no
> longer sends `additionalProperties`/`prefixItems`, the dead `additionalProperties`
> branch in `pruneForGemini` is removed, and `generate` now retries once without the
> responseSchema on an HTTP 400. Two tests were added (`gemini.test.ts`): one asserts the
> two keys are pruned while `title` survives, one asserts the 400 fallback. `npm run
> typecheck` clean; full suite 181/181 green. Still needs a real end-to-end Gemini run to
> confirm in situ (blocked behind C3/H1).

### LOW / cleanup

- **L1** No retry/backoff on 429/503 (`gemini.ts` — one attempt + one repair). With ~100+
  sequential calls per job, one transient 503 fails the whole job. Add a small bounded
  retry on 429/503.
- **L2** `READMAP_MAX_JOB_COST_USD` is reserved but unenforced; usage is summed
  (`pipeline.ts:328-331`) but never checked. A large document spends unbounded within the
  candidate cap.
- **L3** Redundant third grounding-gate run in the no-repair path (`pipeline.ts:456,495`).
- **L4** `status/route.ts:49-54` returns `stage: "STARTING"` though its comment says
  `"UNKNOWN"`, and `readmap-client.ts:128` types the response as a full `ReadMapStatusV1`
  the placeholder does not satisfy (harmless today; `labelFor` tolerates it).
- **L5** `grounding/claim-parser.ts:53-67` `locatedTierClaims` appears unused (the gate
  checks tiers via `checkTierRenderings`).
- **L6** **Test coverage gaps:** no tests for any of the four API routes, `readmap-client.ts`,
  or the UI components. The dead reuse branch (C1) and inverted cache flag (H1) would have
  been caught by a single route/integration test. The "179 tests" are all offline unit
  tests below the route layer.
- **L7** `segment.ts:217` `wordCount` counts markdown anchors and table pipes as words,
  slightly inflating reading-time and compression stats.

---

## 4. What is solid (keep)

- The `StructuredModelClient` contract and provider isolation (`models/client.ts`,
  `model-router.ts`) — clean, and the dev adapter's double-gate fail-closed behavior is
  correct.
- `modelConfigured()` pre-flight refusing `start` before any spend (`route-access.ts`).
- Evidence snapshot persisted before any model call (`pipeline.ts:355-356`).
- Job-token binding reuse and path scoping on every route (`route-access.ts`,
  `artifacts.ts` allow-list) — server-resolved evidence, no client-supplied blob paths.
- The grounding gate's structure and the "repair by omission, thePoint is unrepairable"
  discipline — the honesty intent is right even where individual checks (M1) need tuning.

---

## 5. Suggested remediation order for the next session

1. **Unblock and reproduce the live E2E.** Fix **H1** (invert `useCache`), then run the
   §7 runbook and capture the convert-POST access-log line to close the handoff §5 blocker
   (which is upstream, in conversion, and independent of these findings).
2. **Make the pipeline survive one real document — C3.** For the slice: cap candidates
   low and parallelize VERIFYING with a small concurrency limit; ensure a ceiling-hit
   produces an honest terminal status, not a 504.
3. **Fix the credibility gaps — C1, C2.** Wire per-unit checkpoints and a real reuse
   branch, or remove the "never re-bills / idempotent reuse" claims from the docs until
   they are true. Do not ship the claim ahead of the code.
4. **Make it look finished — H2, H3, H4.** Add the missing stylesheet (or Tailwind-port
   the components), render a determinate progress bar from the unit counts, and surface the
   read/skip guide, rememberThese, and coverage that the pipeline already produces.
5. **Harden grounding for live output — M1, M2, M3, M5.** These will otherwise turn
   correct analyses into spurious PARTIAL/FAILED results the first time a real model runs.
6. **Close the test gap — L6.** Add route/integration tests (they would have caught C1 and
   H1) before declaring Phase 1 exit.
7. **Then** run the independent Phase-1 review prompt (`prompts/02_REVIEW_PHASE_1.md`) and
   the full §9 acceptance run.

---

---

## 6. Implementation Fix Pack (watertight patches)

Each patch below is a drop-in unless labelled **[design]** (a larger change where the
approach, not a literal diff, is specified). Line numbers are as of commit `f115afc`;
match on the quoted code, not the numbers. Every quoted "current" block is exact.
After the code fixes, run `npm run typecheck && npm run test` in `frontend/`.

### §6-C1 — Make the reuse branch actually work
**File:** `frontend/app/api/readmap/start/route.ts`

Add imports near the existing type imports (after line 37):
```ts
import type { ReadMapV1 } from "@/lib/readmap/schemas/readmap";
import type { CompressedTiersV1 } from "@/lib/readmap/schemas/signal";
```

Replace this block:
```ts
  // A completed analysis already exists for this exact result: return it
  // instead of re-billing the pipeline (idempotent retry, plan §4).
  const existing = await getReadmapArtifact<{ readmap: unknown }>(
    paths["readmap.v1.json"] as string,
  );
  if (existing?.readmap) {
    return NextResponse.json({
      status: "READY",
      reused: true,
      jobId,
      ...(existing as { readmap: unknown }),
    });
  }
```
with:
```ts
  // A completed analysis already exists for this exact result: return it
  // instead of re-billing the pipeline (idempotent retry, plan §4). The
  // pipeline persists the ReadMapV1 object itself at readmap.v1.json, so its
  // presence is the completion signal — never a `.readmap` wrapper.
  const existingReadmap = await getReadmapArtifact<ReadMapV1>(
    paths["readmap.v1.json"] as string,
  );
  if (existingReadmap) {
    const existingTiers = await getReadmapArtifact<CompressedTiersV1>(
      paths["tiers.v1.json"] as string,
    );
    const existingStatus = await getReadmapArtifact<{ stage?: string }>(
      paths["status.v1.json"] as string,
      { fresh: true },
    );
    return NextResponse.json({
      status: existingStatus?.stage === "PARTIAL_READY" ? "PARTIAL_READY" : "READY",
      jobId,
      reused: true,
      readmap: existingReadmap,
      tiers: existingTiers ?? null,
      warnings: existingReadmap.coverage.limitations,
    });
  }
```
`readmap.v1.json` is written only when the gate passes (`pipeline.ts` ~line 493), so its
presence guarantees a usable (possibly partial) result. **Add test** (new
`app/api/readmap/start.test.ts` or a route-level test): stub `getReadmapArtifact` to return
a `ReadMapV1` for `readmap.v1.json` and assert the response has `reused: true` and no
pipeline run occurs.

### §6-H1 — Un-invert the CDN cache flag  *(do this first — it unblocks the E2E)*
**File:** `frontend/lib/readmap/artifacts.ts`

Change the one line in `presignedGet` (line ~96):
```ts
    useCache: fresh,
```
to:
```ts
    useCache: !fresh,   // fresh === bypass CDN (matches lib/blob.ts signStatusGet)
```
That makes `getReadmapArtifact(status, { fresh: true })` bypass the CDN (matching D-005),
and leaves ordinary reads cached. **Add test:** spy on `presignUrl` and assert
`useCache === false` when `getReadmapArtifact(..., { fresh: true })` is called.

### §6-C3 — Bound and parallelize VERIFYING so a real document finishes  **[partial drop-in]**
**File:** `frontend/lib/readmap/orchestration/pipeline.ts`

Add a concurrency helper (top-level, near `chunkBlocks`):
```ts
/** Run `fn` over items with a bounded number of in-flight calls, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
```
Add a cap near the other constants:
```ts
/** Concurrent skeptic calls; keep small to respect provider rate limits. */
export const VERIFY_CONCURRENCY = 6;
```
Replace the sequential VERIFYING loop:
```ts
    currentStage = "VERIFYING"; publish("VERIFYING", { unitsTotal: candidates.length });
    const signals: VerifiedSignalV1[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const run = await runSkeptic(input.getClient("skeptic"), {
        signal: candidate,
        blocks: input.document.blocks,
        idempotencyKey: deriveStageKey({
          checksumSha256: input.checksumSha256,
          stage: "VERIFYING",
          unitId: candidate.id,
        }),
      });
      addUsage(usage, run.result.usage);
      signals.push({
        ...candidate,
        skepticVerdict: run.result.value.verdict,
        explanationCode: run.result.value.explanationCode,
        explanation: run.result.value.explanation,
        repairedClaim: run.result.value.repairedClaim,
      });
      currentStage = "VERIFYING"; publish("VERIFYING", { unitsDone: index + 1, unitsTotal: candidates.length });
    }
```
with:
```ts
    currentStage = "VERIFYING"; publish("VERIFYING", { unitsTotal: candidates.length });
    let verifiedCount = 0;
    const signals: VerifiedSignalV1[] = await mapWithConcurrency(
      candidates,
      VERIFY_CONCURRENCY,
      async (candidate) => {
        const run = await runSkeptic(input.getClient("skeptic"), {
          signal: candidate,
          blocks: input.document.blocks,
          idempotencyKey: deriveStageKey({
            checksumSha256: input.checksumSha256,
            stage: "VERIFYING",
            unitId: candidate.id,
          }),
        });
        addUsage(usage, run.result.usage);
        verifiedCount += 1;
        publish("VERIFYING", { unitsDone: verifiedCount, unitsTotal: candidates.length });
        return {
          ...candidate,
          skepticVerdict: run.result.value.verdict,
          explanationCode: run.result.value.explanationCode,
          explanation: run.result.value.explanation,
          repairedClaim: run.result.value.repairedClaim,
        };
      },
    );
```
Note `addUsage`/`verifiedCount` mutations are safe: JS is single-threaded and each `await`
resumes atomically. **Also** lower the candidate cap for the Phase-1 slice
(`export const MAX_CANDIDATE_SIGNALS = 40;`) and keep the visible warning when it is hit.
This is a mitigation, not the durable fix — the real answer is the resumable-stage split in
ADR-005, which needs §6-C2's checkpoints. **Add test:** feed 20 candidates through a
scripted client and assert all 20 verdicts are present and ordered.

### §6-C2 — Real per-unit checkpoints (so "retry does not re-bill" becomes true)  **[design]**
**Files:** `frontend/lib/readmap/artifacts.ts`, `orchestration/pipeline.ts`

Approach:
1. In `artifacts.ts`, allow a checkpoint path and add helpers:
   ```ts
   export function readmapUnitPath(resultPathname: string, key: string): string | null {
     const base = readmapBaseFromResultPath(resultPathname);
     if (!base) return null;
     // key contains ':' and '/'-unsafe chars — hash it to a flat name.
     const safe = createHash("sha256").update(key).digest("hex").slice(0, 32);
     return `${base}/readmap/units/${safe}.json`;
   }
   ```
   (import `createHash` from `node:crypto`.) Add a `unitPath` writer/reader that reuses
   `putReadmapArtifact`/`getReadmapArtifact`.
2. Thread a `checkpoint` hook into `ReadmapPipelineInput`:
   `checkpoint?: { get<T>(key: string): Promise<T | null>; put(key: string, value: unknown): Promise<void> }`.
3. Wrap each agent call: before calling, `const hit = await checkpoint?.get(key)`; if
   present, reuse it and skip the model call; otherwise call, then `await checkpoint?.put(key, value)`.
   The `key` is exactly the `deriveStageKey(...)` already computed per unit.
4. Wire it from `start/route.ts` using `readmapUnitPath(resultPathname, key)`.

**Until this is wired, correct the docs** so they stop claiming it: in
`docs/readmap/IMPLEMENTATION_STATUS.md`, `docs/readmap/ARCHITECTURE_DECISIONS.md` (ADR-009),
and `HANDOFF_READMAP.md`, change "retries never re-bill / enforced before any model call"
to "idempotency keys are derived per unit; per-unit checkpoint reuse is not yet wired
(Phase 1 re-runs on retry)." Do not ship the claim ahead of the code. **Add test:** run the
pipeline twice with a counting client and assert the second run makes zero model calls.

### §6-M3 — `thePoint` must cite a usable signal
**File:** `frontend/lib/readmap/orchestration/pipeline.ts` (in `assembleReadmap`)

Replace:
```ts
  const oneThing = readTier[0];
```
with:
```ts
  // thePoint must resolve to a USABLE signal, or the gate hard-fails the job
  // (SIGNAL_NOT_USABLE at thePoint is unrepairable). Fall through otherwise.
  const oneThing = readTier.find((entry) => usableById.has(entry.signalId));
```
`usableById` is already built above. The existing `thePoint ? … : fallback` branch then
handles the "none usable" case. **Add test:** compressor output whose `ONE_THING[0]` is an
UNSUPPORTED signal → job still produces a grounded `thePoint` (or a clean fallback), not
FAILED.

### §6-M1 — Numeric guard: compare values, not token spellings
**File:** `frontend/lib/readmap/grounding/numeric-guard.ts`

Replace `extractNumberTokens`, `normalized`, and `numbersPreserved` with:
```ts
const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9,
};

/** Canonical numeric values in a text: percentages and magnitudes, unit-normalized. */
export function canonicalNumbers(text: string): Set<string> {
  const set = new Set<string>();
  const re =
    /(\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|bn|billion|m|million|k|thousand)?/gi;
  for (const match of text.matchAll(re)) {
    const value = Number.parseFloat((match[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit = match[2]?.toLowerCase();
    if (unit === "%" || unit === "percent" || unit === "per cent") {
      set.add(`pct:${value}`);
    } else if (unit && unit in MULTIPLIER) {
      set.add(`num:${value * MULTIPLIER[unit]!}`);
    } else {
      set.add(`num:${value}`);
    }
  }
  return set;
}

/** True when every numeric value in `claim` survives (in any spelling) in `rendering`. */
export function numbersPreserved(claimText: string, rendering: string): boolean {
  const available = canonicalNumbers(rendering);
  for (const token of canonicalNumbers(claimText)) {
    if (!available.has(token)) return false;
  }
  return true;
}
```
Keep the `NUMERIC_CHECK_DEFERRED` export unchanged. This makes `$1.5bn` ≡ `1.5 billion`,
`12%` ≡ `12 percent`, `1,000` ≡ `1000`. **Add tests** for exactly those three pairs
(preserved) plus a genuine drop (`"grew 12%"` → `"grew"` ⇒ false).

### §6-M5 — Gemini schema subset + 400 fallback  ✅ APPLIED (2026-09-15, working tree)
**File:** `frontend/lib/readmap/models/gemini.ts` — done exactly as below; tests added and green.

(a) Remove the two keys Gemini's structured-output subset rejects (confirmed live:
`additionalProperties` and `prefixItems` → HTTP 400; `title` → HTTP 200, so **keep**
`title`). In `GEMINI_SCHEMA_KEYS`, delete only `"additionalProperties"` and
`"prefixItems"`:
```ts
const GEMINI_SCHEMA_KEYS = [
  "type", "format", "description", "title", "enum", "items",
  "minItems", "maxItems", "minimum", "maximum",
  "properties", "required",
] as const;
```
Then delete the now-dead `additionalProperties` branch in `pruneForGemini` that fills
`type: "object"` from it — key off `properties` only:
```ts
  if ("properties" in pruned && !("type" in pruned)) {
    pruned.type = "object";
  }
```
(b) Add a live-400 fallback. In `generate`, wrap the first call so an HTTP 400 while a
`responseSchema` is set retries once in mime-type-only mode:
```ts
      let first: { text: string; usage: ModelUsage };
      try {
        first = await callOnce(model, baseRequest);
      } catch (error) {
        if (
          error instanceof ModelCallError &&
          error.status === 400 &&
          baseRequest.generationConfig?.responseSchema
        ) {
          const { responseSchema: _drop, ...cfg } = baseRequest.generationConfig;
          first = await callOnce(model, { ...baseRequest, generationConfig: cfg });
        } else {
          throw error;
        }
      }
```
(replace the existing `const first = await callOnce(model, baseRequest);`). Zod still
validates output, and the one repair attempt still applies. **Add test:** a `fetchImpl`
that 400s when `responseSchema` is present and 200s otherwise → `generate` succeeds.

### §6-H2 — Style the READMAP surface on the existing design system
**Files:** `frontend/components/readmap/ReadmapApp.tsx` (de-Tailwind),
`ProcessingView.tsx` (fix progress classes), and `frontend/app/globals.css` (append block).

1. **`ReadmapApp.tsx`:** remove every Tailwind `className` and use the existing system —
   the outer `<main>` is already styled by `globals.css`; give the header plain elements
   (`<h1>`, `.muted`), render errors with `.error-panel`/`.error-title`, and make
   "Analyse another document" a `<button className="secondary">` / reset a plain `button`.
   (No Tailwind is installed, so these classes currently do nothing.)
2. **`ProcessingView.tsx`:** the stylesheet defines `.progress-track > .progress-fill`.
   Replace:
   ```tsx
   <div className="progress-track" aria-hidden="true">
     <div className="progress-indeterminate" />
   </div>
   ```
   with a determinate bar driven by §6-H3, falling back to indeterminate:
   ```tsx
   <div className="progress-track" aria-hidden="true">
     <div
       className="progress-fill"
       {...(percent === null ? { "data-indeterminate": "true" } : { style: { width: `${percent}%` } })}
     />
   </div>
   ```
3. **`globals.css`:** append one block for the genuinely new classes (tokens already
   defined at the top of the file):
   ```css
   /* READMAP ---------------------------------------------------------------- */
   .readmap-tier, .compression-control, .processing { margin-top: 1.25rem; }
   .tier-title { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.5rem; }
   .claim-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
   .claim { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline;
            background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.7rem 0.9rem; }
   .cite { background: none; border: none; padding: 0; color: var(--accent); font-size: 0.85rem; cursor: pointer; text-decoration: underline; }
   .notice { border-left: 3px solid var(--border-strong); padding: 0.4rem 0 0.4rem 0.9rem; margin: 1rem 0; }
   .notice-title { font-weight: 600; }
   .stage { font-size: 1.05rem; font-weight: 600; }
   .secondary { background: var(--surface); }
   .depth-label { font-weight: 600; margin-left: 0.5rem; }
   .compression-control input[type="range"] { width: 100%; }
   .drawer-backdrop { position: fixed; inset: 0; background: rgba(12,12,14,0.55); display: grid; place-items: end center; padding: 1rem; z-index: 10; }
   .drawer { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; max-width: 40rem; width: 100%; max-height: 85vh; overflow: auto; }
   .drawer-head { display: flex; justify-content: space-between; align-items: center; }
   .claim-text { font-weight: 600; }
   .evidence-list { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
   .evidence-block blockquote { margin: 0.25rem 0 0; padding-left: 0.75rem; border-left: 2px solid var(--border-strong); color: var(--text); }
   ```
   (Alternatively reuse `.overlay`/`.dialog` for the drawer and delete the `.drawer*`
   rules — either is fine; the point is the classes must exist.)

### §6-H3 — Real percentage on the wait screen
**Files:** `frontend/lib/readmap/readmap-client.ts`, `ReadmapApp.tsx`, `ProcessingView.tsx`

1. `readmap-client.ts` — extend the callbacks and emit a fraction from the poll. Add to
   `ReadmapFlowCallbacks`:
   ```ts
     onProgress?: (percent: number | null) => void;
   ```
   In the `setInterval` poll body, alongside the label:
   ```ts
     .then((status) => {
       callbacks.onStage?.(labelFor(status));
       const pct =
         status.unitsTotal > 0 ? Math.round((status.unitsDone / status.unitsTotal) * 100)
         : typeof status.progress === "number" ? Math.round(status.progress * 100)
         : null;
       callbacks.onProgress?.(pct);
     })
   ```
2. `ReadmapApp.tsx` — hold `const [percent, setPercent] = useState<number | null>(null);`,
   pass `onProgress: setPercent` into `runReadmapFlow`, and pass `percent={percent}` to
   `ProcessingView`. (During the upload phase keep using `uploadPercent`.)
3. `ProcessingView.tsx` — accept `percent: number | null` and render per §6-H2 item 2.

### §6-H4 — Render the features the pipeline already produces
**File:** `frontend/components/readmap/ReadmapResult.tsx`

The `ReadMapV1` shape (see `schemas/readmap.ts`) has `rememberThese: OutputClaim[]`,
`actuallyRead`/`safelySkip: PageRecommendation[]` (`{ pages?: {from,to}; sectionPath?: string[]; reason }`),
`documentShape: { sectionPath: string[]; shape: string }[]`, and `coverage`. Add these
sections (after the tier `<section>`, before the evidence drawer). Reading guide:
```tsx
{(outcome.readmap.actuallyRead.length > 0 || outcome.readmap.safelySkip.length > 0) && (
  <section className="readmap-tier">
    <h2 className="tier-title">Where to spend your time</h2>
    {outcome.readmap.actuallyRead.map((r, i) => (
      <p key={`read-${i}`}>
        <strong>Read</strong>{" "}
        {r.pages ? `pages ${r.pages.from}–${r.pages.to}` : (r.sectionPath ?? []).join(" › ")}
        {" — "}<span className="muted">{r.reason}</span>
      </p>
    ))}
    {outcome.readmap.safelySkip.map((r, i) => (
      <p key={`skip-${i}`}>
        <strong>Skip</strong>{" "}
        {r.pages ? `pages ${r.pages.from}–${r.pages.to}` : (r.sectionPath ?? []).join(" › ")}
        {" — "}<span className="muted">{r.reason}</span>
      </p>
    ))}
  </section>
)}
```
`rememberThese` renders exactly like `caution` (a `.claim-list` with a `source` button).
Add a small coverage line near the top:
```tsx
<p className="muted">
  Covered {outcome.readmap.coverage.readablePages}/{outcome.readmap.coverage.totalPages} pages
  · {Math.round(outcome.readmap.coverage.ratio * 100)}%
</p>
```
Optionally render `documentShape` as a labelled list. **Add** a component test (or a manual
E2E note) asserting a fixture READMAP shows read/skip entries.

### §6 — Lower-severity, quick wins
- **M4** (`artifacts.ts`): give `putReadmapArtifact` an `immutable` param and pass
  `allowOverwrite: !immutable`; call with `immutable: true` for `evidence.v1.json` and
  `signals.v1.json`, default (overwrite) for `status.v1.json`.
- **L1** (`gemini.ts`): in `callOnce`, on `response.status === 429 || 503`, retry once
  after a short backoff before throwing.
- **L2** (`pipeline.ts`): read `READMAP_MAX_JOB_COST_USD`; after each `addUsage`, estimate
  cost and abort to `PARTIAL_READY` with a disclosed limitation if exceeded.
- **L3** (`pipeline.ts`): reuse the `gate`/`recheck` report instead of a third
  `runGroundingGate` call in the no-repair path.
- **L4** (`status/route.ts`): return `stage: "STARTING"` (already correct) — just fix the
  comment that says `"UNKNOWN"`.
- **L5**: delete the unused `locatedTierClaims` in `grounding/claim-parser.ts`.
- **L7** (`segment.ts`): compute `wordCount` from prose blocks, excluding anchors/table pipes.

### Suggested branch/PR hygiene for the implementer
Land these as separate commits in the §5 order (H1 first, then C-series, then H2–H4, then
M-series, then L-series) so each is reviewable and the E2E can be re-tried after H1 alone.
Keep everything on `feature/readmap-mvp`; never push `main` (it deploys the converter).

---

*Prepared as a read-only review. The patches in §6 are specifications for the implementer,
not applied changes — **with one exception: §6-M5 has been applied to the working tree**
(`gemini.ts` + two new tests in `gemini.test.ts`; typecheck clean, 181/181 tests green,
uncommitted). M5 was also verified with four minimal live Gemini calls on 2026-09-15
(synthetic test schemas only — no document content, no source code sent; ~2 000 tokens
total). All other findings remain static and unimplemented.*
