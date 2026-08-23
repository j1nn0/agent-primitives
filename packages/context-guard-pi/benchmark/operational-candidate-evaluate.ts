import { VERIFICATION_BENCHMARK_CORPUS } from './verification-corpus.js';
import {
  OPERATIONAL_DATASETS,
  type OperationalDataset,
} from './operational-candidate-corpus.js';
import {
  collectDiscoveryAnchors,
  findSupersessionCandidates,
  type CandidateItem,
  type DiscoveryAnchorCategory,
} from '../src/discovery-candidates.js';

const CATEGORIES: readonly DiscoveryAnchorCategory[] = [
  'path',
  'opaque-id',
  'versioned-subject',
];

export interface OperationalMeasurement {
  readonly datasetId: string;
  readonly facts: number;
  /** Facts carrying at least one anchor, and that share of the dataset. */
  readonly anchorBearing: number;
  readonly anchorBearingRate: number;
  readonly anchorsByCategory: Readonly<Record<DiscoveryAnchorCategory, number>>;
  readonly candidateGroups: number;
  /** Facts appearing in some group, and that share of the dataset. */
  readonly participating: number;
  readonly participationRate: number;
  /** Each group's anchors and member contents, for review by a person. */
  readonly groups: readonly {
    readonly anchors: readonly string[];
    readonly contents: readonly string[];
  }[];
}

/**
 * The verification corpus, reduced to its distinct item contents. It was written
 * to exercise compaction verification, long before candidates existed, which is
 * exactly what makes it useful here.
 */
export function independentDataset(): OperationalDataset {
  const byContent = new Map<string, string>();
  for (const testCase of VERIFICATION_BENCHMARK_CORPUS) {
    if (!byContent.has(testCase.itemContent)) {
      byContent.set(testCase.itemContent, testCase.id);
    }
  }
  return {
    id: 'independent',
    kind: 'independent',
    provenance:
      'Distinct item contents of the verification benchmark corpus, written before the candidate feature existed.',
    facts: Array.from(byContent, ([content, id]) => ({ id, content })),
  };
}

export function operationalDatasets(): readonly OperationalDataset[] {
  return [independentDataset(), ...OPERATIONAL_DATASETS];
}

export function measureDataset(
  dataset: OperationalDataset,
): OperationalMeasurement {
  const anchorsByCategory: Record<DiscoveryAnchorCategory, number> = {
    path: 0,
    'opaque-id': 0,
    'versioned-subject': 0,
  };
  let anchorBearing = 0;
  for (const fact of dataset.facts) {
    const anchors = collectDiscoveryAnchors(fact.content, CATEGORIES);
    if (anchors.length > 0) {
      anchorBearing += 1;
    }
    for (const anchor of anchors) {
      anchorsByCategory[anchor.category] += 1;
    }
  }

  const contentById = new Map(
    dataset.facts.map((fact: CandidateItem) => [fact.id, fact.content]),
  );
  const groups = findSupersessionCandidates(dataset.facts, CATEGORIES);
  const participating = new Set(groups.flatMap((group) => [...group.itemIds]));
  const total = Math.max(1, dataset.facts.length);

  return {
    datasetId: dataset.id,
    facts: dataset.facts.length,
    anchorBearing,
    anchorBearingRate: anchorBearing / total,
    anchorsByCategory,
    candidateGroups: groups.length,
    participating: participating.size,
    participationRate: participating.size / total,
    groups: groups.map((group) => ({
      anchors: group.anchors.map(
        (anchor) => `${anchor.category}:${anchor.value}`,
      ),
      contents: group.itemIds.map((id) => contentById.get(id) ?? ''),
    })),
  };
}

export function measureOperationalDatasets(): readonly OperationalMeasurement[] {
  return operationalDatasets().map(measureDataset);
}

/**
 * A dataset producing no groups is not a failure. The command is precision-first,
 * so silence is its ordinary output on content with no shared structural token.
 */
export function candidateZeroRate(
  measurements: readonly OperationalMeasurement[],
): number {
  if (measurements.length === 0) {
    return 0;
  }
  const silent = measurements.filter(
    (measurement) => measurement.candidateGroups === 0,
  ).length;
  return silent / measurements.length;
}

export function formatOperationalTable(
  measurements: readonly OperationalMeasurement[],
): string {
  const header =
    'dataset        facts  anchored  rate   path  opaque  version  groups  participating';
  const rows = measurements.map((measurement) =>
    [
      measurement.datasetId.padEnd(14),
      String(measurement.facts).padStart(5),
      String(measurement.anchorBearing).padStart(9),
      `${(measurement.anchorBearingRate * 100).toFixed(0)}%`.padStart(6),
      String(measurement.anchorsByCategory.path).padStart(6),
      String(measurement.anchorsByCategory['opaque-id']).padStart(7),
      String(measurement.anchorsByCategory['versioned-subject']).padStart(8),
      String(measurement.candidateGroups).padStart(7),
      String(measurement.participating).padStart(14),
    ].join(''),
  );
  return [header, ...rows].join('\n');
}
