import type {
  ContextItemInput,
} from '@j1nn0/agent-context-guard';
import type {
  ExtensionContext,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import {
  isPlainObject,
  isTextBlock,
  parseAssistantText,
} from './extraction.js';
import { concatenateEvidenceText } from './provenance.js';
import {
  digest12,
  discoveryItemId,
  probeId,
} from './identifiers.js';
import {
  currentRequestState,
  readSessionId,
  REQUEST_TIMEOUT_MS,
  signalFailureKind,
  type RequestTracker,
} from './request.js';
import type {
  DiscoveryFailureKind,
  DiscoveryProvenance,
  LastDiscovery,
  RuntimeState,
} from './types.js';

const MAX_EVIDENCE_RECORDS = 8;
const MAX_EVIDENCE_TEXT_CODE_UNITS = 4_000;
const MAX_EVIDENCE_TOTAL_CODE_UNITS = 24_000;
const MAX_DISCOVERIES = 4;
const MAX_CONTENT_CODE_POINTS = 500;

export const DISCOVERY_SYSTEM_PROMPT = [
  'Extract durable facts from the supplied tool evidence that a later session would otherwise have to rediscover at real cost.',
  'The only allowed kind is fact. Never create a goal, constraint, requirement, or decision.',
  'Every fact must be supported by at least one evidence quote. Each quote MUST be an exact contiguous substring of the referenced evidence text, copied character for character.',
  'Reference evidence only by the ids supplied. Never invent an id.',
  'Fact content must be a short self-contained claim in your own words, at most 500 Unicode code points. State the scope when it matters, including the relevant name, version, file, or command.',
  'Do not state conclusions the evidence does not show: an observed failure is a fact, but an inferred root cause is not.',
  'Never create a fact containing credentials, tokens, passwords, private keys, or other secrets.',
  'Return at most 4 facts. When uncertain, return none. Reply with JSON only.',
  'Return exactly this shape: { "schemaVersion": 1, "discoveries": [{ "kind": "fact", "content": "...", "evidence": [{ "id": "e1", "quote": "..." }] }] }',
].join('\n');

const DISCOVERY_FAILURE_WARNING =
  'Context Guard: automatic discovery failed; protected context was unchanged.';

export interface DiscoveryEvidence {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
}

export interface DiscoveryEvidenceReference {
  readonly id: string;
  readonly quote: string;
}

export interface DiscoveredFact {
  readonly kind: 'fact';
  readonly content: string;
  readonly evidence: readonly DiscoveryEvidenceReference[];
}

export interface DiscoveryOutput {
  readonly discoveries: readonly DiscoveredFact[];
}

export type DiscoveryParseResult =
  | {
      readonly ok: true;
      readonly output: DiscoveryOutput;
    }
  | {
      readonly ok: false;
      readonly failureKind:
        | 'aborted'
        | 'provider'
        | 'invalid-response'
        | 'invalid-output';
    };

interface DiscoveryDependencies {
  readonly getEpoch: () => number;
  readonly getState: () => RuntimeState;
  readonly clearPendingSnapshot: () => void;
  readonly persist: () => void;
  readonly requestTracker: RequestTracker;
}

export interface DiscoveryController {
  beginTurn(): void;
  resetForSession(): void;
  handleToolResult(event: ToolResultEvent): void;
  handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void>;
  abortActive(): void;
}

interface CollectedEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
}

interface PlannedDiscoveryMutation {
  readonly adds: readonly ContextItemInput[];
  readonly provenance: ReadonlyMap<string, readonly DiscoveryProvenance[]>;
}

function pairKey(kind: string, content: string): string {
  return JSON.stringify([kind, content]);
}

function parseDiscoveryOutput(
  text: string,
  evidence: readonly DiscoveryEvidence[],
): DiscoveryOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    return undefined;
  }
  if (
    !Array.isArray(parsed.discoveries) ||
    parsed.discoveries.length > MAX_DISCOVERIES
  ) {
    return undefined;
  }

  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  const discoveries: DiscoveredFact[] = [];
  for (const candidate of parsed.discoveries) {
    if (
      !isPlainObject(candidate) ||
      candidate.kind !== 'fact' ||
      typeof candidate.content !== 'string' ||
      candidate.content.trim().length === 0 ||
      Array.from(candidate.content).length > MAX_CONTENT_CODE_POINTS ||
      !Array.isArray(candidate.evidence) ||
      candidate.evidence.length === 0
    ) {
      return undefined;
    }

    const seenEvidenceIds = new Set<string>();
    const references: DiscoveryEvidenceReference[] = [];
    for (const reference of candidate.evidence) {
      if (
        !isPlainObject(reference) ||
        typeof reference.id !== 'string' ||
        typeof reference.quote !== 'string' ||
        reference.quote.trim().length === 0 ||
        seenEvidenceIds.has(reference.id)
      ) {
        return undefined;
      }
      const source = evidenceById.get(reference.id);
      if (source === undefined || !source.text.includes(reference.quote)) {
        return undefined;
      }
      seenEvidenceIds.add(reference.id);
      references.push({ id: reference.id, quote: reference.quote });
    }

    discoveries.push({
      kind: 'fact',
      content: candidate.content,
      evidence: references,
    });
  }

  return { discoveries };
}

