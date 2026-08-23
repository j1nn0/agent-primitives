import {
  SEMANTIC_CANDIDATE_CORPUS,
  type OrderedDiscovery,
  type OrderedScenario,
} from './semantic-candidate-corpus.js';
import type { RateSummary } from './semantic-duplicate-evaluate.js';

export type CandidatePair = readonly [number, number];

export type CandidateStrategyName =
  | 'recent-5'
  | 'recent-10'
  | 'recent-20'
  | 'sameTool'
  | 'composite'
  | 'allPairs';

export type CandidateGenerator = (
  scenario: OrderedScenario,
) => readonly CandidatePair[];

export interface CandidateStrategy {
  readonly name: CandidateStrategyName;
  readonly generate: CandidateGenerator;
}

export interface MissedDuplicatePair {
  readonly scenarioId: string;
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly distance: number;
}

export interface CandidateScenarioEvaluation {
  readonly strategy: CandidateStrategyName;
  readonly scenarioId: string;
  readonly candidatePairCount: number;
  readonly fullPairCount: number;
  readonly pairReductionRate: number;
  readonly duplicatePairRecall: RateSummary;
  readonly duplicateGroupRecall: RateSummary;
  readonly hardNegativeCandidateCount: number;
  readonly hardNegativeRetentionRate: number;
  readonly missedDuplicatePairs: readonly MissedDuplicatePair[];
}

export interface CandidateAggregateEvaluation {
  readonly strategy: CandidateStrategyName;
  readonly candidatePairCount: number;
  readonly fullPairCount: number;
  readonly pairReductionRate: number;
  readonly duplicatePairRecall: RateSummary;
  readonly duplicateGroupRecall: RateSummary;
  readonly hardNegativeCandidateCount: number;
  readonly hardNegativeRetentionRate: number;
  readonly missedDuplicatePairs: readonly MissedDuplicatePair[];
}

export interface DuplicateDistanceSummary {
  readonly minimum: number;
  readonly median: number;
  readonly maximum: number;
  readonly distances: readonly number[];
}

export interface SemanticCandidateReport {
  readonly perScenario: readonly CandidateScenarioEvaluation[];
  readonly aggregate: readonly CandidateAggregateEvaluation[];
  readonly distanceSummary: DuplicateDistanceSummary;
}

interface ActiveDiscovery {
  readonly index: number;
  readonly discovery: OrderedDiscovery;
}

