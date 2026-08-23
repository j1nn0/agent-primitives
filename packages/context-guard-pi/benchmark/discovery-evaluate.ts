import {
  SECRET_SENTINELS,
  type DiscoveryBenchmarkCase,
  type DiscoveryBenchmarkCategory,
} from './discovery-corpus.js';

export type DiscoveryBenchmarkOutcome =
  | 'success'
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output';

export interface ParsedDiscoveryFact {
  readonly content: string;
  readonly evidenceIds: readonly string[];
}

export interface ParsedDiscoveryOutput {
  readonly caseId: string;
  readonly outcome: DiscoveryBenchmarkOutcome;
  readonly facts: readonly ParsedDiscoveryFact[];
}

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface UnsupportedCaptureReasons {
  readonly omitCase: number;
  readonly forbidden: number;
  readonly outOfScopeReference: number;
}

export interface DiscoveryFactDiagnostic {
  readonly content: string;
  readonly evidenceNative: boolean;
  readonly anchored: boolean;
  readonly forbidden: boolean;
  readonly outOfScopeReference: boolean;
}

export interface DiscoveryCaseDiagnostic {
  readonly caseId: string;
  readonly category: DiscoveryBenchmarkCategory;
  readonly factCount: number;
  readonly facts: readonly DiscoveryFactDiagnostic[];
}

export interface DuplicateAmplificationGroup {
  readonly semanticKey: string;
  readonly observations: number;
  readonly distinctContents: number;
  readonly amplification: number;
}

export interface DuplicateAmplificationSummary {
  readonly groups: readonly DuplicateAmplificationGroup[];
  readonly meanAmplification: number;
}

export interface DiscoveryEvaluation {
  readonly totalCases: number;
  readonly qualityCaseCount: number;
  readonly providerFailures: readonly string[];
  readonly capture: RateSummary;
  readonly expectedFactCapture: RateSummary;
  readonly anchorCoverage: RateSummary;
  readonly negativeRejection: RateSummary;
  readonly unsupportedCaptureCount: number;
  readonly unsupportedCaptureReasons: UnsupportedCaptureReasons;
  readonly evidenceNativeRate: RateSummary;
  readonly synthesisRate: RateSummary;
  readonly structuralGateCapture: RateSummary;
  readonly duplicateAmplification: DuplicateAmplificationSummary;
  readonly sameContentRate: RateSummary;
  readonly multiEvidenceUsefulness: RateSummary;
  readonly secretSentinelCount: number;
  readonly diagnostics: readonly DiscoveryCaseDiagnostic[];
}

interface NormalizedFact {
  readonly content: string;
  readonly evidenceIds: readonly string[];
  readonly malformedReference: boolean;
}

interface ScoredFact {
  readonly definition: DiscoveryBenchmarkCase;
  readonly fact: NormalizedFact;
  readonly diagnostic: DiscoveryFactDiagnostic;
}

interface ScoredCase {
  readonly definition: DiscoveryBenchmarkCase;
  readonly output: ParsedDiscoveryOutput | undefined;
  readonly facts: readonly ScoredFact[];
}

function rateSummary(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function normalizeFact(candidate: unknown): NormalizedFact {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !('content' in candidate) ||
    !('evidenceIds' in candidate)
  ) {
    return {
      content: '',
      evidenceIds: [],
      malformedReference: true,
    };
  }

  const content =
    typeof candidate.content === 'string' ? candidate.content : '';
  if (!Array.isArray(candidate.evidenceIds)) {
    return {
      content,
      evidenceIds: [],
      malformedReference: true,
    };
  }

  const evidenceIds: string[] = [];
  let malformedReference = false;
  for (const evidenceId of candidate.evidenceIds) {
    if (typeof evidenceId === 'string') {
      evidenceIds.push(evidenceId);
    } else {
      malformedReference = true;
    }
  }

  return { content, evidenceIds, malformedReference };
}

function factsForOutput(
  output: ParsedDiscoveryOutput | undefined,
): readonly NormalizedFact[] {
  if (
    output === undefined ||
    output.outcome !== 'success' ||
    !Array.isArray(output.facts)
  ) {
    return [];
  }
  return output.facts.map((candidate) => normalizeFact(candidate));
}

function evidenceById(
  definition: DiscoveryBenchmarkCase,
): ReadonlyMap<string, string> {
  return new Map(
    definition.evidence.map((record, index) => [`e${index + 1}`, record.text]),
  );
}

function hasRequiredAnchors(
  content: string,
  anchors: readonly string[],
): boolean {
  return anchors.every((anchor) => content.includes(anchor));
}

function presentAnchorCount(
  content: string,
  anchors: readonly string[],
): number {
  return anchors.filter((anchor) => content.includes(anchor)).length;
}

