import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SupervisorAssessmentOutput } from './parse.js';
import {
  requestSupervisorAssessment,
  SUPERVISOR_ASSESSMENT_TIMEOUT_MS,
  type SupervisorAssessmentRequestFailureKind,
} from './request.js';
import type { SupervisorAssessmentInput } from './types.js';

export interface SupervisorAssessmentIdentity {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly rootRequestId: string;
  readonly rootGeneration: number;
  readonly runGeneration: number;
}

export interface SupervisorAssessmentControllerOptions {
  readonly timeoutMs?: number;
}

export type SupervisorAssessmentStatus =
  | 'idle'
  | 'success'
  | `failed(${SupervisorAssessmentRequestFailureKind})`;

export type SupervisorAssessmentOutcome =
  | { readonly kind: 'skipped'; readonly reason: 'disabled' | 'already-assessed' | 'not-ready' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'success'; readonly output: SupervisorAssessmentOutput }
  | { readonly kind: 'failed'; readonly failureKind: SupervisorAssessmentRequestFailureKind };

/**
 * Owns assessment request lifecycle, per-run deduplication, cancellation, and last-result status.
 * It deliberately has no access to Pi's event bus or to feature runtime contexts.
 */
export class SupervisorAssessmentController {
  private readonly timeoutMs: number;

  private readonly activeControllers = new Set<AbortController>();

  private readonly attemptedIdentities = new Set<string>();

  private status: SupervisorAssessmentStatus = 'idle';

  public constructor(options: SupervisorAssessmentControllerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? SUPERVISOR_ASSESSMENT_TIMEOUT_MS;
  }

  /** Abort and forget requests belonging to a replaced Root Request. */
  public resetForRoot(): void {
    this.abortActive();
    this.attemptedIdentities.clear();
    this.status = 'idle';
  }

  /** Abort all requests and clear session-local assessment state. */
  public resetForSession(): void {
    this.abortActive();
    this.attemptedIdentities.clear();
    this.status = 'idle';
  }

  /** Abort every outstanding request without changing deduplication state. */
  public abortActive(): void {
    for (const controller of this.activeControllers) {
      controller.abort('aborted');
    }
    this.activeControllers.clear();
  }

  public getStatus(): SupervisorAssessmentStatus {
    return this.status;
  }

  /**
   * Assess one settled run. The identity check is supplied by the Kernel so this controller never
   * reaches into Kernel state or feature state. The identity is marked before all skip checks, so a
   * duplicate settled event cannot turn a previously skipped run into a later model request.
   */
  public async assess(
    ctx: ExtensionContext,
    input: SupervisorAssessmentInput,
    identity: SupervisorAssessmentIdentity,
    isCurrent: () => boolean,
    enabled: boolean,
  ): Promise<SupervisorAssessmentOutcome> {
    const identityKey = JSON.stringify([
      identity.sessionId,
      identity.sessionGeneration,
      identity.rootRequestId,
      identity.rootGeneration,
      identity.runGeneration,
    ]);
    if (this.attemptedIdentities.has(identityKey)) {
      return { kind: 'skipped', reason: 'already-assessed' };
    }
    this.attemptedIdentities.add(identityKey);

    if (!enabled) {
      return { kind: 'skipped', reason: 'disabled' };
    }
    if (
      input.taskText === undefined ||
      input.finalAssistantText === undefined ||
      input.finalAssistantText.trim().length === 0
    ) {
      return { kind: 'skipped', reason: 'not-ready' };
    }

    const requestController = new AbortController();
    this.activeControllers.add(requestController);

    let result;
    try {
      result = await requestSupervisorAssessment(ctx, input, {
        controller: requestController,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      result = { ok: false as const, failureKind: 'provider' as const };
    } finally {
      this.activeControllers.delete(requestController);
    }

    if (!this.readCurrent(isCurrent)) {
      return { kind: 'stale' };
    }
    if (!result.ok) {
      if (result.failureKind === 'skipped') {
        return { kind: 'skipped', reason: 'not-ready' };
      }
      this.status = `failed(${result.failureKind})`;
      return { kind: 'failed', failureKind: result.failureKind };
    }

    this.status = 'success';
    return { kind: 'success', output: result.output };
  }

  private readCurrent(isCurrent: () => boolean): boolean {
    try {
      return isCurrent();
    } catch {
      return false;
    }
  }
}
