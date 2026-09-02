import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  parseSupervisorAssessmentResponse,
  type SupervisorAssessmentOutput,
} from './parse.js';
import { SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT } from './prompt.js';
import type { SupervisorAssessmentInput } from './types.js';

/** Hard upper bound for one auxiliary assessment request. */
export const SUPERVISOR_ASSESSMENT_TIMEOUT_MS = 20_000;

/** Maximum completion tokens requested from the active model. */
export const SUPERVISOR_ASSESSMENT_MAX_TOKENS = 1_200;

type ActiveModel = NonNullable<ExtensionContext['model']>;
type AuxiliaryModel = Pick<ActiveModel, 'reasoning' | 'thinkingLevelMap'>;
type AuxiliaryReasoningLevel = Exclude<
  keyof NonNullable<ActiveModel['thinkingLevelMap']>,
  'off'
>;

const AUXILIARY_REASONING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly AuxiliaryReasoningLevel[];

export type SupervisorAssessmentRequestFailureKind =
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output';

export type SupervisorAssessmentRequestResult =
  | { readonly ok: true; readonly output: SupervisorAssessmentOutput }
  | {
      readonly ok: false;
      readonly failureKind: 'skipped' | SupervisorAssessmentRequestFailureKind;
    };

export interface SupervisorAssessmentRequestOptions {
  readonly controller: AbortController;
  readonly timeoutMs?: number;
}

interface CompletionResponse {
  readonly kind: 'response';
  readonly response: unknown;
}

interface CompletionFailure {
  readonly kind: 'failure';
  readonly failureKind: 'timeout' | 'aborted' | 'provider';
}

type CompletionOutcome = CompletionResponse | CompletionFailure;

/**
 * Selects the cheapest reasoning level that the active model maps to a concrete non-empty value.
 * Unsupported (`null`) and absent mappings are never requested.
 */
export function getSupervisorAssessmentReasoningEffort(
  model: AuxiliaryModel,
): AuxiliaryReasoningLevel | undefined {
  if (model.reasoning !== true) {
    return undefined;
  }

  const thinkingLevelMap = model.thinkingLevelMap;
  if (typeof thinkingLevelMap?.off !== 'string') {
    return undefined;
  }
  for (const level of AUXILIARY_REASONING_LEVELS) {
    const mapping = thinkingLevelMap?.[level];
    if (typeof mapping === 'string' && mapping.length > 0) {
      return level;
    }
  }
  return undefined;
}

/** Creates the only user payload sent to the auxiliary model. */
export function createSupervisorAssessmentPayload(input: SupervisorAssessmentInput): string {
  return JSON.stringify({
    ...(input.taskText === undefined ? {} : { taskText: input.taskText }),
    ...(input.finalAssistantText === undefined
      ? {}
      : { finalAssistantText: input.finalAssistantText }),
    evidence: input.evidence.map(({ id, toolName, isError, text }) => ({
      id,
      toolName,
      isError,
      text,
    })),
  });
}

function abortFailureKind(signal: AbortSignal): 'timeout' | 'aborted' | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  return signal.reason === 'timeout' ? 'timeout' : 'aborted';
}

type ModelContext = Parameters<ExtensionContext['modelRegistry']['complete']>[1];

function completeWithBoundedAbort(
  ctx: ExtensionContext,
  model: ActiveModel,
  requestContext: ModelContext,
  reasoningEffort: AuxiliaryReasoningLevel | undefined,
  options: SupervisorAssessmentRequestOptions,
): Promise<CompletionOutcome> {
  const signal = options.controller.signal;
  const timeoutMs = options.timeoutMs ?? SUPERVISOR_ASSESSMENT_TIMEOUT_MS;

  return new Promise<CompletionOutcome>((resolve) => {
    let settled = false;

    const finish = (outcome: CompletionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => {
      finish({ kind: 'failure', failureKind: abortFailureKind(signal) ?? 'aborted' });
    };

    if (signal.aborted) {
      resolve({ kind: 'failure', failureKind: abortFailureKind(signal) ?? 'aborted' });
      return;
    }

    const timeout = setTimeout(() => {
      if (!signal.aborted) {
        options.controller.abort('timeout');
      }
      finish({ kind: 'failure', failureKind: abortFailureKind(signal) ?? 'timeout' });
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });

    let completion: Promise<unknown>;
    try {
      completion = ctx.modelRegistry.complete(model, requestContext, {
        signal,
        maxTokens: SUPERVISOR_ASSESSMENT_MAX_TOKENS,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
    } catch {
      finish({ kind: 'failure', failureKind: 'provider' });
      return;
    }

    void Promise.resolve(completion).then(
      (response) => {
        const failureKind = abortFailureKind(signal);
        finish(
          failureKind === undefined
            ? { kind: 'response', response }
            : { kind: 'failure', failureKind },
        );
      },
      () => {
        finish({
          kind: 'failure',
          failureKind: abortFailureKind(signal) ?? 'provider',
        });
      },
    );
  });
}

/** Performs one bounded completion through the active Pi model registry. */
export async function requestSupervisorAssessment(
  ctx: ExtensionContext,
  input: SupervisorAssessmentInput,
  options: SupervisorAssessmentRequestOptions,
): Promise<SupervisorAssessmentRequestResult> {
  if (
    input.taskText === undefined ||
    input.finalAssistantText === undefined ||
    input.finalAssistantText.trim().length === 0
  ) {
    return { ok: false, failureKind: 'skipped' };
  }

  let model: ActiveModel | undefined;
  let requestContext: ModelContext;
  let reasoningEffort: AuxiliaryReasoningLevel | undefined;
  try {
    model = ctx.model;
    if (model === undefined || model === null) {
      return { ok: false, failureKind: 'skipped' };
    }
    requestContext = {
      systemPrompt: SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user' as const,
          content: createSupervisorAssessmentPayload(input),
          timestamp: 0,
        },
      ],
    };
    reasoningEffort = getSupervisorAssessmentReasoningEffort(model);
  } catch {
    return { ok: false, failureKind: 'provider' };
  }

  const completion = await completeWithBoundedAbort(
    ctx,
    model,
    requestContext,
    reasoningEffort,
    options,
  );
  if (completion.kind === 'failure') {
    return { ok: false, failureKind: completion.failureKind };
  }

  try {
    const parsed = parseSupervisorAssessmentResponse(
      completion.response,
      input.finalAssistantText,
      input.evidence,
    );
    if (!parsed.ok) {
      // Pi can report an aborted stop reason for a provider-side response. Only our
      // controller signal is authoritative for classifying an abort as local.
      return {
        ok: false,
        failureKind: parsed.failureKind === 'aborted' ? 'provider' : parsed.failureKind,
      };
    }
    return { ok: true, output: parsed.output };
  } catch {
    return { ok: false, failureKind: 'invalid-output' };
  }
}
