import { describe, expect, it } from 'vitest';

import {
  buildRegistry,
  evaluateRegistryGrowth,
  retentionContribution,
} from '../benchmark/registry-growth-evaluate.js';

describe('registry growth evaluator', () => {
  it('builds a deterministic schema-v5 discovery-only payload', () => {
    const registry = buildRegistry(10, 0.5);
    expect(registry.schemaVersion).toBe(5);
    expect(registry.items).toHaveLength(10);
    expect(registry.autoItemIds).toEqual([]);
    expect(registry.discoveryItemIds).toEqual(
      registry.items.map(({ id }) => id),
    );
    expect(registry.items.every(({ kind, critical }) => kind === 'fact' && critical)).toBe(
      true,
    );
    expect(registry.items.every(({ content }) => content.length >= 80 && content.length <= 300)).toBe(
      true,
    );
    expect(
      registry.items.some((item, index) => item.content.length !== registry.items[0]?.content.length || index === 0),
    ).toBe(true);
    expect(
      Object.values(registry.discoveryProvenance).every(
        (references) => references.length === 1 || references.length === 2,
      ),
    ).toBe(true);
    expect(
      Object.values(registry.discoveryLifecycle).every(
        ({ status, supersededBy }) =>
          status !== 'superseded' || (supersededBy !== undefined && supersededBy !== ''),
      ),
    ).toBe(true);
  });

  it('has monotonic persisted and snapshot byte growth at a fixed mix', () => {
    const cells = evaluateRegistryGrowth([10, 25, 50, 100, 250], [0.5]);
    for (let index = 1; index < cells.length; index += 1) {
      const previous = cells[index - 1];
      const current = cells[index];
      expect(current?.stateJsonBytes).toBeGreaterThan(previous?.stateJsonBytes ?? 0);
      expect(current?.snapshotJsonBytes).toBeGreaterThan(
        previous?.snapshotJsonBytes ?? 0,
      );
    }
  });

  it('attributes every finding to an inactive critical discovery', () => {
    const cells = evaluateRegistryGrowth([10, 20], [1, 0.5, 0.25]);
    for (const cell of cells) {
      expect(cell.snapshotItems).toBe(cell.size);
      expect(cell.verification.findingsFromActive).toBe(0);
      expect(cell.verification.findingsFromInactive).toBe(cell.counts.inactive);
      expect(cell.verification.findingsTotal).toBe(cell.counts.inactive);
      expect(cell.verification.inactiveShareOfFindings).toEqual({
        numerator: cell.counts.inactive,
        denominator: cell.counts.inactive,
        rate: 1,
      });
      expect(cell.recoveryEligible).toBe(cell.counts.active);
      expect(cell.counts.active + cell.counts.inactive).toBe(cell.size);
    }
  });

  it('is deterministic for both payload serialization and evaluation output', () => {
    const firstRegistry = buildRegistry(25, 0.75);
    const secondRegistry = buildRegistry(25, 0.75);
    expect(JSON.stringify(firstRegistry)).toBe(JSON.stringify(secondRegistry));

    const first = evaluateRegistryGrowth([10, 25], [1, 0.75, 0.5, 0.25]);
    const second = evaluateRegistryGrowth([10, 25], [1, 0.75, 0.5, 0.25]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('reports retention contribution against the all-active baseline', () => {
    const [active, mixed] = evaluateRegistryGrowth([20], [1, 0.5]);
    expect(active).toBeDefined();
    expect(mixed).toBeDefined();
    if (active === undefined || mixed === undefined) {
      return;
    }
    expect(retentionContribution(active)).toEqual({
      bytesDeltaPercent: 0,
      findingsDeltaPercent: 0,
    });
    expect(retentionContribution(mixed).findingsDeltaPercent).toBe(50);
  });
});
