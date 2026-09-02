import type {
  AgentSettledEvent,
  ContextEvent,
  ExtensionEvent,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';

type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: 'session_compact_failed' }>;
import { computeSupervisorJsonDigest } from '../digest.js';
import { assertJsonValue, type JsonValue } from '../json.js';
import {
  validateSupervisorObservation,
  type SupervisorObservation,
  type SupervisorObservationKind,
} from '../observation.js';

export type SupervisorPiObservationEvent =
  | InputEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnEndEvent
  | AgentSettledEvent
  | SessionStartEvent
  | SessionShutdownEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionCompactFailedEvent
  | ContextEvent;

function unsupportedEvent(): never {
  throw new Error('Unsupported supervisor event.');
}

/** Converts Pi lifecycle events into the privacy-safe supervisor observation envelope. */
export class SupervisorObservationNormalizer {
  private nextSequence = 0;

  /** Creates a Kernel-owned observation in the canonical Pi observation sequence. */
  public createInternal(
    kind: SupervisorObservationKind,
    payload: JsonValue,
    rootRequestId: string | null,
  ): SupervisorObservation {
    return this.createObservation(kind, payload, rootRequestId);
  }

  private createObservation(
    kind: SupervisorObservationKind,
    payload: JsonValue,
    rootRequestId: string | null,
  ): SupervisorObservation {
    const sequence = this.nextSequence;
    if (sequence === Number.MAX_SAFE_INTEGER) {
      throw new Error('Supervisor observation sequence exhausted.');
    }
    this.nextSequence += 1;
    return validateSupervisorObservation({
      schemaVersion: 1,
      id: `observation-${sequence}`,
      sequence,
      rootRequestId,
      kind,
      payload: assertJsonValue(payload),
    });
  }

  public normalize(
    event: SupervisorPiObservationEvent,
    rootRequestId: string | null,
  ): SupervisorObservation | undefined {
    if (event.type === 'input' && event.source === 'extension') {
      return undefined;
    }

    let kind: SupervisorObservation['kind'];
    let payload: JsonValue;
    switch (event.type) {
      case 'input':
        kind = 'root-request-started';
        payload = { source: event.source };
        break;
      case 'tool_call':
        kind = 'before-tool-call';
        payload = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputDigest: computeSupervisorJsonDigest(event.input),
        };
        break;
      case 'tool_result':
        kind = 'tool-result';
        payload = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputDigest: computeSupervisorJsonDigest(event.input),
          isError: event.isError,
          resultDigest: computeSupervisorJsonDigest(event.content),
        };
        break;
      case 'turn_end':
        kind = 'turn-ended';
        payload = {
          turnIndex: event.turnIndex,
          toolResultCount: event.toolResults.length,
        };
        break;
      case 'agent_settled':
        kind = 'agent-settled';
        payload = {};
        break;
      case 'session_start':
        kind = 'session-started';
        payload = { reason: event.reason };
        break;
      case 'session_shutdown':
        kind = 'session-shutdown';
        payload = { reason: event.reason };
        break;
      case 'session_before_compact':
        kind = 'before-compact';
        payload = { reason: event.reason, willRetry: event.willRetry };
        break;
      case 'session_compact':
        kind = 'compacted';
        payload = {
          reason: event.reason,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
        };
        break;
      case 'session_compact_failed':
        kind = 'compaction-failed';
        payload = {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
        };
        break;
      case 'context':
        kind = 'context-changed';
        payload = { messageCount: event.messages.length };
        break;
      default:
        return unsupportedEvent();
    }

    return this.createObservation(kind, payload, rootRequestId);
  }
}
