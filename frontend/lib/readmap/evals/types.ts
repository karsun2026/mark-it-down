/**
 * Eval-harness types, ported from readmap-eval-harness/src/types.ts (plan §2:
 * "harness port"). Kept verbatim so the offline scorer in this repository and
 * the standalone harness never drift apart.
 */

export type CompressionTier =
  | "DEEP_DIVE"
  | "READMAP"
  | "BRIEF"
  | "QUICK_SCAN"
  | "BRUTAL"
  | "ONE_THING";

export type EvidenceBlock = {
  id: string;
  documentId: string;
  pageNumber: number;
  normalizedText: string;
};

export type NumericAtom = {
  value: number;
  unit?: string;
  scale?: "ONES" | "THOUSAND" | "MILLION" | "BILLION" | "TRILLION";
  currency?: string;
  period?: string;
  direction?: "UP" | "DOWN" | "FLAT";
  status?: "ACTUAL" | "FORECAST" | "TARGET" | "UNKNOWN";
};

export type OutputClaim = {
  id: string;
  text: string;
  signalIds: string[];
  evidenceBlockIds: string[];
  epistemicStatus: "FACT" | "SOURCE_OPINION" | "FORECAST" | "INTERPRETATION";
  numbers?: NumericAtom[];
};

export type ReadMapEvalOutput = {
  documentId: string;
  totalPages: number;
  recoveredPages: number;
  coverageWarningShown: boolean;
  evidenceBlocks: EvidenceBlock[];
  supportedSignalIds: string[];
  claims: OutputClaim[];
  tiers: Record<CompressionTier, string[]>;
};

export type GoldSignal = {
  id: string;
  description: string;
  importance: "ESSENTIAL" | "USEFUL" | "LOW_VALUE";
  requiredByTier?: CompressionTier[];
};

export type EvalFixture = {
  id: string;
  title: string;
  category: string;
  critical: boolean;
  structuredEvidence?: EvidenceBlock[];
  expected: {
    goldSignals: GoldSignal[];
    forbiddenClaimPatterns: string[];
    expectedNumbers?: NumericAtom[];
    minimumCoverage?: number;
    requiresCoverageWarning?: boolean;
  };
};

export type CheckResult = {
  check: string;
  passed: boolean;
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  fixtureId: string;
  claimId?: string;
  details?: string;
};

export type FixtureScore = {
  fixtureId: string;
  checks: CheckResult[];
  citationValidity: number;
  compressionNesting: number;
  unsupportedClaimCount: number;
  numericIssueCount: number;
};