function rateSummary(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function pairKey(pair: CandidatePair): string {
  return `${pair[0]}:${pair[1]}`;
}

function canonicalPair(leftIndex: number, rightIndex: number): CandidatePair {
  return leftIndex < rightIndex
    ? [leftIndex, rightIndex]
    : [rightIndex, leftIndex];
}

function activeDiscoveries(scenario: OrderedScenario): readonly ActiveDiscovery[] {
  return scenario.discoveries
    .map((discovery, index) => ({ index, discovery }))
    .filter(({ discovery }) => discovery.status === 'active');
}

function activePairs(scenario: OrderedScenario): readonly CandidatePair[] {
  const active = activeDiscoveries(scenario);
  const pairs: CandidatePair[] = [];
  for (let rightPosition = 0; rightPosition < active.length; rightPosition += 1) {
    const right = active[rightPosition];
    if (right === undefined) {
      continue;
    }
    for (let leftPosition = 0; leftPosition < rightPosition; leftPosition += 1) {
      const left = active[leftPosition];
      if (left !== undefined) {
        pairs.push(canonicalPair(left.index, right.index));
      }
    }
  }
  return pairs;
}

/**
 * Return pairs within an active-registration window. Registration order is
 * search locality, never truth freshness: a nearby fact is not a truer fact.
 * This intentionally does not consult createdAt, updatedAt, or any content.
 */
export function recentWindow(windowSize: number): CandidateGenerator {
  if (!Number.isInteger(windowSize) || windowSize < 0) {
    throw new Error('recentWindow requires a non-negative integer');
  }

  return (scenario) => {
    const active = activeDiscoveries(scenario);
    const pairs: CandidatePair[] = [];
    for (let rightPosition = 0; rightPosition < active.length; rightPosition += 1) {
      const right = active[rightPosition];
      if (right === undefined) {
        continue;
      }
      const firstPreviousPosition = Math.max(0, rightPosition - windowSize);
      for (
        let leftPosition = firstPreviousPosition;
        leftPosition < rightPosition;
        leftPosition += 1
      ) {
        const left = active[leftPosition];
        if (left !== undefined) {
          pairs.push(canonicalPair(left.index, right.index));
        }
      }
    }
    return pairs;
  };
}

export function sameTool(scenario: OrderedScenario): readonly CandidatePair[] {
  const active = activeDiscoveries(scenario);
  const pairs: CandidatePair[] = [];
  for (let rightPosition = 0; rightPosition < active.length; rightPosition += 1) {
    const right = active[rightPosition];
    if (right === undefined) {
      continue;
    }
    for (let leftPosition = 0; leftPosition < rightPosition; leftPosition += 1) {
      const left = active[leftPosition];
      if (left !== undefined && left.discovery.toolName === right.discovery.toolName) {
        pairs.push(canonicalPair(left.index, right.index));
      }
    }
  }
  return pairs;
}

export function composite(scenario: OrderedScenario): readonly CandidatePair[] {
  const recent = new Set(recentWindow(10)(scenario).map(pairKey));
  return sameTool(scenario).filter((pair) => recent.has(pairKey(pair)));
}

export function allPairs(scenario: OrderedScenario): readonly CandidatePair[] {
  return activePairs(scenario);
}

export const CANDIDATE_STRATEGIES: readonly CandidateStrategy[] = [
  { name: 'recent-5', generate: recentWindow(5) },
  { name: 'recent-10', generate: recentWindow(10) },
  { name: 'recent-20', generate: recentWindow(20) },
  { name: 'sameTool', generate: sameTool },
  { name: 'composite', generate: composite },
  { name: 'allPairs', generate: allPairs },
];

export const SEMANTIC_CANDIDATE_STRATEGIES = CANDIDATE_STRATEGIES;

export function discoveryDistance(leftIndex: number, rightIndex: number): number {
  return Math.abs(rightIndex - leftIndex);
}


function uniquePairs(pairs: readonly CandidatePair[]): readonly CandidatePair[] {
  const seen = new Set<string>();
  const unique: CandidatePair[] = [];
  for (const pair of pairs) {
    const canonical = canonicalPair(pair[0], pair[1]);
    const key = pairKey(canonical);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(canonical);
    }
  }
  return unique;
}

function groupIsConnected(
  group: readonly number[],
  candidatePairs: readonly CandidatePair[],
): boolean {
  if (group.length < 2) {
    return true;
  }

  const members = new Set(group);
  const adjacency = new Map<number, Set<number>>();
  for (const member of group) {
    adjacency.set(member, new Set());
  }
  for (const [leftIndex, rightIndex] of candidatePairs) {
    if (!members.has(leftIndex) || !members.has(rightIndex)) {
      continue;
    }
    const leftNeighbours = adjacency.get(leftIndex);
    const rightNeighbours = adjacency.get(rightIndex);
    if (leftNeighbours !== undefined && rightNeighbours !== undefined) {
      leftNeighbours.add(rightIndex);
      rightNeighbours.add(leftIndex);
    }
  }

  const firstMember = group[0];
  if (firstMember === undefined) {
    return true;
  }
  const visited = new Set<number>([firstMember]);
  const pending = [firstMember];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const neighbours = adjacency.get(current);
    if (neighbours === undefined) {
      continue;
    }
    for (const neighbour of neighbours) {
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        pending.push(neighbour);
      }
    }
  }
  return visited.size === members.size;
}

function strategyByName(name: CandidateStrategyName): CandidateStrategy {
  const strategy = CANDIDATE_STRATEGIES.find((candidate) => candidate.name === name);
  if (strategy === undefined) {
    throw new Error(`Unknown candidate strategy: ${name}`);
  }
  return strategy;
}

