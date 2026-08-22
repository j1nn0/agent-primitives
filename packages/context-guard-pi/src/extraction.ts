import { createHash } from 'node:crypto';
import type {
  ContextItemInput,
  ContextItemKind,
} from '@j1nn0/agent-context-guard';
import type {
  ExtensionContext,
  InputEvent,
} from '@earendil-works/pi-coding-agent';
import type {
  ExtractionFailureKind,
  LastExtraction,
  RuntimeState,
} from './types.js';

export const EXTRACTION_TIMEOUT_MS = 20_000;
const MAX_ADDED_ITEMS = 8;
const MAX_CONTENT_CODE_POINTS = 1_000;

export const EXTRACTOR_SYSTEM_PROMPT = [
  'Extract durable protected context from the current user message.',
  'Extract only instructions that must stay true in later turns.',
  'For each new item, choose the shortest contiguous substring that still expresses the complete durable instruction on its own; exclude politeness, discourse markers, reasons, explanations, and surrounding context unless needed to preserve meaning.',
  'Allowed kinds are exactly goal, constraint, requirement, and decision; never fact.',
  'For every new item, content MUST be an exact contiguous substring of the user message, copied character for character. Never paraphrase, translate, reformat, or merge.',
  'Do not extract questions, greetings, one-off requests, formatting preferences, text inside code blocks or logs, quoted third-party or example instructions, hypothetical instructions, or instructions the user has not adopted as their own.',
  'Set critical to true only when losing the item would change the task correctness, safety, scope, or required outcome.',
  'Retire an existing automatic item only when the current message explicitly withdraws, replaces, or reverses it. Never retire anything else.',
  'When uncertain, omit the item. Return at most 8 added items.',
  'Reply with JSON only, matching this exact contract and nothing else: { "schemaVersion": 1, "add": [{ "content": "...", "kind": "constraint", "critical": true }], "removeAutoItemIds": ["auto:constraint:..."] }',
].join('\n');

const EXTRACTION_FAILURE_WARNING =
  'Context Guard: automatic extraction failed; protected context was unchanged.';

const ALLOWED_KINDS: readonly ContextItemKind[] = [
  'goal',
  'constraint',
  'requirement',
  'decision',
];

type TextBlock = {
  readonly type: 'text';
  readonly text: string;
};

type ExtractorResponse = {
  readonly content?: readonly unknown[];
  readonly stopReason?: unknown;
};

export interface ExtractionAutomaticItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
}

export interface ExtractedItem {
  readonly content: string;
  readonly kind: ContextItemKind;
  readonly critical: boolean;
}

export interface ExtractionOutput {
  readonly add: readonly ExtractedItem[];
  readonly removeAutoItemIds: readonly string[];
}

interface PlannedMutation {
  readonly adds: readonly ContextItemInput[];
  readonly removeAutoItemIds: readonly string[];
}

interface ExtractionDependencies {
  readonly getEpoch: () => number;
  readonly getState: () => RuntimeState;
  readonly clearPendingSnapshot: () => void;
  readonly persist: () => void;
}

export interface ExtractionController {
  handleInput(event: InputEvent, ctx: ExtensionContext): Promise<void>;
  abortActive(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTextBlock(value: unknown): value is TextBlock {
  if (!isPlainObject(value)) {
    return false;
  }

  return value.type === 'text' && typeof value.text === 'string';
}

function isAllowedKind(value: unknown): value is ContextItemKind {
  return ALLOWED_KINDS.includes(value as ContextItemKind);
}

function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

type AssistantTextResult =
  | {
      readonly ok: true;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly failureKind: 'aborted' | 'provider' | 'invalid-response';
    };

export type ExtractionParseResult =
  | {
      readonly ok: true;
      readonly output: ExtractionOutput;
    }
  | {
      readonly ok: false;
      readonly failureKind:
        | 'aborted'
        | 'provider'
        | 'invalid-response'
        | 'invalid-output';
    };

function assistantText(response: unknown): AssistantTextResult {
  if (!isPlainObject(response)) {
    return { ok: false, failureKind: 'invalid-response' };
  }

  const typedResponse = response as ExtractorResponse;
  if (typedResponse.stopReason === 'aborted') {
    return { ok: false, failureKind: 'aborted' };
  }
  if (typedResponse.stopReason !== 'stop') {
    return { ok: false, failureKind: 'provider' };
  }
  if (!Array.isArray(typedResponse.content)) {
    return { ok: false, failureKind: 'invalid-response' };
  }

  const text = typedResponse.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
  if (text.trim().length === 0) {
    return { ok: false, failureKind: 'invalid-response' };
  }

  return { ok: true, text: stripSingleFence(text) };
}

function parseOutput(
  text: string,
  userMessage: string,
  existingAutomaticItems: readonly ExtractionAutomaticItem[],
): ExtractionOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    return undefined;
  }

  if (!Array.isArray(parsed.add) || !Array.isArray(parsed.removeAutoItemIds)) {
    return undefined;
  }
  if (parsed.add.length > MAX_ADDED_ITEMS) {
    return undefined;
  }

