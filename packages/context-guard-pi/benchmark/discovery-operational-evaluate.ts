/**
 * Deterministic, provider-free aggregation for operational discovery fixtures.
 * Missing observational metadata remains null or explicitly not applicable; it
 * is never silently treated as a zero-valued observation.
 */

import type {
  OperationalLifecycleCounts,
  OperationalLifecycleTransitions,
  OperationalSessionRecord,
  OperationalSessionQuality,
} from './discovery-operational-recorded.js';

export interface ApplicableRateSummary {
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly rate: number | null;
  readonly applicable: boolean;
}

export type OperationalHistogramBucket = 0 | 1 | 2 | 3 | 4;
export type OperationalHistogram = Readonly<
  Record<OperationalHistogramBucket, number>
>;

export interface OperationalMultiplicitySummary {
  readonly multiFactEvidenceUnits: number;
  readonly maxFactsPerOneEvidenceUnit: number;
}

export interface OperationalSessionLifecycleSummary {
  readonly finalLifecycleCounts?: OperationalLifecycleCounts;
  readonly statusUnknownCount: number;
  readonly transitions?: OperationalLifecycleTransitions;
  /** True when lifecycle events were not observable in this record. */
  readonly unobserved: boolean;
}

export interface OperationalSessionSummary {
  readonly sessionId: string;
  readonly source: string;
  readonly modelId?: string;
  readonly quality: OperationalSessionQuality;
  readonly assistantTurns: number | null;
  readonly eligibleEvidenceTurns: number | null;
  readonly discoveryProducingTurns: number | null;
  readonly eligibleEvidenceUnits: number | null;
  readonly discoveries: number;
  readonly discoveriesPerTurnHistogram: OperationalHistogram | null;
  readonly histogramNotApplicable: boolean;
  readonly mean: number | null;
  readonly median: number | null;
  readonly captureYield: ApplicableRateSummary;
  readonly producingRate: ApplicableRateSummary;
  readonly multiplicity: OperationalMultiplicitySummary | null;
  readonly lifecycle: OperationalSessionLifecycleSummary;
}

export interface OperationalAggregateLifecycleSummary {
  readonly naturalRetire: number;
  readonly naturalSupersede: number;
  readonly experimentalRetire: number;
  readonly experimentalSupersede: number;
  readonly unknownRetire: number;
  readonly unknownSupersede: number;
  readonly sessionsWithUnobservedLifecycle: number;
  readonly statusUnknownCount: number;
}

export interface OperationalAggregateSummary {
  readonly sessions: number;
  readonly richSessions: number;
  readonly factOnlySessions: number;
  readonly assistantTurns: number;
  readonly eligibleEvidenceTurns: number;
  readonly discoveryProducingTurns: number;
  readonly eligibleEvidenceUnits: number;
  /** Includes fact-level-only contents as well as rich-session discoveries. */
  readonly discoveries: number;
  /** Discoveries from rich sessions, the only population with an evidence denominator. */
  readonly richDiscoveries: number;
  readonly discoveriesPerTurnHistogram: OperationalHistogram | null;
  readonly histogramNotApplicable: boolean;
  readonly mean: number | null;
  readonly median: number | null;
  readonly captureYield: ApplicableRateSummary;
  readonly producingRate: ApplicableRateSummary;
  readonly lifecycle: OperationalAggregateLifecycleSummary;
}