export function evaluateCandidateScenario(
  scenario: OrderedScenario,
  strategy: CandidateStrategyName | CandidateStrategy,
): CandidateScenarioEvaluation {
  const resolved = typeof strategy === 'string' ? strategyByName(strategy) : strategy;
  const candidatePairs = uniquePairs(resolved.generate(scenario));
  const candidateKeys = new Set(candidatePairs.map(pairKey));
  const active = activeDiscoveries(scenario);
  const activeIndexes = new Set(active.map(({ index }) => index));
  const expectedPairs = uniquePairs(scenario.duplicatePairs).filter(
    ([leftIndex, rightIndex]) =>
      activeIndexes.has(leftIndex) && activeIndexes.has(rightIndex),
  );
  const expectedKeys = new Set(expectedPairs.map(pairKey));
  const expectedGroups = scenario.duplicateGroups
    .map((group) => group.filter((index) => activeIndexes.has(index)))
    .filter((group) => group.length >= 2);
  const fullPairCount = (active.length * (active.length - 1)) / 2;
  const duplicatePairHits = expectedPairs.filter((pair) =>
    candidateKeys.has(pairKey(pair)),
  ).length;
  const duplicateGroupHits = expectedGroups.filter((group) =>
    groupIsConnected(group, candidatePairs),
  ).length;
  const hardNegativeCandidateCount = candidatePairs.filter(
    (pair) => !expectedKeys.has(pairKey(pair)),
  ).length;
  const fullHardNegativeCount = fullPairCount - expectedPairs.length;
  const missedDuplicatePairs = expectedPairs
    .filter((pair) => !candidateKeys.has(pairKey(pair)))
    .map(([leftIndex, rightIndex]) => ({
      scenarioId: scenario.id,
      leftIndex,
      rightIndex,
      distance: discoveryDistance(leftIndex, rightIndex),
    }));

  return {
    strategy: resolved.name,
    scenarioId: scenario.id,
    candidatePairCount: candidatePairs.length,
    fullPairCount,
    pairReductionRate:
      fullPairCount === 0 ? 0 : 1 - candidatePairs.length / fullPairCount,
    duplicatePairRecall: rateSummary(duplicatePairHits, expectedPairs.length),
    duplicateGroupRecall: rateSummary(
      duplicateGroupHits,
      expectedGroups.length,
    ),
    hardNegativeCandidateCount,
    hardNegativeRetentionRate:
      fullHardNegativeCount === 0
        ? 1
        : hardNegativeCandidateCount / fullHardNegativeCount,
    missedDuplicatePairs,
  };
}

export function evaluateCandidateStrategy(
  scenario: OrderedScenario,
  strategy: CandidateStrategyName | CandidateStrategy,
): CandidateScenarioEvaluation;
export function evaluateCandidateStrategy(
  strategy: CandidateStrategyName | CandidateStrategy,
  scenario: OrderedScenario,
): CandidateScenarioEvaluation;
export function evaluateCandidateStrategy(
  first: OrderedScenario | CandidateStrategyName | CandidateStrategy,
  second: OrderedScenario | CandidateStrategyName | CandidateStrategy,
): CandidateScenarioEvaluation {
  if (typeof first === 'object' && 'discoveries' in first) {
    return evaluateCandidateScenario(
      first,
      second as CandidateStrategyName | CandidateStrategy,
    );
  }
  return evaluateCandidateScenario(
    second as OrderedScenario,
    first as CandidateStrategyName | CandidateStrategy,
  );
}


function compareEvaluations(
  left: CandidateScenarioEvaluation,
  right: CandidateScenarioEvaluation,
): number {
  return left.scenarioId.localeCompare(right.scenarioId) ||
    left.strategy.localeCompare(right.strategy);
}

function fullHardNegativePairCount(scenario: OrderedScenario): number {
  const active = activeDiscoveries(scenario);
  const activeIndexes = new Set(active.map(({ index }) => index));
  const activeExpectedPairs = uniquePairs(scenario.duplicatePairs).filter(
    ([leftIndex, rightIndex]) =>
      activeIndexes.has(leftIndex) && activeIndexes.has(rightIndex),
  );
  const fullPairCount = (active.length * (active.length - 1)) / 2;
  return fullPairCount - new Set(activeExpectedPairs.map(pairKey)).size;
}

