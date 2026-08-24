import { Buffer } from 'node:buffer';

export type RegistryLifecycleStatus = 'active' | 'superseded' | 'retired';

export interface RegistryItem {
  readonly id: string;
  readonly kind: 'fact';
  readonly content: string;
  readonly critical: true;
}

export interface RegistryProvenance {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly quoteHash: string;
  readonly span: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
}

export interface RegistryLifecycle {
  readonly status: RegistryLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supersededBy?: string;
}

/** Plain schema-v5 payload in the same insertion order as saveState. */
export interface PersistedRegistry {
  readonly schemaVersion: 5;
  readonly recovery: 'critical';
  readonly extraction: 'off';
  readonly discovery: 'automatic';
  readonly items: readonly RegistryItem[];
  readonly autoItemIds: readonly string[];
  readonly discoveryItemIds: readonly string[];
  readonly discoveryProvenance: Readonly<
    Record<string, readonly RegistryProvenance[]>
  >;
  readonly discoveryLifecycle: Readonly<Record<string, RegistryLifecycle>>;
}

export interface RegistryCounts {
  readonly active: number;
  readonly superseded: number;
  readonly retired: number;
  readonly inactive: number;
}

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

/** A ratio whose denominator may make the measurement not applicable. */
export interface ApplicableRateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly applicable: boolean;
}

export interface RegistryVerificationSummary {
  readonly findingsTotal: number;
  readonly findingsFromActive: number;
  readonly findingsFromInactive: number;
  readonly inactiveShareOfFindings: ApplicableRateSummary;
  readonly inactiveFindingsPerRetainedItem: ApplicableRateSummary;
  readonly inactiveShareOfSnapshot: ApplicableRateSummary;
}

export interface RegistryGrowthCell {
  readonly size: number;
  /** The requested share; counts use deterministic nearest-integer rounding. */
  readonly activeShare: number;
  readonly counts: RegistryCounts;
  readonly stateJsonBytes: number;
  readonly snapshotItems: number;
  readonly snapshotJsonBytes: number;
  readonly verification: RegistryVerificationSummary;
  readonly recoveryEligible: number;
}

export interface RetentionByteComparison {
  readonly bytes: number;
  readonly percent: number;
}

export interface SnapshotRetentionFootprint {
  readonly fullItems: number;
  readonly activeItems: number;
  readonly itemsRemoved: number;
  readonly fullBytes: number;
  readonly activeOnlyBytes: number;
  readonly bytesSaved: number;
  /** Percentage of snapshot items removed, not a byte percentage. */
  readonly percentReduced: number;
}

export interface RetentionDiagnostics {
  readonly metadataOverhead: RetentionByteComparison;
  readonly retentionFootprint: RetentionByteComparison;
  readonly snapshotFootprint: SnapshotRetentionFootprint;
  readonly verification: RegistryVerificationSummary;
}

export const DEFAULT_REGISTRY_SIZES: readonly number[] = [10, 25, 50, 100, 250];
export const DEFAULT_REGISTRY_ACTIVE_SHARES: readonly number[] = [1, 0.75, 0.5, 0.25];

function verificationRatio(
  numerator: number,
  denominator: number,
): ApplicableRateSummary {
  const applicable = denominator !== 0;
  return {
    numerator,
    denominator,
    rate: applicable ? numerator / denominator : null,
    applicable,
  };
}

const CONTENT_WORDS: readonly string[] = [
  'runtime',
  'configuration',
  'observation',
  'worker',
  'package',
  'compiler',
  'lifecycle',
  'retention',
  'verified',
  'synthetic',
  'evidence',
  'stable',
  'record',
  'context',
  'policy',
];

const BASE_TIMESTAMP = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const HOUR_MS = 60 * 60 * 1_000;

function registryId(index: number): string {
  return `discovery:fact:${String(index).padStart(4, '0')}`;
}

