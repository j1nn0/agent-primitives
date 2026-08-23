import {
  DISCOVERY_FRAGMENTATION_CLASSES,
  DISCOVERY_GRANULARITY_CATEGORIES,
  DISCOVERY_GRANULARITY_CORPUS,
  type DiscoveryFragmentationClass,
  type DiscoveryGranularityCategory,
  type DiscoveryGranularityLanguage,
  type DiscoveryGranularityScenario,
} from './discovery-granularity-corpus.js';

export type RecordedTurnFact = {
  readonly content: string;
  /** Evidence indices in capture order; e1/e2 and zero-based strings are accepted. */
  readonly evidenceRefs: readonly string[];
};

export type CapturedTurn = {
  readonly turnIndex: number;
  readonly evidenceCount: number;
  readonly facts: readonly RecordedTurnFact[];
};

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export type DiscoveryCountBucket = 1 | 2 | 3 | 4;

export interface CaptureSummary {
  readonly turnsWithFacts: number;
  readonly totalFacts: number;
  readonly discoveriesPerTurn: Readonly<Record<DiscoveryCountBucket, number>>;
  /** Mean over every recorded turn, including turns whose fact count is zero. */
  readonly mean: number;
  /** Median over every recorded turn, including turns whose fact count is zero. */
  readonly median: number;
  readonly max: number;
}

export interface EvidenceMultiplicitySummary {
  readonly unitsTotal: number;
  readonly unitsWithGt1Fact: number;
  readonly maxFactsPerUnit: number;
  readonly amplification: RateSummary;
}

export interface SimulatedCapture {
  readonly turns: readonly CapturedTurn[];
  readonly facts: readonly RecordedTurnFact[];
}

export interface CorpusInvariantSummary {
  readonly scenarioCount: number;
  readonly categoryCounts: Readonly<Record<DiscoveryGranularityCategory, number>>;
  readonly languageCounts: Readonly<Record<DiscoveryGranularityLanguage, number>>;
  readonly fragmentationClassCounts: Readonly<
    Record<DiscoveryFragmentationClass, number>
  >;
  readonly claimsInEvidence: boolean;
  readonly idsUnique: boolean;
  readonly categoryCoverage: boolean;
  readonly groupingMetadataValid: boolean;
  readonly missingCategories: readonly DiscoveryGranularityCategory[];
  readonly invariantChecks: Readonly<{
    readonly claimsInEvidence: boolean;
    readonly idsUnique: boolean;
    readonly categoryCoverage: boolean;
    readonly groupingMetadataValid: boolean;
  }>;
}

function rateSummary(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function emptyDiscoveryDistribution(): Record<DiscoveryCountBucket, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return sorted.length % 2 === 1
    ? upper ?? 0
    : ((lower ?? 0) + (upper ?? 0)) / 2;
}

/**
 * Summarize observed fact counts. The mean and median include zero-add turns;
 * a separate `turnsWithFacts` count keeps those two populations visible.
 */
export function summarizeCapture(
  turns: readonly CapturedTurn[] = [],
): CaptureSummary {
  const discoveriesPerTurn = emptyDiscoveryDistribution();
  const factCounts = turns.map(({ facts }) => facts.length);
  let turnsWithFacts = 0;
  let totalFacts = 0;
  let max = 0;

  for (const factCount of factCounts) {
    if (factCount > 0) {
      turnsWithFacts += 1;
    }
    totalFacts += factCount;
    max = Math.max(max, factCount);
    if (factCount >= 1 && factCount <= 4) {
      discoveriesPerTurn[factCount as DiscoveryCountBucket] += 1;
    }
  }

  return {
    turnsWithFacts,
    totalFacts,
    discoveriesPerTurn,
    mean: turns.length === 0 ? 0 : totalFacts / turns.length,
    median: median(factCounts),
    max,
  };
}

function evidenceIndex(reference: string, evidenceCount: number): number | undefined {
  const trimmed = reference.trim();
  const oneBasedMatch = /^e(\d+)$/u.exec(trimmed);
  if (oneBasedMatch !== null) {
    const oneBased = Number(oneBasedMatch[1]);
    if (Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= evidenceCount) {
      return oneBased - 1;
    }
    return undefined;
  }

  if (/^\d+$/u.test(trimmed)) {
    const zeroBased = Number(trimmed);
    if (Number.isInteger(zeroBased) && zeroBased >= 0 && zeroBased < evidenceCount) {
      return zeroBased;
    }
  }
  return undefined;
}

/**
 * Measure how many captured facts point at each evidence unit. `unitsTotal` is
 * the number of evidence records reported by the turns, including units that
 * no accepted fact referenced. A fact is counted once per referenced unit.
 */
