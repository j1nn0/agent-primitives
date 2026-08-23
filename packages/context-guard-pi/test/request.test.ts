import { describe, expect, it } from 'vitest';
import { getAuxiliaryReasoningEffort } from '../src/request.js';

type ModelMetadata = Parameters<typeof getAuxiliaryReasoningEffort>[0];
type FixtureModel = ModelMetadata & { readonly provider: string };

function fixture(
  provider: string,
  reasoning: boolean,
  thinkingLevelMap?: ModelMetadata['thinkingLevelMap'],
): FixtureModel {
  return thinkingLevelMap === undefined
    ? { provider, reasoning }
    : { provider, reasoning, thinkingLevelMap };
}

describe('auxiliary reasoning effort', () => {
  it('selects low for a Luna-like model whose minimal level is null', () => {
    const model = fixture('provider-a', true, {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    });

    expect(getAuxiliaryReasoningEffort(model)).toBe('low');
  });

  it.each([
    [
      'absent off',
      { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    ],
    [
      'null off',
      { off: null, minimal: null, low: 'low', high: 'high', max: 'max' },
    ],
  ])('leaves a DeepSeek-like %s mapping unchanged', (_name, thinkingLevelMap) => {
    expect(
      getAuxiliaryReasoningEffort(
        fixture('provider-a', true, thinkingLevelMap),
      ),
    ).toBeUndefined();
  });

  it('walks past null mappings to the first usable higher level', () => {
    const model = fixture('provider-a', true, {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
    });

    expect(getAuxiliaryReasoningEffort(model)).toBe('high');
  });

  it('selects minimal when the model maps it to a concrete value', () => {
    const model = fixture('provider-a', true, {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      high: 'high',
    });

    expect(getAuxiliaryReasoningEffort(model)).toBe('minimal');
  });

  it('does not add reasoning to a non-reasoning model', () => {
    const model = fixture('provider-a', false, {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
    });

    expect(getAuxiliaryReasoningEffort(model)).toBeUndefined();
  });

  it('does not throw or guess when metadata has no usable level', () => {
    expect(
      getAuxiliaryReasoningEffort(fixture('provider-a', true)),
    ).toBeUndefined();
    expect(
      getAuxiliaryReasoningEffort(
        fixture('provider-a', true, {
          off: 'none',
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        }),
      ),
    ).toBeUndefined();
  });

  it('never returns a level whose metadata mapping is null', () => {
    const model = fixture('provider-a', true, {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });

    const selected = getAuxiliaryReasoningEffort(model);
    expect(selected).toBe('low');
    if (selected !== undefined) {
      expect(model.thinkingLevelMap?.[selected]).not.toBeNull();
    }
  });

  it('is independent of the provider name', () => {
    const thinkingLevelMap = {
      off: 'none',
      minimal: null,
      low: 'low',
      high: 'high',
    };

    expect(
      getAuxiliaryReasoningEffort(
        fixture('provider-a', true, thinkingLevelMap),
      ),
    ).toBe('low');
    expect(
      getAuxiliaryReasoningEffort(
        fixture('provider-b', true, thinkingLevelMap),
      ),
    ).toBe('low');
  });

  it('does not mutate the model or its thinking-level map', () => {
    const model = fixture('provider-a', true, {
      off: 'none',
      minimal: null,
      low: 'low',
      high: 'high',
    });
    const before = structuredClone(model);

    expect(getAuxiliaryReasoningEffort(model)).toBe('low');
    expect(model).toEqual(before);
  });
});
