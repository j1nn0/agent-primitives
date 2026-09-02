import type { ToolResultEvent, TurnEndEvent } from '@earendil-works/pi-coding-agent';
import { computeSupervisorJsonDigest } from '../digest.js';
import {
  extractSupervisorAssessmentText,
  SUPERVISOR_ASSESSMENT_EVIDENCE_RECORD_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_EVIDENCE_TOTAL_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS,
  SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS,
  type SupervisorAssessmentEvidence,
  type SupervisorAssessmentInput,
} from './types.js';

function retainTail(text: string, maxUnits: number): string {
  return text.length <= maxUnits ? text : text.slice(text.length - maxUnits);
}

/** Collects bounded, digest-only evidence from actual Pi tool-result events. */
export class SupervisorAssessmentEvidenceCollector {
  private records: SupervisorAssessmentEvidence[] = [];

  private nextEvidenceSequence = 1;

  /** Clear all records and restart deterministic Root-Request-local ids at e1. */
  public clear(): void {
    this.records = [];
    this.nextEvidenceSequence = 1;
  }

  /**
   * Add one actual tool result. A blocked tool call cannot reach this method because Pi emits no
   * `tool_result` for it; there is intentionally no blocked-call special case here.
   */
  public observeToolResult(event: ToolResultEvent): void {
    if (!Array.isArray(event.content)) {
      return;
    }

    const sequence = this.nextEvidenceSequence;
    if (sequence === Number.MAX_SAFE_INTEGER) {
      return;
    }
    this.nextEvidenceSequence += 1;

    const record: SupervisorAssessmentEvidence = Object.freeze({
      id: `e${sequence}`,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      inputDigest: computeSupervisorJsonDigest(event.input),
      resultDigest: computeSupervisorJsonDigest(event.content),
      text: retainTail(extractSupervisorAssessmentText(event.content), SUPERVISOR_ASSESSMENT_EVIDENCE_RECORD_MAX_UTF16_CODE_UNITS),
    });
    this.records.push(record);
    if (this.records.length > SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS) {
      this.records.shift();
    }
  }

  /**
   * Return records oldest-to-newest after applying the total text budget. The deterministic rule is
   * newest-first allocation: walk the retained records backward, give each as much remaining budget
   * as possible up to its per-record bound, and retain that record's tail. Records with no remaining
   * text budget are omitted from the model-facing result.
   */
  public getRecords(): readonly SupervisorAssessmentEvidence[] {
    const retained = this.records.slice(-SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS);
    const bounded: (SupervisorAssessmentEvidence | undefined)[] = new Array(retained.length);
    let remainingUnits = SUPERVISOR_ASSESSMENT_EVIDENCE_TOTAL_MAX_UTF16_CODE_UNITS;

    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const record = retained[index];
      if (record === undefined) {
        continue;
      }
      const units = Math.min(record.text.length, remainingUnits);
      if (units > 0) {
        bounded[index] = Object.freeze({ ...record, text: record.text.slice(-units) });
      }
      remainingUnits -= units;
    }

    return Object.freeze(
      bounded.filter((record): record is SupervisorAssessmentEvidence => record !== undefined),
    );
  }
}

/** Owns all ephemeral assessment inputs for one Root Request. */
export class SupervisorAssessmentCapture {
  private taskText: string | undefined;

  private finalAssistantText: string | undefined;

  private readonly evidence = new SupervisorAssessmentEvidenceCollector();

  /**
   * Start a new Root Request. Task intent is front-loaded, so retain the first 8,000 UTF-16 code
   * units; the final response and all tool evidence are reset with the new Root Request.
   */
  public beginRootRequest(taskText: string): void {
    this.taskText = taskText.slice(0, SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS);
    this.finalAssistantText = undefined;
    this.evidence.clear();
  }

  /** Clear all Root-Request-local assessment data. */
  public clearRootRequest(): void {
    this.taskText = undefined;
    this.finalAssistantText = undefined;
    this.evidence.clear();
  }

  /** A resumed session starts without any assessment data. */
  public resetSession(): void {
    this.clearRootRequest();
  }

  /** Observe one actual tool result within the current Root Request. */
  public observeToolResult(event: ToolResultEvent): void {
    this.evidence.observeToolResult(event);
  }

  /**
   * Replace the latest assistant text from a turn. Completion statements are front-loaded toward
   * the end, so retain the final 12,000 UTF-16 code units. Empty or non-assistant text is absent,
   * never a reason to reuse an older run's response.
   */
  public observeTurnEnd(eventOrMessage: TurnEndEvent | TurnEndEvent['message']): void {
    const message = isTurnEndEvent(eventOrMessage) ? eventOrMessage.message : eventOrMessage;
    if (
      typeof message !== 'object' ||
      message === null ||
      message.role !== 'assistant' ||
      !Array.isArray(message.content)
    ) {
      this.finalAssistantText = undefined;
      return;
    }

    const text = extractSupervisorAssessmentText(message.content);
    this.finalAssistantText = text.length === 0
      ? undefined
      : retainTail(text, SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS);
  }

  public getTaskText(): string | undefined {
    return this.taskText;
  }

  public getFinalAssistantText(): string | undefined {
    return this.finalAssistantText;
  }

  public getEvidence(): readonly SupervisorAssessmentEvidence[] {
    return this.evidence.getRecords();
  }

  /** Return a defensive, model-ready view without exposing raw tool input. */
  public getSnapshot(): SupervisorAssessmentInput {
    return Object.freeze({
      ...(this.taskText === undefined ? {} : { taskText: this.taskText }),
      ...(this.finalAssistantText === undefined ? {} : { finalAssistantText: this.finalAssistantText }),
      evidence: this.evidence.getRecords(),
    });
  }
}

function isTurnEndEvent(
  value: TurnEndEvent | TurnEndEvent['message'],
): value is TurnEndEvent {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'turn_end';
}