export function parseDiscoveryResponse(
  response: unknown,
  evidence: readonly DiscoveryEvidence[],
): DiscoveryParseResult {
  const responseText = parseAssistantText(response);
  if (!responseText.ok) {
    return responseText;
  }

  const output = parseDiscoveryOutput(responseText.text, evidence);
  return output === undefined
    ? { ok: false, failureKind: 'invalid-output' }
    : { ok: true, output };
}

export function createDiscoveryPayload(
  evidence: readonly DiscoveryEvidence[],
): string {
  return JSON.stringify({
    evidence: evidence.map(({ id, toolName, text }) => ({
      id,
      toolName,
      text,
    })),
  });
}

function failedLastDiscovery(
  failureKind: DiscoveryFailureKind,
): LastDiscovery {
  return {
    status: 'failed',
    added: 0,
    failureKind,
  };
}

function planMutation(
  output: DiscoveryOutput,
  evidence: readonly DiscoveryEvidence[],
  state: RuntimeState,
): PlannedDiscoveryMutation {
  const currentItems = state.guard.list();
  const existingPairs = new Set(
    currentItems.map((item) => pairKey(item.kind, item.content)),
  );
  const plannedPairs = new Set<string>();
  const occupiedIds = new Set(currentItems.map((item) => item.id));
  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  const adds: ContextItemInput[] = [];
  const provenance = new Map<string, readonly DiscoveryProvenance[]>();

  for (const candidate of output.discoveries) {
    const pair = pairKey(candidate.kind, candidate.content);
    if (existingPairs.has(pair) || plannedPairs.has(pair)) {
      continue;
    }

    const id = probeId(
      discoveryItemId(candidate.kind, candidate.content),
      occupiedIds,
    );
    const references: DiscoveryProvenance[] = [];
    for (const reference of candidate.evidence) {
      const source = evidenceById.get(reference.id);
      if (source !== undefined) {
        const baseReference: DiscoveryProvenance = {
          toolCallId: source.toolCallId,
          toolName: source.toolName,
          quoteHash: digest12(reference.quote),
        };
        const startOffset = source.text.indexOf(reference.quote);
        if (startOffset === -1) {
          // The parser's includes() gate should make this impossible. Keep
          // the record without a bogus span if that invariant ever changes.
          references.push(baseReference);
        } else {
          // Repeated quotes are ambiguous: indexOf records the first
          // occurrence deterministically, but cannot recover which occurrence
          // the model intended.
          references.push({
            ...baseReference,
            span: {
              startOffset,
              endOffset: startOffset + reference.quote.length,
            },
          });
        }
      }
    }

    // Parsing guarantees at least one valid reference. Keep this guard at the
    // mutation boundary so a future parser change cannot register unproven data.
    if (references.length === 0) {
      continue;
    }

    occupiedIds.add(id);
    plannedPairs.add(pair);
    adds.push({
      id,
      kind: candidate.kind,
      content: candidate.content,
      critical: true,
    });
    provenance.set(id, references);
  }

  return { adds, provenance };
}

function applyMutation(
  mutation: PlannedDiscoveryMutation,
  state: RuntimeState,
  dependencies: DiscoveryDependencies,
): void {
  if (mutation.adds.length === 0) {
    return;
  }

  const previousItems = state.guard.list();
  const previousDiscoveryItemIds = new Set(state.discoveryItemIds);
  const previousProvenance = new Map<string, readonly DiscoveryProvenance[]>();
  for (const [id, references] of state.discoveryProvenance) {
    previousProvenance.set(
      id,
      references.map((reference) => ({ ...reference })),
    );
  }
  const previousLastDiscovery = state.lastDiscovery;

  try {
    state.guard.addAll(mutation.adds);
    for (const item of mutation.adds) {
      state.discoveryItemIds.add(item.id);
      const references = mutation.provenance.get(item.id);
      if (references !== undefined) {
        state.discoveryProvenance.set(item.id, references);
      }
    }
    state.lastDiscovery = {
      status: 'success',
      added: mutation.adds.length,
    };
    dependencies.persist();
    dependencies.clearPendingSnapshot();
  } catch (error: unknown) {
    state.guard.clear();
    state.guard.addAll(previousItems);
    state.discoveryItemIds.clear();
    for (const id of previousDiscoveryItemIds) {
      state.discoveryItemIds.add(id);
    }
    state.discoveryProvenance.clear();
    for (const [id, references] of previousProvenance) {
      state.discoveryProvenance.set(id, references);
    }
    state.lastDiscovery = previousLastDiscovery;
    throw error;
  }
}

