# Task 01 — Build Phase 1

Proceed with Phase 1 only, using the approved `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`.

The required vertical slice is:

```text
text-native PDF/DOCX/PPTX
-> existing Mark It Down conversion
-> page/slide-addressable evidence blocks
-> Mapper
-> atomic Signal Extractor
-> Skeptic verification
-> verified signal store
-> Compressor tiers
-> deterministic Grounding Gate
-> READMAP result interface
-> evidence drawer
```

Requirements:

1. Use real integration where the repository already has working services and credentials.
2. If an external service is unavailable, create an explicitly labelled development adapter that cannot be mistaken for production.
3. Do not implement OCR or vision in this phase.
4. Do not claim support for image-only documents.
5. Persist immutable evidence identifiers.
6. Validate all agent outputs using the repository's schema system.
7. Precompute compression tiers; moving the UI control must not cause another model call.
8. Add loading, failure, empty, and unsupported-document states.
9. Add the initial deterministic evaluation-harness integration.
10. Maintain `docs/readmap/IMPLEMENTATION_STATUS.md` as work proceeds.

Run:

- type checking
- relevant unit and integration tests
- production build
- READMAP fast evaluation suite

Do not hide errors or weaken release gates to obtain a passing result. At completion, provide:

- changed files
- implemented behaviour
- remaining development adapters or limitations
- test and evaluation results
- cost-bearing external calls made during testing
- recommended manual checks

Do not begin Phase 2.

