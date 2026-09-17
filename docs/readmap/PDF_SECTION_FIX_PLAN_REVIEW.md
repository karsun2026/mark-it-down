# Review: PDF_SECTION_FIX_PLAN.md

_Status: review notes for `docs/readmap/PDF_SECTION_FIX_PLAN.md`. Written 2026-09-17. Branch `feature/readmap-mvp`._

All file references below use the real on-disk paths (under `frontend/`) so a reviewer can jump to them directly. Every claim was checked against the current working tree, and the cited tests were executed (`vitest` on `lib/readmap/agents/mapper.test.ts` + `lib/readmap/ingestion/segment.test.ts`: 17/17 pass).

---

## Overall verdict

**Approve with the small corrections below.** The plan accurately describes the real code. Part 2 is genuinely already drafted and green. The core approach (seed a level-0 page/slide anchor on the heading stack, then rebind the model prose section names to those anchors) is correct, minimal, and preserves the anti-fabrication guarantee. The downstream consumers are intersection-tolerant, so the blast radius is contained. The remaining work is implementing Part 1 in `frontend/lib/readmap/ingestion/segment.ts` plus the new test assertions, then running the full gate.

---

## Verified accurate (no change needed)

These claims in the plan were checked against the code and hold.

### Diagnosis - correct

- `frontend/lib/readmap/ingestion/segment.ts:144-150` - on a `## Page N` line the code sets `pageNumber`, does `headingStack = []`, then calls `emitHeading(`Page ${pageNumber}`)`.
- `frontend/lib/readmap/ingestion/segment.ts:134-138` - `emitHeading` only pushes a standalone HEADING block and flushes; it never pushes onto `headingStack`.
- `frontend/lib/readmap/ingestion/segment.ts:115` - each block `sectionPath: headingStack.map((entry) => entry.text)`. With an empty stack, every PDF body block gets `sectionPath: []`. Confirmed.

### Abort path - correct

- `frontend/lib/readmap/agents/mapper.ts:144-154` - `validateMapSections` throws `AgentContractError: mapper output section <name> does not exist in the supplied evidence`, matching the plan quoted error verbatim.

### Part 1 mechanics - correct

- `frontend/lib/readmap/ingestion/segment.ts:177-182` - the pop condition is `while (headingStack.length > 0 && (last.level ?? 0) >= level) pop()`. A base entry at `level: 0` is never popped by any real ATX heading (levels 1-6), so a sub-heading nests as `["Page N", "Heading"]` exactly as the plan states.
- Seeding `headingStack = [{ level: 0, text: "Page N" }]` in place of `headingStack = []` is the right minimal change. Same logic holds for `SLIDE_ANCHOR` at `frontend/lib/readmap/ingestion/segment.ts:153-163`.

### Part 2 is drafted and green - confirmed

- `frontend/lib/readmap/agents/mapper.ts:88-121` - `resolveSectionPaths` exists.
- `frontend/lib/readmap/agents/mapper.ts:184-185` - `runMapper` wires `resolveSectionPaths` before `validateMapSections`.
- `frontend/lib/readmap/prompts/mapper.ts:11` - already at `MAPPER_PROMPT_VERSION = "mapper.v2"`.
- `git status` shows `frontend/lib/readmap/agents/mapper.ts`, `frontend/lib/readmap/prompts/mapper.ts`, and `frontend/lib/readmap/agents/mapper.test.ts` as the uncommitted Part 2 work.
- Tests run: 17/17 pass (13 in `segment.test.ts`, 4 in `mapper.test.ts`).

### Downstream consumers are robust to the new prefix - verified

The plan risk #1 (blast radius) is real in scope but low in severity. Each consumer uses intersection matching or passes the value through:

- `frontend/lib/readmap/agents/skeptic.ts:59` - `anchor.sectionPath.some((part) => block.sectionPath.includes(part))`. A `Page N` prefix only adds overlap; it never breaks a match.
- `frontend/lib/readmap/agents/signal-extractor.ts:52` - only passes `sectionPath` through into the model payload; no logic depends on its content.
- `frontend/lib/readmap/orchestration/pipeline.ts:330` - `recommendationFor` uses `sectionPath.some((part) => block.sectionPath.includes(part))`. After the fix, `["Page 1"]` correctly matches page-1 blocks (which now include `"Page 1"`), producing a real page range.
- `frontend/lib/readmap/grounding/grounding-gate.ts:106-135` - `checkRecommendationTargets` builds `knownSections` from block `sectionPath`s. Post-fix, `["Page 1"]` is in `knownSections`, so the `sectionPath` branch passes; the `pages` branch only validates the numeric range, unaffected by the prefix.
- `frontend/lib/readmap/schemas/readmap.ts:46` - `DocumentShapeEntrySchema` requires `sectionPath.min(1)`, satisfied by `["Page 1"]`.