function discoveryNotification(count: number): string {
  return `Context Guard: captured ${count} ${count === 1 ? 'discovery' : 'discoveries'} from tool evidence.`;
}

export function createDiscoveryController(
  dependencies: DiscoveryDependencies,
): DiscoveryController {
  const evidenceByToolCallId = new Map<string, CollectedEvidence>();
  let totalEvidenceTextLength = 0;
  let evidenceCollectionStopped = false;
  let turnEndHandled = false;

  function clearEvidence(): void {
    evidenceByToolCallId.clear();
    totalEvidenceTextLength = 0;
    evidenceCollectionStopped = false;
    turnEndHandled = false;
  }

  function beginTurn(): void {
    clearEvidence();
  }

  function resetForSession(): void {
    clearEvidence();
  }

  function handleToolResult(event: ToolResultEvent): void {
    if (
      turnEndHandled ||
      evidenceCollectionStopped ||
      evidenceByToolCallId.has(event.toolCallId) ||
      evidenceByToolCallId.size >= MAX_EVIDENCE_RECORDS
    ) {
      return;
    }

    const textBlocks = event.content.filter(isTextBlock);
    if (textBlocks.length === 0) {
      return;
    }
    const text = concatenateEvidenceText(event.content);
    if (text.length > MAX_EVIDENCE_TEXT_CODE_UNITS) {
      return;
    }
    if (totalEvidenceTextLength + text.length > MAX_EVIDENCE_TOTAL_CODE_UNITS) {
      evidenceCollectionStopped = true;
      return;
    }

    evidenceByToolCallId.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      text,
    });
    totalEvidenceTextLength += text.length;
    if (totalEvidenceTextLength >= MAX_EVIDENCE_TOTAL_CODE_UNITS) {
      evidenceCollectionStopped = true;
    }
  }

  async function handleTurnEnd(
    _event: TurnEndEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (turnEndHandled) {
      return;
    }
    turnEndHandled = true;

    const stateAtStart = dependencies.getState();
    if (
      stateAtStart.discovery !== 'automatic' ||
      evidenceByToolCallId.size === 0 ||
      ctx.model === undefined
    ) {
      return;
    }

    const epochAtStart = dependencies.getEpoch();
    const sessionIdAtStart = readSessionId(ctx);
    if (!sessionIdAtStart.ok) {
      return;
    }

    const model = ctx.model;
    const evidence = Array.from(evidenceByToolCallId.values()).map(
      (record, index): DiscoveryEvidence => ({
        id: `e${index + 1}`,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        text: record.text,
      }),
    );
    const controller = new AbortController();
    dependencies.requestTracker.track(controller);
    const timeout = setTimeout(() => {
      controller.abort('timeout');
    }, REQUEST_TIMEOUT_MS);

    const currentState = (): RuntimeState | undefined =>
      currentRequestState(
        dependencies,
        ctx,
        epochAtStart,
        stateAtStart,
        sessionIdAtStart,
      );

    const notifyFailure = (): void => {
      try {
        ctx.ui.notify(DISCOVERY_FAILURE_WARNING, 'warning');
      } catch {
        // A UI failure must not turn a discovery failure into an agent failure.
      }
    };

    try {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: DISCOVERY_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: createDiscoveryPayload(evidence),
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
        return;
      }

      const signalKind = signalFailureKind(controller.signal);
      if (signalKind !== undefined) {
        state.lastDiscovery = failedLastDiscovery(signalKind);
        notifyFailure();
        return;
      }

      const parseResult = parseDiscoveryResponse(response, evidence);
      if (!parseResult.ok) {
        state.lastDiscovery = failedLastDiscovery(parseResult.failureKind);
        notifyFailure();
        return;
      }

      const mutation = planMutation(parseResult.output, evidence, state);
      if (mutation.adds.length === 0) {
        state.lastDiscovery = {
          status: 'success',
          added: 0,
        };
        return;
      }

      applyMutation(mutation, state, dependencies);
      try {
        ctx.ui.notify(discoveryNotification(mutation.adds.length), 'info');
      } catch {
        // A notification failure must not turn a successful mutation into a failed turn.
      }
    } catch {
      if (currentState() === undefined) {
        return;
      }

      const signalKind = signalFailureKind(controller.signal);
      stateAtStart.lastDiscovery = failedLastDiscovery(signalKind ?? 'provider');
      notifyFailure();
    } finally {
      dependencies.requestTracker.untrack(controller);
      clearTimeout(timeout);
    }
  }

  return {
    beginTurn,
    resetForSession,
    handleToolResult,
    handleTurnEnd,
    abortActive: (): void => dependencies.requestTracker.abortActive(),
  };
}