export function summarizeEvidenceMultiplicity(
  turns: readonly CapturedTurn[] = [],
): EvidenceMultiplicitySummary {
  let unitsTotal = 0;
  let unitsWithGt1Fact = 0;
  let maxFactsPerUnit = 0;
  let totalFacts = 0;

  for (const turn of turns) {
    const evidenceCount = Math.max(0, Math.floor(turn.evidenceCount));
    unitsTotal += evidenceCount;
    const factsPerUnit = new Map<number, number>();
    for (const fact of turn.facts) {
      totalFacts += 1;
      const referencedUnits = new Set<number>();
      for (const reference of fact.evidenceRefs) {
        const index = evidenceIndex(reference, evidenceCount);
        if (index !== undefined) {
          referencedUnits.add(index);
        }
      }
      for (const index of referencedUnits) {
        factsPerUnit.set(index, (factsPerUnit.get(index) ?? 0) + 1);
      }
    }

    for (const factCount of factsPerUnit.values()) {
      if (factCount > 1) {
        unitsWithGt1Fact += 1;
      }
      maxFactsPerUnit = Math.max(maxFactsPerUnit, factCount);
    }
  }

  return {
    unitsTotal,
    unitsWithGt1Fact,
    maxFactsPerUnit,
    amplification: rateSummary(totalFacts, unitsTotal),
  };
}

function validateCap(cap: number): asserts cap is 1 | 2 | 3 | 4 {
  if (cap !== 1 && cap !== 2 && cap !== 3 && cap !== 4) {
    throw new Error('simulateCapTailDrop requires a cap of 1, 2, 3, or 4');
  }
}

/**
 * Keep the first `cap` facts in each turn's capture order.
 *
 * This is deliberately named `capTailDrop`: it simulates dropping the tail of
 * an already accepted output. It does not model production's atomic response
 * validation, where a response with more than four facts rejects the entire
 * response and persists nothing. The model's add-array ordering also has no
 * documented contract, so this is a capture-order simulation only.
 */
export function simulateCapTailDrop(
  turns: readonly CapturedTurn[],
  cap: 1 | 2 | 3 | 4,
): SimulatedCapture {
  validateCap(cap);
  const survivingTurns: CapturedTurn[] = [];
  const survivingFacts: RecordedTurnFact[] = [];

  for (const turn of turns) {
    const facts = turn.facts.slice(0, cap);
    survivingTurns.push({
      turnIndex: turn.turnIndex,
      evidenceCount: turn.evidenceCount,
      facts,
    });
    survivingFacts.push(...facts);
  }

  return { turns: survivingTurns, facts: survivingFacts };
}

/** Short name used in hypothesis tables and notes. */
export const capTailDrop = simulateCapTailDrop;

/**
 * Keep the first fact for each first provenance reference in a turn.
 *
 * The bounded recorded-turn shape has no separate evidence-record table, so
 * `evidenceRefs[0]` is the offline proxy for the first provenance reference's
 * toolCallId. Real replay records should encode that reference consistently;
 * facts with no reference are retained rather than silently grouped together.
 * As with `capTailDrop`, this is a hypothesis simulation, not production logic.
 */
export function simulateOneFactPerToolCallId(
  turns: readonly CapturedTurn[],
): SimulatedCapture {
  const survivingTurns: CapturedTurn[] = [];
  const survivingFacts: RecordedTurnFact[] = [];

  for (const turn of turns) {
    const seenToolCallIds = new Set<string>();
    const facts: RecordedTurnFact[] = [];
    for (const fact of turn.facts) {
      const firstReference = fact.evidenceRefs[0];
      if (firstReference === undefined) {
        facts.push(fact);
        survivingFacts.push(fact);
        continue;
      }
      if (seenToolCallIds.has(firstReference)) {
        continue;
      }
      seenToolCallIds.add(firstReference);
      facts.push(fact);
      survivingFacts.push(fact);
    }
    survivingTurns.push({
      turnIndex: turn.turnIndex,
      evidenceCount: turn.evidenceCount,
      facts,
    });
  }

  return { turns: survivingTurns, facts: survivingFacts };
}

/** Short name used in hypothesis tables and notes. */
export const oneFactPerToolCallId = simulateOneFactPerToolCallId;

/**
 * Calculate retention recall for claims that were present in the original
 * facts. Both the baseline and survivor checks use exact, case-sensitive
 * substring presence; there is no semantic, fuzzy, or normalized matching.
 */
