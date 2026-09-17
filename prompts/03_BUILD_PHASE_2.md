# Task 03 — Build Phase 2 adaptive recovery

Begin only after Phase 1 is accepted and committed.

Implement adaptive page-level recovery:

```text
Document Doctor
-> deterministic page diagnosis
-> native Mark It Down path
-> selective OCR
-> selective table recovery
-> selective visual interpretation
-> evidence reconciliation
-> coverage gate
```

Requirements:

1. Route page-by-page, not whole-document-by-default.
2. Invoke vision only where visual relationships cannot be recovered reliably from native text/OCR.
3. Preserve extraction method, page/slide, bounding region when available, confidence, and warnings for every recovered evidence block.
4. Keep conflicting extraction outputs and reconcile them explicitly.
5. Do not count blank or decorative pages as recovery failures.
6. Show partial coverage honestly according to configured thresholds.
7. Fail closed if too little meaningful content is recoverable.
8. Use bounded parallelism, provider rate limits, exponential backoff with jitter, and stage idempotency.
9. Extend evaluation fixtures for scans, mixed documents, charts, tables, and deliberately unreadable pages.
10. Maintain implementation status and record new architectural decisions.

Run the full relevant tests, production build, and evaluation suite. Do not begin numerical-integrity Phase 3 automatically.