---

## Corrections / things to fix in the plan

### C-1 - Path prefix is wrong throughout the plan

The plan repeatedly writes `lib/readmap/ingestion/segment.ts` and `lib/readmap/agents/mapper.ts`, but the real files live under `frontend/` (e.g. `frontend/lib/readmap/ingestion/segment.ts`). A reviewer following the links literally will not find them. Update all references to include the `frontend/` prefix.

### C-2 - Risk #4/#5 (prompt version bump) is stale

The plan frames the v1 to v2 bump as future work to scrutinise, but `mapper.v2` is **already** in the working tree as part of the uncommitted Part 2 changeset (`frontend/lib/readmap/prompts/mapper.ts:11`). A grep shows no remaining `mapper.v1` literals. Reword this risk to: "the bump is already done; verify no stale `mapper.v1` references and confirm the checkpoint-key change is acceptable for in-flight retries."

### C-3 - The "correctness fix needed" guard is defensive, not strictly required

The plan (lines ~75-77) says to guard `anchorForHeading` against an empty anchor, calling it "needed." Trace of the current code (`frontend/lib/readmap/agents/mapper.ts:101-116`):

- `if (anchor)` treats `[]` as truthy, so a pre-Part-1 PDF block (empty `sectionPath`) "matches".
- `resolved` then stays empty, and line 116 (`resolved.length > 0 ? resolved : section.sectionPath`) falls back to the original invented name.
- `validateMapSections` (lines 144-154) then rejects it.

So anti-fabrication **already fails closed** without the guard. After Part 1, anchors are non-empty anyway. The guard is good hygiene/defence-in-depth, but the plan overstates it as required for correctness. Soften the wording to "recommended for clarity."

### C-4 - Risk #3 (duplicate sections on one page) is already handled

Two sections both resolving to `["Page 1"]` produce two `documentShape` entries with the same `sectionPath` but different `shape` (purpose) - fine and arguably desirable. For `actuallyRead`/`safelySkip`, `recommendationFor` (`frontend/lib/readmap/orchestration/pipeline.ts:322-344`) collapses them to the same page range; the `.slice(0, 5)` cap and distinct `reason` strings are the only visible effect. No de-duplication is actually required. Add a note that the read/skip guide may show "Read page 1" more than once, so that behaviour is expected rather than surprising.

### C-5 - The `## Page N` heading block itself gains the anchor (pin in tests)

After Part 1, the `## Page N` heading block will carry `sectionPath: ["Page N"]` because `emitHeading` flushes against the freshly-seeded stack. This is consistent and harmless, and it means `knownSectionParts` includes `"Page N"` even before any body block. Add an explicit test assertion so the heading-block path is pinned and a future refactor does not silently change it.

### C-6 - Confirm `HR`/separator handling is unaffected (state it in the plan)

`---` separators call `flushPending()` and `continue` (`frontend/lib/readmap/ingestion/segment.ts:165-168`) and never touch `headingStack`, so the seeded `Page N` entry survives inter-page separators correctly. No change is needed, but stating this in the plan closes an obvious reviewer question.

---

## Process / acceptance criteria

- The test list (plan lines 96-112) matches the existing test file structure and is appropriate.
- The five live end-to-end acceptance checks (plan lines 107-112) are the right gating criteria.
- Per repo `AGENTS.md`, the full gate must also include backend tests, the container build, and the DOCX/PPTX/PDF smoke tests. The plan lists `npm test` + typecheck + lint; ensure the backend tests and smoke tests are run separately as required and that no test is reported as passing unless actually executed.

---

## Suggested next action

Implement Part 1 in `frontend/lib/readmap/ingestion/segment.ts` (seed the level-0 page/slide anchor), add the segment test assertions from the plan plus the heading-block assertion (C-5), then run the full gate: frontend tests, backend tests, typecheck, lint, container build, and the DOCX/PPTX/PDF smoke tests.