function hasForbiddenSubstring(
  content: string,
  forbiddenSubstrings: readonly string[],
): boolean {
  const lowerContent = content.toLowerCase();
  return forbiddenSubstrings.some(
    (substring) =>
      substring.length > 0 && lowerContent.includes(substring.toLowerCase()),
  );
}

function hasOutOfScopeReference(
  fact: NormalizedFact,
  allowedEvidenceIds: readonly string[],
): boolean {
  return (
    fact.malformedReference ||
    fact.evidenceIds.some(
      (evidenceId) => !allowedEvidenceIds.includes(evidenceId),
    )
  );
}

function scoreFact(
  definition: DiscoveryBenchmarkCase,
  fact: NormalizedFact,
): ScoredFact {
  const evidenceTexts = evidenceById(definition);
  const anchored = hasRequiredAnchors(fact.content, definition.requiredAnchors);
  const evidenceNative = fact.evidenceIds.some((evidenceId) => {
    const text = evidenceTexts.get(evidenceId);
    return text !== undefined && text.includes(fact.content);
  });
  const forbidden = hasForbiddenSubstring(
    fact.content,
    definition.forbiddenSubstrings,
  );
  const outOfScopeReference = hasOutOfScopeReference(
    fact,
    definition.allowedEvidenceIds,
  );

  return {
    definition,
    fact,
    diagnostic: {
      content: fact.content,
      evidenceNative,
      anchored,
      forbidden,
      outOfScopeReference,
    },
  };
}

function scoreCase(
  definition: DiscoveryBenchmarkCase,
  output: ParsedDiscoveryOutput | undefined,
): ScoredCase {
  const facts = factsForOutput(output).map((fact) =>
    scoreFact(definition, fact),
  );
  return { definition, output, facts };
}

function contentSet(facts: readonly ScoredFact[]): ReadonlySet<string> {
  return new Set(facts.map(({ fact }) => fact.content));
}