function contentFor(index: number): string {
  const targetLength = 80 + ((index * 97 + 31) % 221);
  const sentences = [
    `Synthetic observation ${String(index).padStart(4, '0')} records a durable `,
    'fact from repository-safe benchmark evidence. ',
  ];
  let content = sentences.join('');
  let wordIndex = index * 11 + 3;
  while (content.length < targetLength) {
    const word = CONTENT_WORDS[wordIndex % CONTENT_WORDS.length] ?? 'observation';
    content += `${word} `;
    wordIndex += 7;
  }
  return content.slice(0, targetLength);
}

function hash12(index: number, referenceIndex: number): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const seed = `${index}:${referenceIndex}:synthetic-evidence`;
  for (const character of seed) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + 17), 0x85ebca6b);
  }
  return (
    `${(first >>> 0).toString(16).padStart(8, '0')}` +
    `${(second >>> 0).toString(16).slice(0, 4).padStart(4, '0')}`
  );
}

function timestampFor(index: number, offsetHours: number): string {
  return new Date(BASE_TIMESTAMP + (index * 2 + offsetHours) * HOUR_MS).toISOString();
}

function provenanceFor(
  index: number,
  content: string,
): readonly RegistryProvenance[] {
  const referenceCount = 1 + (index % 2);
  const references: RegistryProvenance[] = [];
  for (let referenceIndex = 0; referenceIndex < referenceCount; referenceIndex += 1) {
    const startOffset = referenceIndex === 0 ? 0 : 16;
    references.push({
      toolCallId: `synthetic-call-${String(index).padStart(4, '0')}-${referenceIndex + 1}`,
      toolName: referenceIndex === 0 ? 'synthetic-read' : 'synthetic-status',
      quoteHash: hash12(index, referenceIndex),
      span: {
        startOffset,
        endOffset: Math.min(content.length, startOffset + 24),
      },
    });
  }
  return references;
}

function activeCountFor(size: number, activeShare: number): number {
  return Math.round(size * activeShare);
}

function validateBuildInputs(size: number, activeShare: number): void {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error('buildRegistry requires a non-negative integer size');
  }
  if (!Number.isFinite(activeShare) || activeShare < 0 || activeShare > 1) {
    throw new Error('buildRegistry requires activeShare between 0 and 1');
  }
}

/**
 * Build a deterministic discovery-only schema-v5 payload. Inactive records are
 * retained in `items`, provenance, and lifecycle just as saveState retains
 * them; no deletion, merge, or supersession decision is performed here.
 */
export function buildRegistry(size: number, activeShare: number): PersistedRegistry {
  validateBuildInputs(size, activeShare);
  const activeCount = activeCountFor(size, activeShare);
  const inactiveCount = size - activeCount;
  const supersededCount = size < 2 ? 0 : Math.ceil(inactiveCount / 2);
  const items: RegistryItem[] = [];
  const discoveryItemIds: string[] = [];
  const discoveryProvenance: Record<string, readonly RegistryProvenance[]> = {};
  const discoveryLifecycle: Record<string, RegistryLifecycle> = {};

  for (let index = 0; index < size; index += 1) {
    const id = registryId(index);
    const content = contentFor(index);
    const item: RegistryItem = {
      id,
      kind: 'fact',
      content,
      critical: true,
    };
    items.push(item);
    discoveryItemIds.push(id);
    discoveryProvenance[id] = provenanceFor(index, content);

    const inactivePosition = index - activeCount;
    const isActive = index < activeCount;
    const isSuperseded =
      !isActive && inactivePosition >= 0 && inactivePosition < supersededCount;
    const status: RegistryLifecycleStatus = isActive
      ? 'active'
      : isSuperseded
        ? 'superseded'
        : 'retired';
    const lifecycleBase = {
      status,
      createdAt: timestampFor(index, 0),
      updatedAt: timestampFor(index, status === 'active' ? 0 : 1),
    };

    if (status === 'superseded') {
      const replacementIndex = activeCount > 0 ? 0 : (index + 1) % size;
      discoveryLifecycle[id] = {
        ...lifecycleBase,
        supersededBy: registryId(replacementIndex),
      };
    } else {
      discoveryLifecycle[id] = lifecycleBase;
    }
  }

  return {
    schemaVersion: 5,
    recovery: 'critical',
    extraction: 'off',
    discovery: 'automatic',
    items,
    autoItemIds: [],
    discoveryItemIds,
    discoveryProvenance,
    discoveryLifecycle,
  };
}

