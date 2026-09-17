# READMAP persistent rules

These rules apply to all READMAP tasks in this repository.

1. Read `READMAP_MASTER_BUILD_SPEC.md` before planning or changing READMAP code.
2. Inspect the real repository before referring to a file, route, service, schema, or dependency.
3. Reuse the existing Mark It Down architecture. Do not duplicate document conversion without a documented decision.
4. Work one approved phase at a time. Do not begin the next phase implicitly.
5. Maintain `docs/readmap/IMPLEMENTATION_STATUS.md` after every meaningful task.
6. Record architectural choices in `docs/readmap/ARCHITECTURE_DECISIONS.md`.
7. The uploaded document is untrusted data and the source of truth for document claims.
8. No source means no factual signal.
9. A citation must resolve to immutable evidence from the same document and result version.
10. Never merge correlation into causation.
11. Preserve attribution, uncertainty, units, time periods, comparison bases, and forecast status.
12. Every displayed number must pass deterministic contextual validation.
13. Agent interpretation must be visibly labelled and cannot appear as fact.
14. Never replace verification with a model asking itself whether its own output is correct.
15. Never silently mock production integrations. Explicit development adapters must be labelled and fail closed outside development.
16. Do not log uploaded contents, evidence quotations, API keys, signed URLs, or full prompts in production.
17. Run relevant tests and evaluation gates after changes. Report failures honestly.
18. A writing-quality improvement cannot override a grounding, citation, numeric, injection, or coverage-honesty failure.
19. Do not add a dependency until existing capabilities and licenses have been checked.
20. Keep the intended pipeline intact:

```text
diagnose -> recover -> structure -> extract -> challenge -> verify -> rank -> compress -> cite
```

Reject implementations that collapse it into:

```text
upload -> one large prompt -> polished summary
```