function setsIntersect(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function duplicateAmplification(
  cases: readonly ScoredCase[],
): DuplicateAmplificationSummary {
  const groups = new Map<
    string,
    { observations: number; contents: Set<string> }
  >();

  for (const scoredCase of cases) {
    if (
      scoredCase.definition.expectation !== 'capture' ||
      scoredCase.definition.semanticKey === undefined
    ) {
      continue;
    }

    const group = groups.get(scoredCase.definition.semanticKey) ?? {
      observations: 0,
      contents: new Set<string>(),
    };
    if (scoredCase.facts.length > 0) {
      group.observations += 1;
      for (const { fact } of scoredCase.facts) {
        group.contents.add(fact.content);
      }
    }
    groups.set(scoredCase.definition.semanticKey, group);
  }

  const summaries = Array.from(groups, ([semanticKey, group]) => ({
    semanticKey,
    observations: group.observations,
    distinctContents: group.contents.size,
    amplification: group.contents.size,
  }));
  const observedGroups = summaries.filter(
    ({ observations }) => observations >= 2,
  );
  const meanAmplification =
    observedGroups.length === 0
      ? 1
      : observedGroups.reduce(
          (total, group) => total + group.amplification,
          0,
        ) / observedGroups.length;

  return { groups: summaries, meanAmplification };
}

function sameContentRate(cases: readonly ScoredCase[]): RateSummary {
  const repeatedCases = cases.filter(
    ({ definition }) =>
      definition.category === 'repeated-exact' &&
      definition.expectation === 'capture',
  );
  const firstCapturingCase = repeatedCases.find(
    ({ facts }) => facts.length > 0,
  );
  if (firstCapturingCase === undefined) {
    return rateSummary(0, 0);
  }

  const firstContents = contentSet(firstCapturingCase.facts);
  const firstIndex = repeatedCases.indexOf(firstCapturingCase);
  const laterCapturingCases = repeatedCases
    .slice(firstIndex + 1)
    .filter(({ facts }) => facts.length > 0);
  let numerator = 0;
  for (const laterCase of laterCapturingCases) {
    if (setsIntersect(firstContents, contentSet(laterCase.facts))) {
      numerator += 1;
    }
  }
  return rateSummary(numerator, laterCapturingCases.length);
}

export function evaluateDiscoveryBenchmark(
  cases: readonly DiscoveryBenchmarkCase[],
  outputs: readonly ParsedDiscoveryOutput[],
): DiscoveryEvaluation {
  const outputByCaseId = new Map(
    outputs.map((output) => [output.caseId, output]),
  );
  const scoredCases = cases.map((definition) =>
    scoreCase(definition, outputByCaseId.get(definition.id)),
  );
  const qualityCases = scoredCases.filter(
    ({ output }) => output?.outcome === 'success',
  );
  const providerFailures = scoredCases.flatMap(({ definition, output }) =>
    output?.outcome === 'success' ? [] : [definition.id],
  );

  const captureCases = qualityCases.filter(
    ({ definition }) => definition.expectation === 'capture',
  );
  const omitCases = qualityCases.filter(
    ({ definition }) => definition.expectation === 'omit',
  );
  const capturedCases = captureCases.filter(({ facts }) => facts.length > 0);
  const anchoredCaptureCases = captureCases.filter(({ facts }) =>
    facts.some(({ diagnostic }) => diagnostic.anchored),
  );
  const structuralCaptureCases = captureCases.filter(({ facts }) =>
    facts.some(
      ({ diagnostic }) => diagnostic.evidenceNative && diagnostic.anchored,
    ),
  );

  let anchorNumerator = 0;
  let anchorDenominator = 0;
  for (const { definition, facts } of capturedCases) {
    const bestAnchorCount = facts.reduce(
      (best, { fact }) =>
        Math.max(
          best,
          presentAnchorCount(fact.content, definition.requiredAnchors),
        ),
      0,
    );
    anchorNumerator += bestAnchorCount;
    anchorDenominator += definition.requiredAnchors.length;
  }

  let unsupportedCaptureCount = 0;
  let omitCaseCount = 0;
  let forbiddenCount = 0;
  let outOfScopeReferenceCount = 0;
  let evidenceNativeCount = 0;
  let acceptedFactCount = 0;
  let secretSentinelCount = 0;

  for (const scoredCase of qualityCases) {
    for (const scoredFact of scoredCase.facts) {
      const { diagnostic, fact } = scoredFact;
      const omitCase = scoredCase.definition.expectation === 'omit';
      if (omitCase) {
        omitCaseCount += 1;
      }
      if (diagnostic.forbidden) {
        forbiddenCount += 1;
      }
      if (diagnostic.outOfScopeReference) {
        outOfScopeReferenceCount += 1;
      }
      if (omitCase || diagnostic.forbidden || diagnostic.outOfScopeReference) {
        unsupportedCaptureCount += 1;
      }

      acceptedFactCount += 1;
      if (diagnostic.evidenceNative) {
        evidenceNativeCount += 1;
      }
      if (
        SECRET_SENTINELS.some((sentinel) => fact.content.includes(sentinel))
      ) {
        secretSentinelCount += 1;
      }
    }
  }

  // A non-success output cannot contain an accepted production fact, but count
  // sentinel-bearing records defensively when callers provide malformed input.
  for (const scoredCase of scoredCases) {
    if (scoredCase.output?.outcome === 'success') {
      continue;
    }
    for (const fact of factsForOutput(scoredCase.output)) {
      if (
        SECRET_SENTINELS.some((sentinel) => fact.content.includes(sentinel))
      ) {
        secretSentinelCount += 1;
      }
    }
  }

  const diagnostics = scoredCases.map(({ definition, facts }) => ({
    caseId: definition.id,
    category: definition.category,
    factCount: facts.length,
    facts: facts.map(({ diagnostic }) => diagnostic),
  }));

  return {
    totalCases: cases.length,
    qualityCaseCount: qualityCases.length,
    providerFailures,
    capture: rateSummary(capturedCases.length, captureCases.length),
    expectedFactCapture: rateSummary(
      anchoredCaptureCases.length,
      captureCases.length,
    ),
    anchorCoverage: rateSummary(anchorNumerator, anchorDenominator),
    negativeRejection: rateSummary(
      omitCases.filter(({ facts }) => facts.length === 0).length,
      omitCases.length,
    ),
    unsupportedCaptureCount,
    unsupportedCaptureReasons: {
      omitCase: omitCaseCount,
      forbidden: forbiddenCount,
      outOfScopeReference: outOfScopeReferenceCount,
    },
    evidenceNativeRate: rateSummary(evidenceNativeCount, acceptedFactCount),
    synthesisRate: rateSummary(
      acceptedFactCount - evidenceNativeCount,
      acceptedFactCount,
    ),
    structuralGateCapture: rateSummary(
      structuralCaptureCases.length,
      captureCases.length,
    ),
    duplicateAmplification: duplicateAmplification(qualityCases),
    sameContentRate: sameContentRate(qualityCases),
    multiEvidenceUsefulness: rateSummary(
      qualityCases
        .filter(({ definition }) => definition.category === 'multi-evidence')
        .filter(({ facts }) =>
          facts.some(({ diagnostic }) => diagnostic.anchored),
        ).length,
      qualityCases.filter(
        ({ definition }) => definition.category === 'multi-evidence',
      ).length,
    ),
    secretSentinelCount,
    diagnostics,
  };
}

export const evaluateDiscovery = evaluateDiscoveryBenchmark;
