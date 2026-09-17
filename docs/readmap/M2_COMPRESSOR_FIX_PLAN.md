# M2 compressor fix — implementation plan

_Status: reviewed and IMPLEMENTED. Branch `feature/readmap-mvp`. Written 2026-09-17._

Written to be reviewed by another model or engineer before implementation.
Each section leads with a plain-language line, then the technical detail.

> **Review outcome (see `M2_COMPRESSOR_FIX_PLAN_REVIEW.md`): approved with
> corrections, all incorporated.** Most important correction (C-1): the plan's
> risk #4 was wrong — the checkpoint key uses the single global
> `PIPELINE_VERSION`, not the per-stage prompt version, so bumping
> `compressor.v2` alone would have reused a stale cached result. The fix
> therefore bumps `PIPELINE_VERSION` to `readmap-pipeline.v2` (blast radius: the
> next run of each document re-bills the whole pipeline once). The fallback now
> emits a visible "ranking unavailable" warning (C-5); a test pins
> thePoint == ONE_THING (C-4); and a `stages.test.ts` pins the version-in-key
> contract (C-1). The prose below is the original plan and is kept for context.

---

## Problem being solved

**Plain version:** the step that builds the layered "reading depth" view occasionally
fails and kills the whole run, at random, more often on large documents.

The compressor (`frontend/lib/readmap/agents/compressor.ts`) asks the model to do two
jobs at once: (a) **select** which verified signals appear in each of the six nested
reading-depth tiers, and (b) **render** each selected signal's text. The six tiers must
strictly nest:

```
ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE   (ONE_THING holds exactly 1)
```

Two deterministic post-checks enforce this — `assertTierNesting` and
`assertSelectionsResolve` (`frontend/lib/readmap/agents/contract.ts`,
`frontend/lib/readmap/agents/compressor.ts`) — and the grounding gate re-runs
`assertTierNesting` again (`frontend/lib/readmap/grounding/grounding-gate.ts:144`). When
the model's selection breaks an invariant, the check throws, the pipeline `catch` returns
FAILED, and the whole job dies. The failure is **not repairable**.

### Observed failure signatures (measured)

Two shapes seen, both from the model hand-assembling the tiers:

1. **Nesting violation** — a longer tier drops a signal a shorter tier had
   (`tier BRUTAL drops s0001 from ONE_THING: nesting invariant violated`). Seen in the
   live pipeline E2E.
2. **Malformed / merged selection** — the model crams two facts into the single-slot top
   tier by concatenating their ids: `tier ONE_THING selects "s0035,s0002", which is not a
   verified signal`. Seen in the isolated probe below.

### Frequency (isolated compressor probe against the live model)

A temporary probe ran the real compressor N times on a fixed verified-signal set, varying
the signal order each run, and counted invariant failures. (Probe was deleted after use;
it self-skipped unless `M2_PROBE=1`.)

| Signal set | Runs | Failures | Rate |
|---|---|---|---|
| 22 signals (moderate) | 12 | 0 | 0% |
| 38 signals (dense, with near-duplicates) | 10 | 1 (merged-id selection) | ~10% |

**Conclusion:** M2 is a low-frequency edge case — roughly **1-in-10 on large/dense
documents, near-zero on smaller ones** — not a coin-flip. It does not harm output
*quality* (successful runs are good); it harms *reliability* (a minority of runs on big
documents fail at the last step and need a retry). Worth fixing to make the tool
dependable, not an emergency.

---

## The fix

**Plain version:** stop asking the model to build the nested layers. Have it do the one
thing it is reliable at — rank the facts by importance — and let ordinary code assemble
the six nested layers. Code cannot drop a fact from a longer layer or merge two ids, so
the failure becomes impossible by construction.

### Mechanics

- **Change the compressor's model contract.** Instead of returning six tier arrays, the
  model returns:
  - a single **ranked list of signal ids**, most important first (centrality, consequence,
    materiality, novelty, evidence strength, non-redundancy — the criteria already in the
    prompt), and
  - a **rendering** (concise text) for each signal.
