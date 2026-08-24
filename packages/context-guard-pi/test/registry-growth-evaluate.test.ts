import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  buildRegistry,
  evaluateRegistryGrowth,
  inactiveMetadataOverhead,
  inactiveRetentionFootprint,
  jsonBytes,
  projectRegistryActiveOnly,
  retentionDiagnostics,
  snapshotRetentionFootprint,
} from '../benchmark/registry-growth-evaluate.js';

function cellFor(size: number, activeShare: number) {
  const [cell] = evaluateRegistryGrowth([size], [activeShare]);
  if (cell === undefined) {
    throw new Error(`Expected a cell for size ${size} and share ${activeShare}`);
  }
  return cell;
}

function utf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Expected JSON serialization to produce a string');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function containsNaN(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isNaN(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsNaN);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsNaN);
  }
  return false;
}

describe('registry growth evaluator', () => {
  it('builds a deterministic schema-v5 discovery-only payload', () => {
    const registry = buildRegistry(10, 0.5);
    expect(registry.schemaVersion).toBe(5);
    expect(registry.items).toHaveLength(10);
    expect(registry.autoItemIds).toEqual([]);
    expect(registry.discoveryItemIds).toEqual(
      registry.items.map(({ id }) => id),
    );
    expect(
      registry.items.every(({ kind, critical }) => kind === 'fact' && critical),
    ).toBe(true);
    expect(
      registry.items.every(
        ({ content }) => content.length >= 80 && content.length <= 300,
      ),
    ).toBe(true);
    expect(
      registry.items.some(
        (item, index) =>
          item.content.length !== registry.items[0]?.content.length || index === 0,
      ),
    ).toBe(true);
    expect(
      Object.values(registry.discoveryProvenance).every(
        (references) => references.length === 1 || references.length === 2,
      ),
    ).toBe(true);
    expect(
      Object.values(registry.discoveryLifecycle).every(
        ({ status, supersededBy }) =>
          status !== 'superseded' ||
          (supersededBy !== undefined && supersededBy !== ''),
      ),
    ).toBe(true);
  });

  it('measures inactive metadata overhead against an independent all-active baseline', () => {
    const cell = cellFor(100, 0.25);
    const mixedRegistry = buildRegistry(100, 0.25);
    const allActiveRegistry = buildRegistry(100, 1);
    const mixedBytes = utf8Bytes(mixedRegistry);
    const allActiveBytes = utf8Bytes(allActiveRegistry);
    const expectedBytes = mixedBytes - allActiveBytes;
    const overhead = inactiveMetadataOverhead(cell);
    const footprint = inactiveRetentionFootprint(cell);

    expect(overhead.bytes).toBe(expectedBytes);
    expect(overhead.percent).toBe(
      (expectedBytes / allActiveBytes) * 100,
    );
    expect(overhead.bytes).toBeGreaterThan(0);
    expect(overhead.bytes).toBeLessThan(footprint.bytes);
  });

  it('measures the full-state retention footprint against an active-only projection', () => {
    const cell = cellFor(100, 0.25);
    const registry = buildRegistry(100, 0.25);
    const projected = projectRegistryActiveOnly(registry);
    const expectedBytes = utf8Bytes(registry) - utf8Bytes(projected);
    const footprint = inactiveRetentionFootprint(cell);
    const activeCell = cellFor(100, 1);
    const shares = [1, 0.75, 0.5, 0.25, 0];
    const footprints = evaluateRegistryGrowth([100], shares).map(
      (candidate) => inactiveRetentionFootprint(candidate).bytes,
    );
    const footprintPercents = evaluateRegistryGrowth([100], shares).map(
      (candidate) => inactiveRetentionFootprint(candidate).percent,
    );

    expect(footprint.bytes).toBe(expectedBytes);
    expect(footprint.percent).toBe(
      (expectedBytes / utf8Bytes(projected)) * 100,
    );
    expect(inactiveRetentionFootprint(activeCell)).toEqual({
      bytes: 0,
      percent: 0,
    });
    for (let index = 1; index < footprints.length; index += 1) {
      expect(footprints[index]).toBeGreaterThanOrEqual(footprints[index - 1] ?? 0);
    }
    for (let index = 1; index < footprintPercents.length; index += 1) {
      expect(footprintPercents[index]).toBeGreaterThanOrEqual(
        footprintPercents[index - 1] ?? 0,
      );
    }
  });

  it('projects exactly the active discovery records without dangling supersession links', () => {
    const registry = buildRegistry(25, 0.5);
    const activeIds = registry.discoveryItemIds.filter(
      (id) => registry.discoveryLifecycle[id]?.status === 'active',
    );
    const projected = projectRegistryActiveOnly(registry);

    expect(projected.discoveryItemIds).toEqual(activeIds);
    expect(projected.items.map(({ id }) => id)).toEqual(activeIds);
    expect(Object.keys(projected.discoveryProvenance)).toEqual(activeIds);
    expect(Object.keys(projected.discoveryLifecycle)).toEqual(activeIds);
    expect(projected.items).toHaveLength(activeIds.length);
    expect(
      Object.values(projected.discoveryLifecycle).every(
        (lifecycle) => !Object.hasOwn(lifecycle, 'supersededBy'),
      ),
    ).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('supersededBy');
  });

  it('reports snapshot item and byte reduction against an active-only snapshot', () => {
    const cell = cellFor(100, 0.25);
    const registry = buildRegistry(100, 0.25);
    const projected = projectRegistryActiveOnly(registry);
    const footprint = snapshotRetentionFootprint(cell);
    const expectedFullBytes = utf8Bytes({
      schemaVersion: 1 as const,
      items: registry.items,
    });
    const expectedActiveOnlyBytes = utf8Bytes({
      schemaVersion: 1 as const,
      items: projected.items,
    });

    expect(footprint).toEqual({
      fullItems: 100,
      activeItems: cell.counts.active,
      itemsRemoved: cell.counts.inactive,
      fullBytes: expectedFullBytes,
      activeOnlyBytes: expectedActiveOnlyBytes,
      bytesSaved: expectedFullBytes - expectedActiveOnlyBytes,
      percentReduced: (cell.counts.inactive / 100) * 100,
    });
  });

  it('keeps the three verification ratios distinct and marks unavailable ratios', () => {
    const mixed = cellFor(20, 0.5);
    const inactive = mixed.counts.inactive;
    const retainedItems = mixed.snapshotItems;
    const verification = mixed.verification;

    expect(verification).toHaveProperty('inactiveShareOfFindings');
    expect(verification).toHaveProperty('inactiveFindingsPerRetainedItem');
    expect(verification).toHaveProperty('inactiveShareOfSnapshot');
    expect(verification.inactiveShareOfFindings).toMatchObject({
      numerator: inactive,
      denominator: inactive,
      rate: 1,
      applicable: true,
    });
    expect(verification.inactiveFindingsPerRetainedItem).toMatchObject({
      numerator: inactive,
      denominator: retainedItems,
      rate: inactive / retainedItems,
      applicable: true,
    });
    expect(verification.inactiveShareOfSnapshot).toMatchObject({
      numerator: inactive,
      denominator: retainedItems,
      rate: inactive / retainedItems,
      applicable: true,
    });

    const allActive = cellFor(20, 1);
    expect(allActive.verification.findingsTotal).toBe(0);
    expect(allActive.verification.inactiveShareOfFindings).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      applicable: false,
    });
  });

  it('measures JSON in UTF-8 bytes rather than UTF-16 code units', () => {
    const value = { text: '保持される日本語の事実' };
    const serialized = JSON.stringify(value);
    expect(serialized).toBeDefined();
    if (serialized === undefined) {
      return;
    }
    expect(jsonBytes(value)).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(jsonBytes(value)).not.toBe(serialized.length);
  });

  it('handles zero-size, all-active, and all-inactive registries without NaN', () => {
    for (const cell of evaluateRegistryGrowth([0], [0, 0.5, 1])) {
      expect(cell.counts).toEqual({
        active: 0,
        superseded: 0,
        retired: 0,
        inactive: 0,
      });
      expect(cell.snapshotItems).toBe(0);
      expect(cell.recoveryEligible).toBe(0);
      expect(cell.verification.inactiveShareOfFindings).toMatchObject({
        applicable: false,
        rate: null,
      });
      expect(cell.verification.inactiveFindingsPerRetainedItem).toMatchObject({
        applicable: false,
        rate: null,
      });
      expect(cell.verification.inactiveShareOfSnapshot).toMatchObject({
        applicable: false,
        rate: null,
      });
      expect(containsNaN(cell)).toBe(false);
    }

    const allActive = cellFor(10, 1);
    expect(inactiveMetadataOverhead(allActive)).toEqual({
      bytes: 0,
      percent: 0,
    });

    const allInactive = cellFor(10, 0);
    const projected = projectRegistryActiveOnly(buildRegistry(10, 0));
    expect(allInactive.counts.active).toBe(0);
    expect(allInactive.counts.inactive).toBe(10);
    expect(projected.items).toEqual([]);
    expect(projected.discoveryItemIds).toEqual([]);
    expect(Object.keys(projected.discoveryProvenance)).toEqual([]);
    expect(Object.keys(projected.discoveryLifecycle)).toEqual([]);
    expect(allInactive.verification.inactiveShareOfFindings.rate).toBe(1);
    expect(allInactive.verification.inactiveFindingsPerRetainedItem.rate).toBe(1);
    expect(allInactive.verification.inactiveShareOfSnapshot.rate).toBe(1);
    expect(containsNaN(allInactive)).toBe(false);
  });

  it('returns all three diagnostics with deterministic repeated evaluation', () => {
    const first = evaluateRegistryGrowth([10, 25], [1, 0.75, 0.5, 0.25]);
    const second = evaluateRegistryGrowth([10, 25], [1, 0.75, 0.5, 0.25]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const firstCell = cellFor(25, 0.5);
    const diagnostics = retentionDiagnostics(firstCell);
    expect(diagnostics.metadataOverhead).toEqual(
      inactiveMetadataOverhead(firstCell),
    );
    expect(diagnostics.retentionFootprint).toEqual(
      inactiveRetentionFootprint(firstCell),
    );
    expect(diagnostics.snapshotFootprint).toEqual(
      snapshotRetentionFootprint(firstCell),
    );
    expect(diagnostics.verification).toBe(firstCell.verification);
  });
});