  const add: ExtractedItem[] = [];
  for (const candidate of parsed.add) {
    if (!isPlainObject(candidate) || !isAllowedKind(candidate.kind)) {
      return undefined;
    }

    if (typeof candidate.content !== 'string') {
      return undefined;
    }
    if (
      candidate.content.trim().length === 0 ||
      Array.from(candidate.content).length > MAX_CONTENT_CODE_POINTS ||
      !userMessage.includes(candidate.content)
    ) {
      return undefined;
    }

    const critical = hasOwn(candidate, 'critical')
      ? candidate.critical
      : false;
    if (typeof critical !== 'boolean') {
      return undefined;
    }

    add.push({
      content: candidate.content,
      kind: candidate.kind,
      critical,
    });
  }

  const automaticItemIds = new Set(
    existingAutomaticItems.map((item) => item.id),
  );
  const removeAutoItemIds: string[] = [];
  for (const value of parsed.removeAutoItemIds) {
    if (typeof value !== 'string' || !automaticItemIds.has(value)) {
      return undefined;
    }
    removeAutoItemIds.push(value);
  }

  return { add, removeAutoItemIds };
}

export function parseExtractionResponse(
  response: unknown,
  userMessage: string,
  existingAutomaticItems: readonly ExtractionAutomaticItem[],
): ExtractionParseResult {
  const responseText = assistantText(response);
  if (!responseText.ok) {
    return responseText;
  }

  const output = parseOutput(
    responseText.text,
    userMessage,
    existingAutomaticItems,
  );
  return output === undefined
    ? { ok: false, failureKind: 'invalid-output' }
    : { ok: true, output };
}

function digestId(kind: ContextItemKind, content: string): string {
  const digest = createHash('sha256')
    .update(`${kind} ${content}`)
    .digest('hex')
    .slice(0, 12);
  return `auto:${kind}:${digest}`;
}

function pairKey(kind: ContextItemKind, content: string): string {
  return JSON.stringify([kind, content]);
}

function planMutation(
  output: ExtractionOutput,
  state: RuntimeState,
): PlannedMutation {
  const currentItems = state.guard.list();
  const existingPairs = new Set(
    currentItems.map((item) => pairKey(item.kind, item.content)),
  );
  const plannedPairs = new Set<string>();
  const occupiedIds = new Set(currentItems.map((item) => item.id));
  const adds: ContextItemInput[] = [];

  for (const candidate of output.add) {
    const pair = pairKey(candidate.kind, candidate.content);
    if (existingPairs.has(pair) || plannedPairs.has(pair)) {
      continue;
    }

    const baseId = digestId(candidate.kind, candidate.content);
    let id = baseId;
    let probe = 2;
    while (occupiedIds.has(id)) {
      id = `${baseId}-${probe}`;
      probe += 1;
    }

    occupiedIds.add(id);
    plannedPairs.add(pair);
    adds.push({
      id,
      kind: candidate.kind,
      content: candidate.content,
      critical: candidate.critical,
    });
  }

  return {
    adds,
    removeAutoItemIds: Array.from(new Set(output.removeAutoItemIds)),
  };
}

function applyMutation(
  mutation: PlannedMutation,
  state: RuntimeState,
  dependencies: ExtractionDependencies,
): void {
  if (mutation.adds.length === 0 && mutation.removeAutoItemIds.length === 0) {
    return;
  }

  const previousItems = state.guard.list();
  const previousAutoItemIds = new Set(state.autoItemIds);
  const previousLastExtraction = state.lastExtraction;

  try {
    state.guard.addAll(mutation.adds);
    for (const item of mutation.adds) {
      state.autoItemIds.add(item.id);
    }
    for (const id of mutation.removeAutoItemIds) {
      state.guard.remove(id);
      state.autoItemIds.delete(id);
    }

    state.lastExtraction = {
      status: 'success',
      added: mutation.adds.length,
      retired: mutation.removeAutoItemIds.length,
    };
    dependencies.persist();
    dependencies.clearPendingSnapshot();
  } catch (error: unknown) {
    state.guard.clear();
    state.guard.addAll(previousItems);
    state.autoItemIds.clear();
    for (const id of previousAutoItemIds) {
      state.autoItemIds.add(id);
    }
    state.lastExtraction = previousLastExtraction;
    throw error;
  }
}

function mutationNotification(mutation: PlannedMutation): string {
  const added = mutation.adds.length;
  const retired = mutation.removeAutoItemIds.length;
  const itemLabel = added <= 1 && retired <= 1 ? 'item' : 'items';

  if (added > 0 && retired > 0) {
    return `Context Guard: automatically added ${added} and retired ${retired} protected ${itemLabel}.`;
  }
  if (added > 0) {
    return `Context Guard: automatically added ${added} protected ${itemLabel}.`;
  }
  return `Context Guard: automatically retired ${retired} protected ${itemLabel}.`;
}

