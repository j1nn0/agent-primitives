import { SupervisorContractError } from './errors.js';
import { isSupervisorFeatureId, isSupervisorReasonCode } from './ids.js';
import { hasOnlyAllowedKeys, hasOwn, isPlainObject } from './internal.js';

export const SUPERVISOR_INTERVENTION_BOUNDARIES = ['tool-call', 'stream', 'settled'] as const;
export const SUPERVISOR_INTERVENTION_INTENTS = [
  'stop',
  'handoff',
  'change-strategy',
  'verify',
  'continue',
] as const;
export const SUPERVISOR_INTERVENTION_DELIVERIES = ['block', 'steer', 'follow-up', 'none'] as const;

export type SupervisorInterventionBoundary = (typeof SUPERVISOR_INTERVENTION_BOUNDARIES)[number];
export type SupervisorInterventionIntent = (typeof SUPERVISOR_INTERVENTION_INTENTS)[number];
export type SupervisorInterventionDelivery = (typeof SUPERVISOR_INTERVENTION_DELIVERIES)[number];

export interface SupervisorInterventionProposal {
  readonly sourceFeatureId: string;
  readonly boundary: SupervisorInterventionBoundary;
  readonly intent: SupervisorInterventionIntent;
  readonly delivery: SupervisorInterventionDelivery;
  readonly priority: number;
  readonly reasonCode: string;
  readonly message?: string;
  readonly targetToolCallId?: string;
}

const ALLOWED_INTERVENTION_KEYS = new Set([
  'sourceFeatureId',
  'boundary',
  'intent',
  'delivery',
  'priority',
  'reasonCode',
  'message',
  'targetToolCallId',
]);

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function invalidIntervention(): never {
  throw new SupervisorContractError('invalid_intervention', 'Invalid supervisor intervention proposal.');
}

export function validateSupervisorInterventionProposal(
  value: unknown,
): SupervisorInterventionProposal {
  if (!isPlainObject(value)) {
    return invalidIntervention();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_INTERVENTION_KEYS)) {
      return invalidIntervention();
    }
    if (
      !hasOwn(value, 'sourceFeatureId') ||
      !hasOwn(value, 'boundary') ||
      !hasOwn(value, 'intent') ||
      !hasOwn(value, 'delivery') ||
      !hasOwn(value, 'priority') ||
      !hasOwn(value, 'reasonCode')
    ) {
      return invalidIntervention();
    }

    const sourceFeatureId = value.sourceFeatureId;
    const boundary = value.boundary;
    const intent = value.intent;
    const delivery = value.delivery;
    const priority = value.priority;
    const reasonCode = value.reasonCode;

    if (
      !isSupervisorFeatureId(sourceFeatureId) ||
      !isMember(SUPERVISOR_INTERVENTION_BOUNDARIES, boundary) ||
      !isMember(SUPERVISOR_INTERVENTION_INTENTS, intent) ||
      !isMember(SUPERVISOR_INTERVENTION_DELIVERIES, delivery) ||
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 100 ||
      !isSupervisorReasonCode(reasonCode)
    ) {
      return invalidIntervention();
    }

    const base = { sourceFeatureId, boundary, intent, delivery, priority, reasonCode };

    // Tool-call arbitration is isolated per target; only that boundary may carry a target.
    if (boundary === 'tool-call') {
      if (!hasOwn(value, 'targetToolCallId')) {
        return invalidIntervention();
      }
      const targetToolCallId = value.targetToolCallId;
      if (typeof targetToolCallId !== 'string' || targetToolCallId.length === 0) {
        return invalidIntervention();
      }
      if (hasOwn(value, 'message')) {
        const message = value.message;
        if (typeof message !== 'string') {
          return invalidIntervention();
        }
        return { ...base, message, targetToolCallId };
      }
      return { ...base, targetToolCallId };
    }

    if (hasOwn(value, 'targetToolCallId')) {
      return invalidIntervention();
    }
    if (hasOwn(value, 'message')) {
      const message = value.message;
      if (typeof message !== 'string') {
        return invalidIntervention();
      }
      return { ...base, message };
    }
    return base;
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidIntervention();
  }
}