function countsFor(registry: PersistedRegistry): RegistryCounts {
  let active = 0;
  let superseded = 0;
  let retired = 0;
  for (const lifecycle of Object.values(registry.discoveryLifecycle)) {
    switch (lifecycle.status) {
      case 'active':
        active += 1;
        break;
      case 'superseded':
        superseded += 1;
        break;
      case 'retired':
        retired += 1;
        break;
    }
  }
  return {
    active,
    superseded,
    retired,
    inactive: superseded + retired,
  };
}

/** Return the UTF-8 byte length of a JSON serialization. */
export function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

interface RegistrySnapshot {
  readonly schemaVersion: 1;
  readonly items: readonly RegistryItem[];
}

function snapshotFor(registry: PersistedRegistry): RegistrySnapshot {
  return {
    schemaVersion: 1,
    items: registry.items,
  };
}

/**
 * Project a registry to only its active discoveries and associated records.
 *
 * This is a research-only hypothetical that intentionally discards retained
 * inactive history, so it is not valid production persisted state under the
 * package's history-preservation norms. Only inactive (superseded) lifecycle
 * records carry `supersededBy` in this deterministic registry; filtering to
 * active lifecycle entries therefore leaves no dangling `supersededBy` links.
 */
export function projectRegistryActiveOnly(
  registry: PersistedRegistry,
): PersistedRegistry {
  const activeIds = new Set(
    registry.discoveryItemIds.filter(
      (id) => registry.discoveryLifecycle[id]?.status === 'active',
    ),
  );
  const discoveryItemIds = registry.discoveryItemIds.filter((id) =>
    activeIds.has(id),
  );
  const items = registry.items.filter((item) => activeIds.has(item.id));
  const discoveryProvenance: Record<string, readonly RegistryProvenance[]> = {};
  const discoveryLifecycle: Record<string, RegistryLifecycle> = {};

  for (const id of discoveryItemIds) {
    const provenance = registry.discoveryProvenance[id];
    if (provenance !== undefined) {
      discoveryProvenance[id] = provenance;
    }
    const lifecycle = registry.discoveryLifecycle[id];
    if (lifecycle !== undefined) {
      discoveryLifecycle[id] = {
        status: lifecycle.status,
        createdAt: lifecycle.createdAt,
        updatedAt: lifecycle.updatedAt,
      };
    }
  }

  return {
    schemaVersion: registry.schemaVersion,
    recovery: registry.recovery,
    extraction: registry.extraction,
    discovery: registry.discovery,
    items,
    autoItemIds: registry.autoItemIds,
    discoveryItemIds,
    discoveryProvenance,
    discoveryLifecycle,
  };
}

function evaluateCell(size: number, activeShare: number): RegistryGrowthCell {
  const registry = buildRegistry(size, activeShare);
  const counts = countsFor(registry);
  const snapshot = snapshotFor(registry);
  const findingsFromActive = 0;
  const findingsFromInactive = counts.inactive;
  const findingsTotal = findingsFromActive + findingsFromInactive;

  return {
    size,
    activeShare,
    counts,
    stateJsonBytes: jsonBytes(registry),
    snapshotItems: snapshot.items.length,
    snapshotJsonBytes: jsonBytes(snapshot),
    verification: {
      findingsTotal,
      findingsFromActive,
      findingsFromInactive,
      inactiveShareOfFindings: verificationRatio(
        findingsFromInactive,
        findingsTotal,
      ),
      inactiveFindingsPerRetainedItem: verificationRatio(
        findingsFromInactive,
        snapshot.items.length,
      ),
      inactiveShareOfSnapshot: verificationRatio(
        counts.inactive,
        snapshot.items.length,
      ),
    },
    recoveryEligible: counts.active,
  };
}

