# Task 00 — Repository audit

Read `READMAP_MASTER_BUILD_SPEC.md`, `.clinerules/readmap.md`, and the complete `readmap-eval-harness` package.

Do not implement READMAP yet.

Inspect this repository, including its project instructions, package scripts, existing Mark It Down workflow, routes, data schemas, storage, authentication, background jobs, model integrations, tests, and deployment configuration.

Create:

1. `docs/readmap/IMPLEMENTATION_STATUS.md`
2. `docs/readmap/ARCHITECTURE_DECISIONS.md`
3. `docs/readmap/PHASE_1_IMPLEMENTATION_PLAN.md`

The Phase 1 plan must:

- map every proposed change to real repository files
- distinguish reuse, modification, and new code
- identify architecture conflicts and missing dependencies
- define the Mark It Down integration contract actually present in this repository
- identify how asynchronous processing should work here
- identify how model providers are currently abstracted
- list Phase 1 security risks
- list exact acceptance checks
- list the exact files proposed for addition or modification

Verify every referenced path before including it. Do not invent infrastructure or describe suggested directory names as though they already exist.

Finish with:

- `READY FOR PHASE 1`, if no blocking decision remains; or
- `BLOCKED`, followed by the minimum questions requiring human decisions.

Wait for approval. Do not modify application code.