function aggregateStrategy(
  strategy: CandidateStrategyName,
  evaluations: readonly CandidateScenarioEvaluation[],
  scenarios: readonly OrderedScenario[],
): CandidateAggregateEvaluation {
  const candidatePairCount = evaluations.reduce(
    (total, evaluation) => total + evaluation.candidatePairCount,
    0,
  );
  const fullPairCount = evaluations.reduce(
    (total, evaluation) => total + evaluation.fullPairCount,
    0,
  );
  const duplicatePairNumerator = evaluations.reduce(
    (total, evaluation) =>
      total + evaluation.duplicatePairRecall.numerator,
    0,
  );
  const duplicatePairDenominator = evaluations.reduce(
    (total, evaluation) =>
      total + evaluation.duplicatePairRecall.denominator,
    0,
  );
  const duplicateGroupNumerator = evaluations.reduce(
    (total, evaluation) =>
      total + evaluation.duplicateGroupRecall.numerator,
    0,
  );
  const duplicateGroupDenominator = evaluations.reduce(
    (total, evaluation) =>
      total + evaluation.duplicateGroupRecall.denominator,
    0,
  );
  const fullHardNegativeCount = scenarios.reduce(
    (total, scenario) => total + fullHardNegativePairCount(scenario),
    0,
  );
  const hardNegativeCandidateCount = evaluations.reduce(
    (total, evaluation) => total + evaluation.hardNegativeCandidateCount,
    0,
  );

  return {
    strategy,
    candidatePairCount,
    fullPairCount,
    pairReductionRate:
      fullPairCount === 0 ? 0 : 1 - candidatePairCount / fullPairCount,
    duplicatePairRecall: rateSummary(
      duplicatePairNumerator,
      duplicatePairDenominator,
    ),
    duplicateGroupRecall: rateSummary(
      duplicateGroupNumerator,
      duplicateGroupDenominator,
    ),
    hardNegativeCandidateCount,
    hardNegativeRetentionRate:
      fullHardNegativeCount === 0
        ? 1
        : hardNegativeCandidateCount / fullHardNegativeCount,
    missedDuplicatePairs: evaluations.flatMap(
      (evaluation) => evaluation.missedDuplicatePairs,
    ),
  };
}


export function summarizeDuplicateDistances(
  scenarios: readonly OrderedScenario[] = SEMANTIC_CANDIDATE_CORPUS,
): DuplicateDistanceSummary {
  const distances = scenarios
    .flatMap((scenario) =>
      scenario.duplicatePairs.map(([leftIndex, rightIndex]) =>
        discoveryDistance(leftIndex, rightIndex),
      ),
    )
    .sort((left, right) => left - right);
  const middle = Math.floor(distances.length / 2);
  const lower = distances[middle - 1];
  const upper = distances[middle];
  const median =
    distances.length === 0
      ? 0
      : distances.length % 2 === 1
        ? upper ?? 0
        : ((lower ?? 0) + (upper ?? 0)) / 2;
  return {
    minimum: distances[0] ?? 0,
    median,
    maximum: distances[distances.length - 1] ?? 0,
    distances,
  };
}

export const duplicateDistanceSummary = summarizeDuplicateDistances();

export function evaluateSemanticCandidateBenchmark(
  scenarios: readonly OrderedScenario[] = SEMANTIC_CANDIDATE_CORPUS,
): SemanticCandidateReport {
  const perScenario = CANDIDATE_STRATEGIES.flatMap((strategy) =>
    scenarios.map((scenario) =>
      evaluateCandidateScenario(scenario, strategy),
    ),
  ).sort(compareEvaluations);
  const aggregate = CANDIDATE_STRATEGIES.map((strategy) =>
    aggregateStrategy(
      strategy.name,
      perScenario.filter((evaluation) => evaluation.strategy === strategy.name),
      scenarios,
    ),
  );
  return {
    perScenario,
    aggregate,
    distanceSummary: summarizeDuplicateDistances(scenarios),
  };
}