- **Build the six tiers in code** by taking prefixes of the ranked list at fixed target
  sizes, each prefix clamped to the number of available signals:

  | Tier | Target size |
  |---|---|
  | ONE_THING | 1 |
  | BRUTAL | 3 |
  | QUICK_SCAN | 6 |
  | BRIEF | 12 |
  | READMAP | 20 |
  | DEEP_DIVE | all |

  Because every tier is a prefix of the same ranked list, `ONE_THING ⊆ BRUTAL ⊆ … ⊆
  DEEP_DIVE` holds automatically, ONE_THING always has exactly one, and every id is a real
  verified id copied by code. (Target sizes are policy constants open to review; they map
  to the depth slider's six stops.)
- **Keep the model's rendering job**, attached per signal id. One rendering per signal is
  reused wherever that signal appears (see risk 2 for the per-tier-phrasing tradeoff).
- **Keep both assertions as defence-in-depth.** After code builds the tiers,
  `assertTierNesting` / `assertSelectionsResolve` still run; they now pass by construction,
  and a code bug would still be caught rather than shipped.
- **Sanitise the model's ranked list in code before building** (this is the repair the old
  design lacked): drop ids that are not verified signals, drop duplicates keeping first
  occurrence, ignore malformed entries. A merged `"s0035,s0002"` id is simply skipped
  instead of failing the job. If too few valid ids survive, fall back to ranking by the
  pipeline's existing signal order so a result still ships.
- **Renderings fallback:** if the model omits a rendering for a ranked signal, use the
  signal's own claim text.

### Files

- `frontend/lib/readmap/schemas/signal.ts` — add the new model-output schema (ranked ids +
  renderings); keep `CompressedTiersV1` as the built/internal type.
- `frontend/lib/readmap/prompts/compressor.ts` — rewrite to "rank + render," bump to
  `compressor.v2`.
- `frontend/lib/readmap/agents/compressor.ts` — call the model for the ranked list, then a
  new `buildTiers()` that assembles `CompressedTiersV1` deterministically; keep the
  assertions.
- Tests (below).

---

## Tests

- `frontend/lib/readmap/agents/compressor.test.ts`:
  - `buildTiers()` unit tests (pure, offline): prefixes nest; ONE_THING has exactly 1;
    sizes clamp when fewer signals exist; duplicates removed; unknown/merged ids dropped;
    empty/too-few input falls back gracefully.
  - The model-facing test scripts a ranked list (incl. a deliberately malformed id) and
    asserts a valid, nested `CompressedTiersV1` still results — i.e. the old fatal case is
    now handled.
- Full gate: frontend `npm test` + typecheck + lint; backend tests; container build; the
  DOCX/PPTX/PDF smoke tests (per repo `AGENTS.md`).
- Re-run the live PDF E2E a few times to confirm the compressor no longer fails
  intermittently (the same probe approach can be reused to measure the post-fix rate,
  which should be 0).

---

## Risks for the reviewer to scrutinise

1. **Fixed tier sizes become policy, not model judgement.** The model no longer decides how
   many signals each depth shows. This is arguably more consistent, but confirm the target
   sizes (1/3/6/12/20/all) read well across short and long documents, and that they clamp
   sensibly when a document has very few signals.
2. **Per-tier phrasing.** Today the model *can* render the same signal more tersely in
   BRUTAL than in DEEP_DIVE. One-rendering-per-signal drops that nuance (same text at every
   depth it appears). Options: accept it (simplest, still correct); or have the model return
   a short+long pair per signal and pick by tier. Recommend shipping the simple version
   first.
3. **Ranking quality.** Correctness is now guaranteed, but the *usefulness* of the layers
   depends entirely on the model's ranking. Worth a sanity check that the top-ranked signal
   (ONE_THING) is genuinely the headline on a few real documents.
4. **Prompt version bump (compressor.v1 → v2)** changes the compressor checkpoint key; an
   in-flight retry re-bills the compressor once. Intended. Confirm nothing pins
   `compressor.v1`.
5. **Downstream consumers** of `CompressedTiersV1` (`grounding-gate.ts`, `pipeline.ts`,
   `evals/deterministic-scorer.ts`) are unchanged as long as `buildTiers()` emits the same
   shape. Verify the eval scorer's own nesting check still passes.

---

## Current state

- The PDF section fix (the previous plan) is committed and pushed (`dbe1f9d`), PDFs analyse
  end-to-end.
- This M2 work is **not started** — this document is the plan only.
- Frequency evidence above came from a temporary probe that has been deleted; the working
  tree is clean and the suite is at 205 tests.

---

## Alternatives considered and rejected

- **One repair retry on a nesting failure** (ask the model to fix its own tiers): still
  relies on the model getting nesting right, just with a second dice roll; does not make the
  failure impossible, and doubles latency/cost on the hard cases. The deterministic build is
  strictly better.
- **Relax the invariant** (allow non-nested tiers): breaks the depth slider's core promise
  that deeper = a superset, and the grounding gate enforces nesting independently anyway.
- **Leave it as documented debt:** acceptable given the ~1-in-10 rate, but every failed run
  is a dead end for the user with a generic error, so the fix materially improves trust.
