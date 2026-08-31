import { describe, expect, it } from 'vitest';
import { SupervisorContractError, validateSupervisorInterventionProposal } from '../src/index.js';

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceFeatureId: 'feature-a',
    boundary: 'stream',
    intent: 'verify',
    delivery: 'steer',
    priority: 50,
    reasonCode: 'policy:review',
    ...overrides,
  };
}

describe('supervisor intervention proposals', () => {
  it('accepts a valid stream proposal', () => {
    expect(validateSupervisorInterventionProposal(proposal({ message: 'Please verify.' }))).toEqual({
      sourceFeatureId: 'feature-a',
      boundary: 'stream',
      intent: 'verify',
      delivery: 'steer',
      priority: 50,
      reasonCode: 'policy:review',
      message: 'Please verify.',
    });
  });

  it.each([0, 100])('accepts boundary priority %s', (priority) => {
    expect(validateSupervisorInterventionProposal(proposal({ priority })).priority).toBe(priority);
  });

  it.each([-1, 101, 1.5, Number.NaN])('rejects priority %s', (priority) => {
    expect(() => validateSupervisorInterventionProposal(proposal({ priority }))).toThrow(
      SupervisorContractError,
    );
  });

  it('rejects an invalid reason code', () => {
    expect(() => validateSupervisorInterventionProposal(proposal({ reasonCode: 'bad-code' }))).toThrow(
      SupervisorContractError,
    );
  });

  it('requires a target for tool-call proposals', () => {
    expect(() =>
      validateSupervisorInterventionProposal(proposal({ boundary: 'tool-call' })),
    ).toThrow(SupervisorContractError);
    expect(
      validateSupervisorInterventionProposal(
        proposal({ boundary: 'tool-call', targetToolCallId: 'call-1' }),
      ).targetToolCallId,
    ).toBe('call-1');
  });

  it('rejects targets for stream and settled proposals', () => {
    for (const boundary of ['stream', 'settled']) {
      expect(() =>
        validateSupervisorInterventionProposal(
          proposal({ boundary, targetToolCallId: 'call-1' }),
        ),
      ).toThrow(SupervisorContractError);
    }
  });
});
