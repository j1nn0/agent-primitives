import { describe, expect, it } from 'vitest';
import type { SupervisorFeatureRuntimeContext } from '../src/index.js';

describe('supervisor feature module boundary', () => {
  it('does not expose a feature-to-feature handle', () => {
    const context = {} as SupervisorFeatureRuntimeContext;
    // @ts-expect-error Context deliberately has no feature lookup handle.
    const featureHandle = context.getFeature;
    expect(featureHandle).toBeUndefined();
  });
});