function validateGrowthInputs(
  sizes: readonly number[],
  activeShares: readonly number[],
): void {
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error('evaluateRegistryGrowth sizes must be non-negative integers');
    }
  }
  for (const activeShare of activeShares) {
    if (!Number.isFinite(activeShare) || activeShare < 0 || activeShare > 1) {
      throw new Error('evaluateRegistryGrowth activeShares must be between 0 and 1');
    }
  }
}

/**
 * Evaluate persisted-state and snapshot retention over a deterministic size /
 * active-share grid. The post-compaction context contains every active content
 * verbatim; therefore each inactive critical discovery contributes one lost
 * finding while active discoveries contribute none.
 */
export function evaluateRegistryGrowth(
  sizes: readonly number[] = DEFAULT_REGISTRY_SIZES,
  activeShares: readonly number[] = DEFAULT_REGISTRY_ACTIVE_SHARES,
): readonly RegistryGrowthCell[] {
  validateGrowthInputs(sizes, activeShares);
  return sizes.flatMap((size) =>
    activeShares.map((activeShare) => evaluateCell(size, activeShare)),
  );
}

function percentageDelta(current: number, baseline: number): number {
  return baseline === 0 ? (current === 0 ? 0 : 100) : ((current - baseline) / baseline) * 100;
}

function registryForCell(cell: RegistryGrowthCell): PersistedRegistry {
  return buildRegistry(cell.size, cell.activeShare);
}

function byteComparison(
  currentBytes: number,
  baselineBytes: number,
): RetentionByteComparison {
  return {
    bytes: currentBytes - baselineBytes,
    percent: percentageDelta(currentBytes, baselineBytes),
  };
}

/**
 * Measure inactive lifecycle-representation overhead against the same-size
 * all-active registry. Both registries retain the same number of items and
 * associated records; only their lifecycle mix differs.
 */
export function inactiveMetadataOverhead(
  cell: RegistryGrowthCell,
): RetentionByteComparison {
  const allActiveBytes = jsonBytes(buildRegistry(cell.size, 1));
  return byteComparison(cell.stateJsonBytes, allActiveBytes);
}

/**
 * Measure full-state bytes against the active-only projection of this logical
 * registry. The projection is a research-only history-discarding hypothetical;
 * it is not a production retention recommendation.
 */
export function inactiveRetentionFootprint(
  cell: RegistryGrowthCell,
): RetentionByteComparison {
  const registry = registryForCell(cell);
  const activeOnlyBytes = jsonBytes(projectRegistryActiveOnly(registry));
  return byteComparison(cell.stateJsonBytes, activeOnlyBytes);
}

/** Compare the all-item snapshot with its active-only snapshot projection. */
export function snapshotRetentionFootprint(
  cell: RegistryGrowthCell,
): SnapshotRetentionFootprint {
  const registry = registryForCell(cell);
  const fullSnapshot = snapshotFor(registry);
  const activeOnlyRegistry = projectRegistryActiveOnly(registry);
  const activeOnlySnapshot: RegistrySnapshot = {
    schemaVersion: 1,
    items: activeOnlyRegistry.items,
  };
  const fullItems = fullSnapshot.items.length;
  const activeItems = activeOnlySnapshot.items.length;
  const itemsRemoved = fullItems - activeItems;
  const fullBytes = cell.snapshotJsonBytes;
  const activeOnlyBytes = jsonBytes(activeOnlySnapshot);

  return {
    fullItems,
    activeItems,
    itemsRemoved,
    fullBytes,
    activeOnlyBytes,
    bytesSaved: fullBytes - activeOnlyBytes,
    percentReduced: fullItems === 0 ? 0 : (itemsRemoved / fullItems) * 100,
  };
}

/** Return all three byte comparisons together with the cell's verification ratios. */
export function retentionDiagnostics(
  cell: RegistryGrowthCell,
): RetentionDiagnostics {
  return {
    metadataOverhead: inactiveMetadataOverhead(cell),
    retentionFootprint: inactiveRetentionFootprint(cell),
    snapshotFootprint: snapshotRetentionFootprint(cell),
    verification: cell.verification,
  };
}