function automaticItemsForState(
  state: RuntimeState,
): readonly ExtractionAutomaticItem[] {
  return state.guard
    .list()
    .filter((item) => state.autoItemIds.has(item.id))
    .map(({ id, kind, content }) => ({ id, kind, content }));
}

export function createExtractionPayload(
  text: string,
  automaticItems: readonly ExtractionAutomaticItem[],
): string {
  return JSON.stringify({
    userMessage: text,
    automaticItems: automaticItems.map(({ id, kind, content }) => ({
      id,
      kind,
      content,
    })),
  });
}

type SessionIdRead =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false };

function readSessionId(ctx: ExtensionContext): SessionIdRead {
  try {
    return { ok: true, id: ctx.sessionManager.getSessionId() };
  } catch {
    return { ok: false };
  }
}

function signalFailureKind(
  signal: AbortSignal,
): 'timeout' | 'aborted' | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  if (signal.reason === 'timeout') {
    return 'timeout';
  }
  if (signal.reason === 'aborted') {
    return 'aborted';
  }
  return undefined;
}

function failedLastExtraction(
  failureKind: ExtractionFailureKind,
): LastExtraction {
  return {
    status: 'failed',
    added: 0,
    retired: 0,
    failureKind,
  };
}

export function createExtractionController(
  dependencies: ExtractionDependencies,
): ExtractionController {
  const activeControllers = new Set<AbortController>();

  function abortActive(): void {
    for (const controller of activeControllers) {
      controller.abort('aborted');
    }
    activeControllers.clear();
  }

  async function handleInput(
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const stateAtStart = dependencies.getState();
    const epochAtStart = dependencies.getEpoch();
    const sessionIdAtStart = readSessionId(ctx);
    const trimmed = event.text.trim();
    if (
      stateAtStart.extraction !== 'automatic' ||
      (event.source !== 'interactive' && event.source !== 'rpc') ||
      trimmed.startsWith('/') ||
      trimmed.length === 0 ||
      ctx.model === undefined
    ) {
      return;
    }
    if (!sessionIdAtStart.ok) {
      stateAtStart.lastExtraction = failedLastExtraction('stale');
      return;
    }

    const model = ctx.model;
    const automaticItemsAtStart = automaticItemsForState(stateAtStart);
    const controller = new AbortController();
    activeControllers.add(controller);
    const timeout = setTimeout(() => {
      controller.abort('timeout');
    }, EXTRACTION_TIMEOUT_MS);

    const currentState = (): RuntimeState | undefined => {
      const currentEpoch = dependencies.getEpoch();
      let state: RuntimeState | undefined;
      try {
        state = dependencies.getState();
      } catch {
        state = undefined;
      }
      const currentSessionId = readSessionId(ctx);
      if (
        currentEpoch === epochAtStart &&
        state === stateAtStart &&
        currentSessionId.ok &&
        currentSessionId.id === sessionIdAtStart.id
      ) {
        return state;
      }
      return undefined;
    };

    const notifyFailure = (): void => {
      try {
        ctx.ui.notify(EXTRACTION_FAILURE_WARNING, 'warning');
      } catch {
        // A UI failure must not turn an extractor failure into an agent failure.
      }
    };

    try {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: createExtractionPayload(event.text, automaticItemsAtStart),
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal: controller.signal,
          maxTokens: 1024,
        },
      );

      const state = currentState();
      if (state === undefined) {
        stateAtStart.lastExtraction = failedLastExtraction('stale');
        return;
      }

      const signalKind = signalFailureKind(controller.signal);
      if (signalKind !== undefined) {
        stateAtStart.lastExtraction = failedLastExtraction(signalKind);
        notifyFailure();
        return;
      }

      const parseResult = parseExtractionResponse(
        response,
        event.text,
        automaticItemsForState(state),
      );
      if (!parseResult.ok) {
        state.lastExtraction = failedLastExtraction(parseResult.failureKind);
        notifyFailure();
        return;
      }

      const output = parseResult.output;

      // Keep this post-await block free of awaits: JavaScript's single-threaded execution makes planning, applying, persisting, and notifying atomic.
      const mutation = planMutation(output, state);
      if (mutation.adds.length === 0 && mutation.removeAutoItemIds.length === 0) {
        state.lastExtraction = {
          status: 'success',
          added: 0,
          retired: 0,
        } satisfies LastExtraction;
        return;
      }

      applyMutation(mutation, state, dependencies);
      try {
        ctx.ui.notify(mutationNotification(mutation), 'info');
      } catch {
        // A notification failure must not turn a successful mutation into a failed turn.
      }
    } catch {
      if (currentState() === undefined) {
        stateAtStart.lastExtraction = failedLastExtraction('stale');
        return;
      }

      const signalKind = signalFailureKind(controller.signal);
      stateAtStart.lastExtraction = failedLastExtraction(signalKind ?? 'provider');
      notifyFailure();
    } finally {
      activeControllers.delete(controller);
      clearTimeout(timeout);
    }
  }

  return { handleInput, abortActive };
}
