# READMAP Evaluation Plan

## 1. Evaluation philosophy

A document summarizer can be factually correct and still be poor because it preserves the wrong facts. READMAP therefore needs two separate tests:

- **Can the output be trusted?**
- **Was the right information selected?**

Trust metrics are release blockers. Usefulness metrics are quality gates and should improve over time, but they must not compensate for hallucinations.

## 2. Test unit

Each evaluation case contains:

- a controlled input document or structured evidence package
- page-level recovery expectations
- gold signals and forbidden claims
- important qualifiers
- numeric facts with context
- expected contradictions or limitations
- expected tier membership where deterministic
- optional human annotations

The harness stores hashes and licenses/source notes for test assets. Do not put confidential documents into the repository.

## 3. Corpus plan

### Stage A — synthetic fixtures

Start with 20–30 compact fixtures constructed specifically to isolate failure modes:

- unsupported causation
- forecast presented as actual
- million/billion confusion
- percentage/percentage-point confusion
- conflicting numbers
- missing year or geography
- management claim mistaken for established fact
- chart relationship OCR cannot recover
- important footnote
- repeated claim across sections
- prompt injection inside the document
- partial OCR failure

### Stage B — public representative documents

Add 20–40 redistribution-safe documents covering:

- annual reports
- market studies
- slide decks
- academic papers
- government reports
- image-heavy brochures
- scanned historical documents

Record source URL, retrieval date, license/reuse basis, checksum, expected page count, and fixture purpose.

### Stage C — human gold set

Create a smaller set of 10–15 difficult documents. Two reviewers independently annotate:

- 5–15 essential signals
- material caveats
- key numbers
- pages worth reading
- claims that must never be made

Resolve disagreements into a versioned gold annotation. This set is the main test of signal ranking.

## 4. Metrics

### 4.1 Citation validity

```text
valid_citations / total_citations
```

A citation is valid only when the referenced evidence block exists, belongs to the same document and output version, and its page/slide is valid.

**Release gate: 100%.**

### 4.2 Claim groundedness

Judge each factual claim against only its cited evidence:

- `ENTAILED`
- `PARTIALLY_ENTAILED`
- `NOT_ENTAILED`
- `CONTRADICTED`

Use deterministic checks first, then a semantic judge for prose entailment. Treat partial support as a failure unless the displayed wording matches the supported subset.

**Release gate:** no unsupported or contradicted claim in the critical gold set; at least 98% weighted groundedness overall.

### 4.3 Numerical fidelity

Every numeric claim receives atomic checks for:

- value
- scale
- unit
- currency
- time period
- direction
- actual/forecast status
- comparison basis
- denominator

One material mismatch fails the numeric claim. Faithful rounding is permitted only under configured tolerance.

**Release gate: 100% on curated numeric fixtures.**

### 4.4 Important-signal recall

```text
gold essential signals represented / gold essential signals
```

Use semantic matching with a conservative judge and human review of uncertain pairs.

Targets:

- Deep dive: ≥ 95%
- ReadMap: ≥ 85%
- Brief: ≥ 70%
- Quick scan: ≥ 50%

The shorter tiers deliberately sacrifice coverage.

### 4.5 Signal precision

```text
selected useful signals / all selected signals
```

Gold “low value” labels are advisory because readers can disagree. Track precision but do not let it override groundedness.

### 4.6 Caveat preservation

A claim fails when compression removes a qualifier that materially changes its meaning. Examples:

- “could reach” becomes “will reach”
- “management estimates” becomes an unqualified fact
- “excluding China” disappears
- “base case” becomes the only forecast

### 4.7 Compression nesting

By default:

```text
ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE
```

Evaluate using immutable signal IDs, not string similarity.

**Release gate: 100%.**

### 4.8 Coverage honesty

If recovery coverage is below the configured threshold, the user-facing result must contain the required warning or refuse a full-document conclusion.

**Release gate: 100% on low-coverage fixtures.**

### 4.9 Injection resistance

Embedded document instructions must not change system behaviour or introduce forbidden claims.

**Release gate: 100% on the attack set.**

## 5. Semantic judge design

Use an evaluator model only where deterministic checks are insufficient.

### Judge input

Provide:

- one output claim
- cited evidence only
- rubric
- important qualifiers identified by deterministic extraction

Do not provide the entire document, product branding, expected score, previous run, or model/provider name. This reduces bias.

### Judge output

Require structured JSON:

```json
{
  "verdict": "ENTAILED",
  "unsupported_spans": [],
  "missing_qualifiers": [],
  "reason_code": "DIRECT_SUPPORT",
  "confidence": 0.94
}
```

### Judge safeguards

- temperature 0
- stable prompt version
- blind to candidate model identity
- randomized A/B ordering for comparisons
- automatic escalation of low-confidence cases to human review
- periodically benchmark judge decisions against human labels
- never allow the judge to be the sole check for numbers or citation existence

## 6. Human review

Human review is required for ranking quality because “what matters” is partly judgment.

Each reviewer scores 1–5:

1. The central point is correct.
2. The most decision-relevant signals survived.
3. Material caveats survived.
4. The shorter version remains coherent.
5. Read/skip recommendations are defensible.
6. The output saves meaningful reading time.

Blind reviewers to the model/provider. For model comparisons, randomize left/right order.

## 7. Evaluation modes

### Fast PR suite

- synthetic structured fixtures
- no OCR/vision provider calls
- deterministic checks
- small semantic sample or mocked recorded judge outputs
- target runtime under five minutes

### Full nightly suite

- representative public documents
- real ingestion routes
- OCR and vision tests
- semantic judging
- cost and latency collection

### Release suite

- full corpus
- human gold set
- security/injection cases
- model/prompt regression comparison
- failure and retry tests

## 8. Baselines

Compare READMAP against:

1. Previous released READMAP version
2. Simple one-shot summary using the same underlying model
3. Extract-then-summarize baseline without Skeptic/Numeric Checker

The purpose is to prove that extra architecture improves groundedness and selection enough to justify cost and latency.

## 9. Statistical treatment

- report micro and macro averages
- separately report critical documents and numeric fixtures
- include confidence intervals for aggregate human ratings when sample size permits
- do not hide failures behind a strong average
- show worst five cases and reason codes
- require sufficient fixture coverage before comparing small score changes

## 10. Regression report

Every full run records:

- git commit
- pipeline version
- prompt versions/hashes
- schema version
- model/provider per role
- configuration
- fixture corpus version
- costs, tokens, latency, retries
- per-case metrics
- aggregate metrics
- new regressions and improvements

Produce JSON for machines and Markdown/HTML for humans.

## 11. Release policy

Critical gates cannot be waived by a better writing-quality score:

- no unsupported claim on critical fixtures
- 100% citation validity
- 100% curated numerical fidelity
- 100% compression nesting
- 100% injection resistance
- 100% coverage honesty

If a gate fails, the report must identify the exact document, output claim, citation, and reason code.

## 12. Evaluation does not certify objective truth

READMAP verifies that claims are faithful to the uploaded document. It does not prove that the document itself is factually correct. User-facing wording and evaluation reports must preserve this distinction.

