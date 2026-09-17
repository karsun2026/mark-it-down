import type { CheckResult, FixtureScore } from './types';

export type ReleaseGates = {
  minimumCitationValidity: number;
  minimumCompressionNesting: number;
  maximumUnsupportedClaims: number;
  maximumNumericIssues: number;
  allowCriticalCheckFailures: boolean;
};

export type AggregateReport = {
  passed: boolean;
  fixtureCount: number;
  citationValidity: number;
  compressionNesting: number;
  unsupportedClaimCount: number;
  numericIssueCount: number;
  failedCriticalChecks: CheckResult[];
  gateFailures: string[];
};

export function aggregateScores(
  scores: FixtureScore[],
  gates: ReleaseGates,
): AggregateReport {
  const fixtureCount = scores.length;
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const citationValidity = mean(scores.map((score) => score.citationValidity));
  const compressionNesting = mean(scores.map((score) => score.compressionNesting));
  const unsupportedClaimCount = scores.reduce(
    (sum, score) => sum + score.unsupportedClaimCount,
    0,
  );
  const numericIssueCount = scores.reduce((sum, score) => sum + score.numericIssueCount, 0);
  const failedCriticalChecks = scores.flatMap((score) =>
    score.checks.filter((check) => check.severity === 'CRITICAL' && !check.passed),
  );

  const gateFailures: string[] = [];
  if (citationValidity < gates.minimumCitationValidity) {
    gateFailures.push(`Citation validity ${citationValidity} is below ${gates.minimumCitationValidity}.`);
  }
  if (compressionNesting < gates.minimumCompressionNesting) {
    gateFailures.push(
      `Compression nesting ${compressionNesting} is below ${gates.minimumCompressionNesting}.`,
    );
  }
  if (unsupportedClaimCount > gates.maximumUnsupportedClaims) {
    gateFailures.push(`Unsupported claims ${unsupportedClaimCount} exceed the allowed maximum.`);
  }
  if (numericIssueCount > gates.maximumNumericIssues) {
    gateFailures.push(`Numeric issues ${numericIssueCount} exceed the allowed maximum.`);
  }
  if (!gates.allowCriticalCheckFailures && failedCriticalChecks.length > 0) {
    gateFailures.push(`${failedCriticalChecks.length} critical deterministic checks failed.`);
  }

  return {
    passed: gateFailures.length === 0,
    fixtureCount,
    citationValidity,
    compressionNesting,
    unsupportedClaimCount,
    numericIssueCount,
    failedCriticalChecks,
    gateFailures,
  };
}

