# Task 02 — Independent Phase 1 review

Act as a skeptical senior engineer reviewing READMAP Phase 1. Do not implement fixes yet.

Read:

- `READMAP_MASTER_BUILD_SPEC.md`
- `.clinerules/readmap.md`
- `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`
- `docs/readmap/IMPLEMENTATION_STATUS.md`
- all files changed for Phase 1
- evaluation reports

Determine whether the implementation genuinely follows:

```text
structure -> extract -> challenge -> verify -> rank -> compress -> cite
```

Look specifically for:

1. A hidden one-shot summarization path
2. Invented or display-only citations
3. Claims not linked to immutable evidence
4. Verification performed only through self-critique
5. Numeric claims bypassing validation
6. Compression tiers regenerated from prose rather than verified signal IDs
7. Interpretations displayed as facts
8. Prompt-injection exposure
9. Authorization gaps in evidence endpoints
10. Mocks that appear operational
11. Retry loops, race conditions, duplicate jobs, and non-idempotent stages
12. Tests that only verify execution instead of semantic invariants
13. Unreported low document coverage
14. Logged document contents or secrets

Run the relevant tests and inspect failures. Produce:

`docs/readmap/PHASE_1_REVIEW.md`

Classify findings:

- `BLOCKER`
- `HIGH`
- `MEDIUM`
- `LOW`

For each finding provide evidence, consequence, and the smallest recommended correction. Finish with exactly one verdict:

- `PHASE 1 ACCEPTED`
- `PHASE 1 ACCEPTED WITH NON-BLOCKING ITEMS`
- `PHASE 1 REJECTED`