function emptyHistogram(): Record<OperationalHistogramBucket, number> {
  return { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return sorted.length % 2 === 1
    ? upper ?? null
    : ((lower ?? 0) + (upper ?? 0)) / 2;
}

function applicableRate(
  numerator: number | null,
  denominator: number | null,
): ApplicableRateSummary {
  const applicable =
    numerator !== null && denominator !== null && denominator !== 0;
  return {
    numerator,
    denominator,
    rate: applicable ? numerator / denominator : null,
    applicable,
  };
}

function contentIsValid(content: unknown): content is string {
  return typeof content === 'string' && content.length > 0 && content.length <= 500;
}

function validateQuality(quality: OperationalSessionQuality): void {
  if (
    typeof quality !== 'object' ||
    quality === null ||
    typeof quality.isRealPi !== 'boolean' ||
    typeof quality.isSynthetic !== 'boolean' ||
    typeof quality.hasTurnMetadata !== 'boolean' ||
    typeof quality.hasEvidenceMetadata !== 'boolean'
  ) {
    throw new Error('Operational session quality flags are invalid');
  }
}


function validateTurnData(
  turns: NonNullable<OperationalSessionRecord['capturedTurns']>,
): void {
  for (const turn of turns) {
    if (
      !Number.isInteger(turn.turnIndex) ||
      !Number.isInteger(turn.evidenceCount) ||
      turn.evidenceCount < 0 ||
      !Array.isArray(turn.facts) ||
      turn.facts.length > 4
    ) {
      throw new Error('Operational captured turn metadata is invalid');
    }
    for (const fact of turn.facts) {
      if (!contentIsValid(fact.content)) {
        throw new Error('Operational fact content is invalid');
      }
      if (!Array.isArray(fact.evidenceRefs)) {
        throw new Error('Operational evidence references are invalid');
      }
      for (const reference of fact.evidenceRefs) {
        const match = /^e([1-9]\d*)$/u.exec(reference);
        const oneBased = match === null ? NaN : Number(match[1]);
        if (!Number.isInteger(oneBased) || oneBased > turn.evidenceCount) {
          throw new Error('Operational evidence reference is out of range');
        }
      }
    }
  }
}

/** Validate one fixture without coercing missing observability into zero. */
export function validateOperationalSessionRecord(
  record: OperationalSessionRecord,
): void {
  if (
    typeof record.sessionId !== 'string' ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error('Operational sessionId must be non-empty');
  }
  validateQuality(record.quality);
  if (
    !Number.isInteger(record.statusUnknownCount) ||
    record.statusUnknownCount < 0
  ) {
    throw new Error('Operational statusUnknownCount must be a non-negative integer');
  }

  const hasCapturedTurns = record.capturedTurns !== undefined;
  const hasFactContents = record.factContents !== undefined;
  if (hasCapturedTurns === hasFactContents) {
    throw new Error(
      'Operational record must contain exactly one of capturedTurns or factContents',
    );
  }

  if (hasCapturedTurns) {
    if (!record.quality.hasTurnMetadata) {
      throw new Error('Captured turns require hasTurnMetadata=true');
    }
    validateTurnData(record.capturedTurns);
    return;
  }

  if (record.quality.hasTurnMetadata || record.quality.hasEvidenceMetadata) {
    throw new Error(
      'Fact-level records require hasTurnMetadata=false and hasEvidenceMetadata=false',
    );
  }
  if (!Array.isArray(record.factContents)) {
    throw new Error('Operational factContents must be an array');
  }
  if (!record.factContents.every(contentIsValid)) {
    throw new Error('Operational fact-level content is invalid');
  }
}

function evidenceMultiplicity(
  turns: NonNullable<OperationalSessionRecord['capturedTurns']>,
): OperationalMultiplicitySummary {
  let multiFactEvidenceUnits = 0;
  let maxFactsPerOneEvidenceUnit = 0;

  for (const turn of turns) {
    const factsPerEvidenceUnit = new Map<number, number>();
    for (const fact of turn.facts) {
      const referencedUnits = new Set<number>();
      for (const reference of fact.evidenceRefs) {
        const oneBased = Number(reference.slice(1));
        referencedUnits.add(oneBased - 1);
      }
      for (const evidenceIndex of referencedUnits) {
        factsPerEvidenceUnit.set(
          evidenceIndex,
          (factsPerEvidenceUnit.get(evidenceIndex) ?? 0) + 1,
        );
      }
    }
    for (const factCount of factsPerEvidenceUnit.values()) {
      if (factCount > 1) {
        multiFactEvidenceUnits += 1;
      }
      maxFactsPerOneEvidenceUnit = Math.max(
        maxFactsPerOneEvidenceUnit,
        factCount,
      );
    }
  }

  return { multiFactEvidenceUnits, maxFactsPerOneEvidenceUnit };
}

function lifecycleSummary(
  record: OperationalSessionRecord,
): OperationalSessionLifecycleSummary {
  return {
    ...(record.finalLifecycleCounts === undefined
      ? {}
      : { finalLifecycleCounts: record.finalLifecycleCounts }),
    statusUnknownCount: record.statusUnknownCount,
    ...(record.transitions === undefined
      ? {}
      : { transitions: record.transitions }),
    unobserved: record.transitions === undefined,
  };
}

/** Summarize one rich or fact-level operational recording. */
export function summarizeOperationalSession(
  record: OperationalSessionRecord,
): OperationalSessionSummary {
  validateOperationalSessionRecord(record);
  const turns = record.capturedTurns;
  if (turns === undefined) {
    const discoveries = record.factContents?.length ?? 0;
    return {
      sessionId: record.sessionId,
      source: record.source,
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      quality: record.quality,
      assistantTurns: null,
      eligibleEvidenceTurns: null,
      discoveryProducingTurns: null,
      eligibleEvidenceUnits: null,
      discoveries,
      discoveriesPerTurnHistogram: null,
      histogramNotApplicable: true,
      mean: null,
      median: null,
      captureYield: applicableRate(discoveries, null),
      producingRate: applicableRate(null, null),
      multiplicity: null,
      lifecycle: lifecycleSummary(record),
    };
  }

  const histogram = emptyHistogram();
  const factCounts = turns.map(({ facts }) => facts.length);
  let eligibleEvidenceTurns = 0;
  let eligibleEvidenceUnits = 0;
  let discoveries = 0;
  let discoveryProducingTurns = 0;
  for (const turn of turns) {
    if (turn.evidenceCount > 0) {
      eligibleEvidenceTurns += 1;
    }
    eligibleEvidenceUnits += turn.evidenceCount;
    discoveries += turn.facts.length;
    if (turn.facts.length > 0) {
      discoveryProducingTurns += 1;
    }
    histogram[turn.facts.length as OperationalHistogramBucket] += 1;
  }

  return {
    sessionId: record.sessionId,
    source: record.source,
    ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
    quality: record.quality,
    assistantTurns: turns.length,
    eligibleEvidenceTurns,
    discoveryProducingTurns,
    eligibleEvidenceUnits,
    discoveries,
    discoveriesPerTurnHistogram: histogram,
    histogramNotApplicable: false,
    mean: turns.length === 0 ? null : discoveries / turns.length,
    median: median(factCounts),
    captureYield: applicableRate(discoveries, eligibleEvidenceUnits),
    producingRate: applicableRate(
      discoveryProducingTurns,
      eligibleEvidenceUnits,
    ),
    multiplicity: record.quality.hasEvidenceMetadata
      ? evidenceMultiplicity(turns)
      : null,
    lifecycle: lifecycleSummary(record),
  };
}

function addHistogram(
  target: Record<OperationalHistogramBucket, number>,
  source: OperationalHistogram,
): void {
  for (const bucket of [0, 1, 2, 3, 4] as const) {
    target[bucket] += source[bucket];
  }
}

/** Aggregate fixtures in an order-independent, provider-free manner. */
export function aggregateOperationalSessions(
  records: readonly OperationalSessionRecord[],
): OperationalAggregateSummary {
  const summaries = records.map(summarizeOperationalSession);
  const histogram = emptyHistogram();
  const richFactCounts: number[] = [];
  let richSessions = 0;
  let factOnlySessions = 0;
  let assistantTurns = 0;
  let eligibleEvidenceTurns = 0;
  let discoveryProducingTurns = 0;
  let eligibleEvidenceUnits = 0;
  let discoveries = 0;
  let richDiscoveries = 0;
  let lifecycleNaturalRetire = 0;
  let lifecycleNaturalSupersede = 0;
  let lifecycleExperimentalRetire = 0;
  let lifecycleExperimentalSupersede = 0;
  let lifecycleUnknownRetire = 0;
  let lifecycleUnknownSupersede = 0;
  let sessionsWithUnobservedLifecycle = 0;
  let statusUnknownCount = 0;

  for (const [index, summary] of summaries.entries()) {
    discoveries += summary.discoveries;
    statusUnknownCount += summary.lifecycle.statusUnknownCount;
    if (summary.lifecycle.transitions === undefined) {
      sessionsWithUnobservedLifecycle += 1;
    } else {
      lifecycleNaturalRetire += summary.lifecycle.transitions.natural.retire;
      lifecycleNaturalSupersede += summary.lifecycle.transitions.natural.supersede;
      lifecycleExperimentalRetire +=
        summary.lifecycle.transitions.experimental.retire;
      lifecycleExperimentalSupersede +=
        summary.lifecycle.transitions.experimental.supersede;
      lifecycleUnknownRetire += summary.lifecycle.transitions.unknown.retire;
      lifecycleUnknownSupersede +=
        summary.lifecycle.transitions.unknown.supersede;
    }

    if (summary.assistantTurns === null) {
      factOnlySessions += 1;
      continue;
    }

    richSessions += 1;
    assistantTurns += summary.assistantTurns;
    eligibleEvidenceTurns += summary.eligibleEvidenceTurns ?? 0;
    discoveryProducingTurns += summary.discoveryProducingTurns ?? 0;
    eligibleEvidenceUnits += summary.eligibleEvidenceUnits ?? 0;
    richDiscoveries += summary.discoveries;
    if (summary.discoveriesPerTurnHistogram !== null) {
      addHistogram(histogram, summary.discoveriesPerTurnHistogram);
    }
    const record = records[index];
    if (record?.capturedTurns !== undefined) {
      richFactCounts.push(...record.capturedTurns.map(({ facts }) => facts.length));
    }
  }

  const hasRichSessions = richSessions > 0;
  return {
    sessions: records.length,
    richSessions,
    factOnlySessions,
    assistantTurns,
    eligibleEvidenceTurns,
    discoveryProducingTurns,
    eligibleEvidenceUnits,
    discoveries,
    richDiscoveries,
    discoveriesPerTurnHistogram: hasRichSessions ? histogram : null,
    histogramNotApplicable: !hasRichSessions,
    mean: hasRichSessions && assistantTurns > 0 ? richDiscoveries / assistantTurns : null,
    median: hasRichSessions ? median(richFactCounts) : null,
    captureYield: hasRichSessions
      ? applicableRate(richDiscoveries, eligibleEvidenceUnits)
      : applicableRate(null, null),
    producingRate: hasRichSessions
      ? applicableRate(discoveryProducingTurns, eligibleEvidenceUnits)
      : applicableRate(null, null),
    lifecycle: {
      naturalRetire: lifecycleNaturalRetire,
      naturalSupersede: lifecycleNaturalSupersede,
      experimentalRetire: lifecycleExperimentalRetire,
      experimentalSupersede: lifecycleExperimentalSupersede,
      unknownRetire: lifecycleUnknownRetire,
      unknownSupersede: lifecycleUnknownSupersede,
      sessionsWithUnobservedLifecycle,
      statusUnknownCount,
    },
  };
}
