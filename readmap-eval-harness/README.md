# READMAP Evaluation Harness

This package is a build-ready scaffold for evaluating the READMAP agent described in `READMAP_CLAUDE_CODE_MASTER_BUILD_SPEC.md`.

It tests whether READMAP is trustworthy and useful—not merely whether its prose sounds polished.

## What the harness measures

1. **Groundedness:** Is every factual output claim supported by its cited evidence?
2. **Citation validity:** Do citations resolve to the correct document, page, and evidence block?
3. **Numerical fidelity:** Are values, units, periods, direction, and forecast status preserved?
4. **Signal recall:** Did important information survive?
5. **Signal precision:** Did low-value material get excluded?
6. **Compression consistency:** Are shorter tiers valid subsets that preserve the core conclusion?
7. **Coverage honesty:** Does READMAP disclose unreadable or partially recovered content?
8. **Prompt-injection resistance:** Are instructions inside uploaded documents treated as data?
9. **Read/skip defensibility:** Are page recommendations supported by the document map?
10. **Operational reliability:** Can interrupted and rate-limited jobs recover safely?

## Package contents

- `EVALUATION_PLAN.md` — full design and release policy
- `src/types.ts` — portable evaluation types
- `src/deterministic-scorer.ts` — deterministic invariant checks
- `src/aggregate.ts` — metric aggregation and release gates
- `fixtures/synthetic-traps.json` — initial adversarial cases
- `config/release-gates.json` — critical thresholds
- `CLAUDE_CODE_INSTALL_PROMPT.md` — prompt to integrate this package

## Intended integration

Claude Code should adapt the imports to the existing repository and connect the harness to the real READMAP pipeline through a thin adapter:

```ts
interface ReadMapSystemUnderTest {
  runFixture(fixture: EvalFixture): Promise<ReadMapEvalOutput>;
}
```

The harness must not call production endpoints or use confidential user documents by default.

## Evaluation layers

| Layer | Runs | Cost | Purpose |
|---|---|---:|---|
| Deterministic | Every pull request | Low | Schemas, citations, numbers, nesting, coverage |
| Semantic judge | Nightly/release | Medium | Entailment, caveat preservation, ranking |
| Human gold set | Before meaningful release | Human time | Senior-reader usefulness and difficult edge cases |

## Suggested commands after integration

```bash
npm run eval:readmap:fast
npm run eval:readmap:full
npm run eval:readmap:report
```

These scripts are targets for Claude Code to wire into the existing package manager. They are not assumed to exist yet.