export function claimRecall(
  originalFacts: readonly RecordedTurnFact[],
  survivingFacts: readonly RecordedTurnFact[],
  expectedClaims: readonly string[],
): RateSummary {
  const originalClaims = expectedClaims.filter((claim) =>
    originalFacts.some((fact) => fact.content.includes(claim)),
  );
  const survivingClaims = originalClaims.filter((claim) =>
    survivingFacts.some((fact) => fact.content.includes(claim)),
  );
  return rateSummary(survivingClaims.length, originalClaims.length);
}

function emptyCategoryCounts(): Record<DiscoveryGranularityCategory, number> {
  const counts = {} as Record<DiscoveryGranularityCategory, number>;
  for (const category of DISCOVERY_GRANULARITY_CATEGORIES) {
    counts[category] = 0;
  }
  return counts;
}

function emptyLanguageCounts(): Record<DiscoveryGranularityLanguage, number> {
  return { en: 0, ja: 0, mixed: 0 };
}

function emptyClassCounts(): Record<DiscoveryFragmentationClass, number> {
  const counts = {} as Record<DiscoveryFragmentationClass, number>;
  for (const fragmentationClass of DISCOVERY_FRAGMENTATION_CLASSES) {
    counts[fragmentationClass] = 0;
  }
  return counts;
}

/** Count corpus scenarios by their required category. */
export function countScenariosByCategory(
  corpus: readonly DiscoveryGranularityScenario[] = DISCOVERY_GRANULARITY_CORPUS,
): Readonly<Record<DiscoveryGranularityCategory, number>> {
  const counts = emptyCategoryCounts();
  for (const scenario of corpus) {
    counts[scenario.category] += 1;
  }
  return counts;
}

/** Count only scenarios that carry one of the explicit language labels. */
export function countScenariosByLanguage(
  corpus: readonly DiscoveryGranularityScenario[] = DISCOVERY_GRANULARITY_CORPUS,
): Readonly<Record<DiscoveryGranularityLanguage, number>> {
  const counts = emptyLanguageCounts();
  for (const scenario of corpus) {
    if (scenario.language !== undefined) {
      counts[scenario.language] += 1;
    }
  }
  return counts;
}

/** Count corpus scenarios by the input-side fragmentation relationship. */
export function countScenariosByClass(
  corpus: readonly DiscoveryGranularityScenario[] = DISCOVERY_GRANULARITY_CORPUS,
): Readonly<Record<DiscoveryFragmentationClass, number>> {
  const counts = emptyClassCounts();
  for (const scenario of corpus) {
    counts[scenario.fragmentationClass] += 1;
  }
  return counts;
}

function groupingMetadataIsValid(
  scenario: DiscoveryGranularityScenario,
): boolean {
  const acceptable = scenario.acceptableGroupings ?? [];
  const unacceptable = scenario.unacceptableGroupings ?? [];
  const validValues = (values: readonly number[]): boolean =>
    new Set(values).size === values.length &&
    values.every(
      (value) => Number.isInteger(value) && value >= 1 && value <= 4,
    );
  if (!validValues(acceptable) || !validValues(unacceptable)) {
    return false;
  }
  return unacceptable.every((value) => !acceptable.includes(value));
}

/**
 * Check the input-side corpus without pretending to evaluate a model. This is
 * intentionally separate from captured-turn simulations: a scenario supplies
 * evidence and expected claims, but no model-produced facts.
 */
export function corpusInvariants(
  corpus: readonly DiscoveryGranularityScenario[] = DISCOVERY_GRANULARITY_CORPUS,
): CorpusInvariantSummary {
  const categoryCounts = countScenariosByCategory(corpus);
  const languageCounts = countScenariosByLanguage(corpus);
  const fragmentationClassCounts = countScenariosByClass(corpus);
  const idsUnique = new Set(corpus.map(({ id }) => id)).size === corpus.length;
  const claimsInEvidence = corpus.every((scenario) => {
    const evidenceText = scenario.evidence.map(({ text }) => text).join('');
    return scenario.expectedClaims.every((claim) => evidenceText.includes(claim));
  });
  const missingCategories = DISCOVERY_GRANULARITY_CATEGORIES.filter(
    (category) => categoryCounts[category] === 0,
  );
  const categoryCoverage = missingCategories.length === 0;
  const groupingMetadataValid = corpus.every(groupingMetadataIsValid);
  const invariantChecks = {
    claimsInEvidence,
    idsUnique,
    categoryCoverage,
    groupingMetadataValid,
  };

  return {
    scenarioCount: corpus.length,
    categoryCounts,
    languageCounts,
    fragmentationClassCounts,
    claimsInEvidence,
    idsUnique,
    categoryCoverage,
    groupingMetadataValid,
    missingCategories,
    invariantChecks,
  };
}

/** Compatibility entry point: this phase evaluates corpus invariants only. */
export const evaluateGranularityCorpus = corpusInvariants;
