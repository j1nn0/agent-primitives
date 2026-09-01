import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_INTERVENTION_COMPATIBILITY_MATRIX,
  SupervisorContractError,
  validateSupervisorInterventionProposal,
} from '../src/index.js';

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceFeatureId: 'feature-a',
    boundary: 'stream',
    intent: 'verify',
    delivery: 'steer',
    priority: 50,
    reasonCode: 'feature-a:review',
    message: 'Please verify.',
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
      reasonCode: 'feature-a:review',
      message: 'Please verify.',
    });
  });

  it('accepts a reason code owned by the source feature', () => {
    expect(validateSupervisorInterventionProposal(proposal({ reasonCode: 'feature-a:reason' }))).toMatchObject({
      sourceFeatureId: 'feature-a',
      reasonCode: 'feature-a:reason',
    });
  });

  it.each(['feature-b:reason', 'kernel:reason', 'reason:feature-a'])(
    'rejects a reason code not owned by the source feature: %s',
    (reasonCode) => {
      expect(() => validateSupervisorInterventionProposal(proposal({ reasonCode }))).toThrow(
        SupervisorContractError,
      );
    },
  );

  it('rejects the reserved kernel source even with a matching reason namespace', () => {
    expect(() =>
      validateSupervisorInterventionProposal(
        proposal({ sourceFeatureId: 'kernel', reasonCode: 'kernel:reason' }),
      ),
    ).toThrow(SupervisorContractError);
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

  it('exports a frozen delivery compatibility matrix', () => {
    expect(Object.isFrozen(SUPERVISOR_INTERVENTION_COMPATIBILITY_MATRIX)).toBe(true);
    for (const compatibility of Object.values(SUPERVISOR_INTERVENTION_COMPATIBILITY_MATRIX)) {
      expect(Object.isFrozen(compatibility)).toBe(true);
      expect(Object.isFrozen(compatibility.boundaries)).toBe(true);
    }
  });

  it.each([
    ['block', 'tool-call'],
    ['steer', 'tool-call'],
    ['steer', 'stream'],
    ['follow-up', 'stream'],
    ['follow-up', 'settled'],
    ['none', 'tool-call'],
    ['none', 'stream'],
    ['none', 'settled'],
  ] as const)('accepts compatible delivery %s at %s', (delivery, boundary) => {
    const parsed = validateSupervisorInterventionProposal(
      proposal({
        delivery,
        boundary,
        message: 'Please verify.',
        ...(boundary === 'tool-call' ? { targetToolCallId: 'call-1' } : {}),
      }),
    );
    expect(parsed.delivery).toBe(delivery);
    expect(parsed.boundary).toBe(boundary);
  });

  it.each([
    ['block', 'stream'],
    ['block', 'settled'],
    ['steer', 'settled'],
    ['follow-up', 'tool-call'],
  ] as const)('rejects incompatible delivery %s at %s', (delivery, boundary) => {
    expect(() =>
      validateSupervisorInterventionProposal(
        proposal({
          delivery,
          boundary,
          message: 'Please verify.',
          ...(boundary === 'tool-call' ? { targetToolCallId: 'call-1' } : {}),
        }),
      ),
    ).toThrow(SupervisorContractError);
  });

  it.each([
    ['block', 'tool-call'],
    ['steer', 'stream'],
    ['follow-up', 'settled'],
  ] as const)('requires a non-empty message for %s at %s', (delivery, boundary) => {
    const input = proposal({
      delivery,
      boundary,
      ...(boundary === 'tool-call' ? { targetToolCallId: 'call-1' } : {}),
    });
    delete input.message;
    expect(() => validateSupervisorInterventionProposal(input)).toThrow(SupervisorContractError);
    expect(() =>
      validateSupervisorInterventionProposal({ ...input, message: '' }),
    ).toThrow(SupervisorContractError);
  });

  it('allows an omitted message for none delivery', () => {
    const input = proposal({ delivery: 'none', boundary: 'stream' });
    delete input.message;
    expect(validateSupervisorInterventionProposal(input).message).toBeUndefined();
  });
});
