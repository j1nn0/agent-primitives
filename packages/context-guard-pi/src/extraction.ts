import { createHash } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import type {
  ContextItemInput,
  ContextItemKind,
} from '@j1nn0/agent-context-guard';
import type {
  ExtensionContext,
  InputEvent,
} from '@earendil-works/pi-coding-agent';
import type { LastExtraction, RuntimeState } from './types.js';

const EXTRACTION_TIMEOUT_MS = 20_000;
const MAX_ADDED_ITEMS = 8;
const MAX_CONTENT_CODE_POINTS = 1_000;

export const EXTRACTOR_SYSTEM_PROMPT = [
  'Extract durable protected context from the current user message.',
  'Extract only instructions that must stay true in later turns.',
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

interface ExtractedItem {
  readonly content: string;
  readonly kind: ContextItemKind;
  readonly critical: boolean;
}

interface ExtractionOutput {
  readonly add: readonly ExtractedItem[];
  readonly removeAutoItemIds: readonly string[];
}

interface PlannedMutation {
  readonly adds: readonly ContextItemInput[];
  readonly removeAutoItemIds: readonly string[];
}

interface ExtractionDependencies {
  readonly getState: () => RuntimeState;
  readonly clearPendingSnapshot: () => void;
  readonly persist: () => void;
}

export interface ExtractionController {
  handleInput(event: InputEvent, ctx: ExtensionContext): Promise<void>;
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

function assistantText(response: unknown): string {
  if (!isPlainObject(response)) {
    throw new Error('Invalid extractor response.');
  }

  const typedResponse = response as ExtractorResponse;
  if (typedResponse.stopReason === 'aborted') {
    throw new Error('Extractor request was aborted.');
  }
  if (
    typeof typedResponse.stopReason !== 'string' ||
    !Array.isArray(typedResponse.content)
  ) {
    throw new Error('Invalid extractor response.');
  }

  const text = typedResponse.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
  if (text.trim().length === 0) {
    throw new Error('Extractor response was not text.');
  }

  return stripSingleFence(text);
}

function parseOutput(text: string, userMessage: string, state: RuntimeState): ExtractionOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Extractor output was not valid JSON.');
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    throw new Error('Invalid extractor output schema.');
  }

  if (!Array.isArray(parsed.add) || !Array.isArray(parsed.removeAutoItemIds)) {
    throw new Error('Invalid extractor output arrays.');
  }
  if (parsed.add.length > MAX_ADDED_ITEMS) {
    throw new Error('Too many extracted items.');
  }

  const add: ExtractedItem[] = [];
  for (const candidate of parsed.add) {
    if (!isPlainObject(candidate) || !isAllowedKind(candidate.kind)) {
      throw new Error('Invalid extracted item.');
    }

    if (typeof candidate.content !== 'string') {
      throw new Error('Invalid extracted content.');
    }
    if (
      candidate.content.trim().length === 0 ||
      Array.from(candidate.content).length > MAX_CONTENT_CODE_POINTS ||
      !userMessage.includes(candidate.content)
    ) {
      throw new Error('Extracted content was not an exact user-message substring.');
    }

    const critical = hasOwn(candidate, 'critical')
      ? candidate.critical
      : false;
    if (typeof critical !== 'boolean') {
      throw new Error('Invalid extracted critical flag.');
    }

    add.push({
      content: candidate.content,
      kind: candidate.kind,
      critical,
    });
  }

  const removeAutoItemIds: string[] = [];
  for (const value of parsed.removeAutoItemIds) {
    if (
      typeof value !== 'string' ||
      !state.autoItemIds.has(value) ||
      !state.guard.has(value)
    ) {
      throw new Error('Invalid automatic item id.');
    }
    removeAutoItemIds.push(value);
  }

  return { add, removeAutoItemIds };
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

function extractionPayload(state: RuntimeState, text: string): string {
  const automaticItems = state.guard
    .list()
    .filter((item) => state.autoItemIds.has(item.id))
    .map(({ id, kind, content }) => ({ id, kind, content }));
  return JSON.stringify({
    userMessage: text,
    automaticItems,
  });
}

function completionOptions(
  model: NonNullable<ExtensionContext['model']>,
  signal: AbortSignal,
): object {
  const common = { signal, maxTokens: 1024 };
  if (!model.reasoning) {
    return common;
  }

  switch (model.api) {
    case 'openai-completions':
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { ...common, reasoningEffort: 'minimal' };
    case 'anthropic-messages':
      return { ...common, effort: 'low' };
    case 'bedrock-converse-stream':
      return { ...common, reasoning: 'minimal' };
    case 'google-generative-ai':
    case 'google-vertex':
      return { ...common, thinking: { enabled: false } };
    case 'mistral-conversations':
      return { ...common, reasoningEffort: 'none' };
    case 'pi-messages':
      return { ...common, reasoning: 'minimal' };
    default:
      return common;
  }
}

export function createExtractionController(
  dependencies: ExtractionDependencies,
): ExtractionController {
  async function handleInput(
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const stateAtStart = dependencies.getState();
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

    const model = ctx.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, EXTRACTION_TIMEOUT_MS);

    try {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: extractionPayload(stateAtStart, event.text),
              timestamp: Date.now(),
            },
          ],
        },
        completionOptions(model, controller.signal),
      );

      const state = dependencies.getState();
      const output = parseOutput(assistantText(response), event.text, state);
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
      const state = dependencies.getState();
      state.lastExtraction = {
        status: 'failed',
        added: 0,
        retired: 0,
      } satisfies LastExtraction;
      try {
        ctx.ui.notify(EXTRACTION_FAILURE_WARNING, 'warning');
      } catch {
        // A UI failure must not turn an extractor failure into an agent failure.
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { handleInput };
}
