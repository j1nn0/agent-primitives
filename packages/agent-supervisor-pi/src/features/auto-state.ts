import { restoreAgentState } from '@j1nn0/agent-state';
import type { AgentState, AgentStateSnapshot, WorkItemStatus } from '@j1nn0/agent-state';
import { computeSupervisorJsonDigest } from '../digest.js';
import type { SupervisorFactRecord } from '../fact.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from '../internal.js';
import type { JsonValue } from '../json.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntimeContext,
  SupervisorFeatureStateCodec,
} from '../module.js';
import type { SupervisorObservation } from '../observation.js';

const FEATURE_ID = 'auto-state';
const ASSESSMENT_FACT_KIND = 'kernel:completion-assessment';
const VERDICT_FACT_KIND = `${FEATURE_ID}:verdict`;
const KERNEL_SOURCE_ID = 'kernel';

/** Maximum number of persisted work items. The core has no capacity limit; bounding is this feature's job. */
export const AUTO_STATE_MAX_WORK_ITEMS = 64;
/** Maximum number of persisted decisions. The core has no capacity limit; bounding is this feature's job. */
export const AUTO_STATE_MAX_DECISIONS = 64;
/** Maximum Unicode code points accepted for a persisted objective. */
export const AUTO_STATE_MAX_OBJECTIVE_CODE_POINTS = 1000;
/** Maximum Unicode code points accepted for one persisted work-item or decision text. */
export const AUTO_STATE_MAX_ENTRY_CODE_POINTS = 500;

/**
 * Stable truncation for deterministic ids: the first 12 lowercase hex characters (48 bits) of the
 * canonical SHA-256 digest of the exact candidate quote. No randomness, no timestamps.
 */
const AUTO_STATE_ID_DIGEST_HEX_CHARS = 12;

const AUTO_STATE_DESCRIPTOR = {
  id: FEATURE_ID,
  schemaVersion: 1,
  maturity: 'validated',
  defaultMode: 'autonomous',
  observes: ['assessment-ready'],
  provides: [],
  requires: ['kernel:assessment', 'kernel:observation', 'kernel:persistence'],
  conflictsWith: [],
  usesAuxiliaryModel: true,
  interventionIntents: [],
} as const;

export type AutoStateWorkItemState = {
  readonly id: string;
  readonly content: string;
  readonly status: WorkItemStatus;
};

export type AutoStateDecisionState = {
  readonly id: string;
  readonly content: string;
};

export type AutoStateFeatureState = {
  readonly schemaVersion: 1;
  readonly objective?: string;
  readonly workItems: AutoStateWorkItemState[];
  readonly decisions: AutoStateDecisionState[];
};

const AUTO_STATE_STATE_SCHEMA_VERSION = 1;

const EMPTY_AUTO_STATE_FEATURE_STATE: AutoStateFeatureState = {
  schemaVersion: 1,
  workItems: [],
  decisions: [],
};

function toAutoStateFeatureState(snapshot: AgentStateSnapshot): AutoStateFeatureState {
  return {
    schemaVersion: 1,
    ...(snapshot.objective === undefined ? {} : { objective: snapshot.objective }),
    workItems: snapshot.workItems.map((item) => ({
      id: item.id,
      content: item.content,
      status: item.status,
    })),
    decisions: snapshot.decisions.map((decision) => ({ id: decision.id, content: decision.content })),
  };
}

/** Codec validation restores through the core rather than duplicating core validation. */
function validateAutoStateFeatureState(value: unknown): AutoStateFeatureState {
  return toAutoStateFeatureState(restoreAgentState(value).snapshot());
}

const AUTO_STATE_STATE_CODEC: SupervisorFeatureStateCodec<AutoStateFeatureState> = {
  schemaVersion: AUTO_STATE_STATE_SCHEMA_VERSION,
  validate: validateAutoStateFeatureState,
};

type AutoStateWorkItemStatus = 'open' | 'in_progress' | 'blocked';
type AutoStateDecisionSource = 'task' | 'assistant';

interface AutoStateWorkItemCandidate {
  readonly quote: string;
  readonly status: AutoStateWorkItemStatus;
}

interface AutoStateDecisionCandidate {
  readonly source: AutoStateDecisionSource;
  readonly quote: string;
}

type AutoStateStateDomain =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly objective: string | undefined;
      readonly workItems: readonly AutoStateWorkItemCandidate[];
      readonly decisions: readonly AutoStateDecisionCandidate[];
    };

interface AssessmentFact {
  readonly rootRequestId: string;
  readonly assessmentId: string;
  readonly runSequence: number;
  readonly state: AutoStateStateDomain | undefined;
}

interface AssessmentReadyPayload {
  readonly assessmentId: string;
  readonly runSequence: number;
}

const AUTO_STATE_DOMAIN_KEYS = new Set(['available', 'state']);
const AUTO_STATE_FACT_STATE_KEYS = new Set(['objective', 'workItems', 'decisions']);
const AUTO_STATE_OBJECTIVE_KEYS = new Set(['quote']);
const AUTO_STATE_WORK_ITEM_KEYS = new Set(['quote', 'status']);
const AUTO_STATE_DECISION_KEYS = new Set(['source', 'quote']);

function defensiveJsonParse(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCandidateWorkItemStatus(value: unknown): value is AutoStateWorkItemStatus {
  return value === 'open' || value === 'in_progress' || value === 'blocked';
}

function isCandidateDecisionSource(value: unknown): value is AutoStateDecisionSource {
  return value === 'task' || value === 'assistant';
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Deterministic work-item id derived from the exact candidate quote. A null digest (never
 * expected for a string, which is always JSON-safe) rejects the whole update.
 */
function autoStateWorkItemId(quote: string): string | undefined {
  const digest = computeSupervisorJsonDigest(quote);
  return digest === null ? undefined : `auto:work:${digest.slice(0, AUTO_STATE_ID_DIGEST_HEX_CHARS)}`;
}

/** Deterministic decision id derived from the exact candidate quote. */
function autoStateDecisionId(quote: string): string | undefined {
  const digest = computeSupervisorJsonDigest(quote);
  return digest === null ? undefined : `auto:decision:${digest.slice(0, AUTO_STATE_ID_DIGEST_HEX_CHARS)}`;
}

function readStateDomain(value: unknown): AutoStateStateDomain | undefined {
  if (
    !isPlainObject(value) ||
    !hasOnlyAllowedKeys(value, AUTO_STATE_DOMAIN_KEYS) ||
    !hasOwn(value, 'available')
  ) {
    return undefined;
  }
  if (value.available === false) {
    return hasOwn(value, 'state') ? undefined : { available: false };
  }
  if (value.available !== true || !hasOwn(value, 'state') || !isPlainObject(value.state)) {
    return undefined;
  }
  const domain = value.state;
  if (!hasOnlyAllowedKeys(domain, AUTO_STATE_FACT_STATE_KEYS)) {
    return undefined;
  }
  let objective: string | undefined;
  if (hasOwn(domain, 'objective')) {
    const rawObjective = domain.objective;
    if (
      !isPlainObject(rawObjective) ||
      !hasOnlyAllowedKeys(rawObjective, AUTO_STATE_OBJECTIVE_KEYS) ||
      !hasOwn(rawObjective, 'quote') ||
      !isNonEmptyString(rawObjective.quote)
    ) {
      return undefined;
    }
    objective = rawObjective.quote;
  }
  let workItems: readonly AutoStateWorkItemCandidate[] = [];
  if (hasOwn(domain, 'workItems')) {
    if (!isDenseArray(domain.workItems)) {
      return undefined;
    }
    const parsed: AutoStateWorkItemCandidate[] = [];
    for (const entry of domain.workItems) {
      if (
        !isPlainObject(entry) ||
        !hasOnlyAllowedKeys(entry, AUTO_STATE_WORK_ITEM_KEYS) ||
        !hasOwn(entry, 'quote') ||
        !hasOwn(entry, 'status') ||
        !isNonEmptyString(entry.quote) ||
        !isCandidateWorkItemStatus(entry.status)
      ) {
        return undefined;
      }
      parsed.push({ quote: entry.quote, status: entry.status });
    }
    workItems = parsed;
  }
  let decisions: readonly AutoStateDecisionCandidate[] = [];
  if (hasOwn(domain, 'decisions')) {
    if (!isDenseArray(domain.decisions)) {
      return undefined;
    }
    const parsed: AutoStateDecisionCandidate[] = [];
    for (const entry of domain.decisions) {
      if (
        !isPlainObject(entry) ||
        !hasOnlyAllowedKeys(entry, AUTO_STATE_DECISION_KEYS) ||
        !hasOwn(entry, 'source') ||
        !hasOwn(entry, 'quote') ||
        !isCandidateDecisionSource(entry.source) ||
        !isNonEmptyString(entry.quote)
      ) {
        return undefined;
      }
      parsed.push({ source: entry.source, quote: entry.quote });
    }
    decisions = parsed;
  }
  return { available: true, objective, workItems, decisions };
}

function readAssessmentFact(value: unknown): AssessmentFact | undefined {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const schemaVersion = parsed.schemaVersion;
  const factId = readNonEmptyString(parsed.id);
  const sequence = readNonNegativeSafeInteger(parsed.sequence);
  const sourceFeatureId = parsed.sourceFeatureId;
  const rootRequestId = readNonEmptyString(parsed.rootRequestId);
  const kind = parsed.kind;
  const data = parsed.data;
  if (
    schemaVersion !== 1 ||
    factId === undefined ||
    sequence === undefined ||
    sourceFeatureId !== KERNEL_SOURCE_ID ||
    rootRequestId === undefined ||
    kind !== ASSESSMENT_FACT_KIND ||
    !isPlainObject(data)
  ) {
    return undefined;
  }
  const assessmentId = readNonEmptyString(data.assessmentId);
  const dataRootRequestId = readNonEmptyString(data.rootRequestId);
  const runSequence = readNonNegativeSafeInteger(data.runSequence);
  if (assessmentId === undefined || dataRootRequestId !== rootRequestId || runSequence === undefined) {
    return undefined;
  }
  const state = !hasOwn(data, 'state') ? undefined : readStateDomain(data.state);
  return { rootRequestId, assessmentId, runSequence, state };
}

function hasMatchingFactIdentity(
  value: unknown,
  rootRequestId: string,
  assessmentId: string,
  runSequence: number,
): boolean {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed) || parsed.rootRequestId !== rootRequestId || !isPlainObject(parsed.data)) {
    return false;
  }
  return parsed.data.assessmentId === assessmentId && parsed.data.runSequence === runSequence;
}

function readAssessmentReadyPayload(value: unknown): AssessmentReadyPayload | undefined {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const assessmentId = readNonEmptyString(parsed.assessmentId);
  const runSequence = readNonNegativeSafeInteger(parsed.runSequence);
  return assessmentId === undefined || runSequence === undefined
    ? undefined
    : { assessmentId, runSequence };
}

function readMatchingAssessment(
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<AutoStateFeatureState>,
): AssessmentFact | undefined {
  if (observation.rootRequestId === null) {
    return undefined;
  }
  const payload = readAssessmentReadyPayload(observation.payload);
  if (payload === undefined) {
    return undefined;
  }
  let facts: readonly SupervisorFactRecord[];
  try {
    facts = context.facts.byKind(ASSESSMENT_FACT_KIND);
  } catch {
    return undefined;
  }
  if (!Array.isArray(facts)) {
    return undefined;
  }
  let match: AssessmentFact | undefined;
  let matchCount = 0;
  for (const factValue of facts) {
    const fact = readAssessmentFact(factValue);
    if (fact !== undefined) {
      if (
        fact.rootRequestId === observation.rootRequestId &&
        fact.assessmentId === payload.assessmentId &&
        fact.runSequence === payload.runSequence
      ) {
        match = fact;
        matchCount += 1;
      }
      continue;
    }
    if (
      hasMatchingFactIdentity(factValue, observation.rootRequestId, payload.assessmentId, payload.runSequence)
    ) {
      return undefined;
    }
  }
  return matchCount === 1 ? match : undefined;
}

interface AutoStateCandidates {
  readonly objective: string | undefined;
  readonly workItems: readonly AutoStateWorkItemCandidate[];
  readonly decisions: readonly AutoStateDecisionCandidate[];
}

interface AutoStateAppliedUpdate {
  readonly snapshot: AgentStateSnapshot;
  readonly objectiveChanged: boolean;
  readonly workItemsAdded: number;
  readonly workItemStatusesChanged: number;
  readonly decisionsAdded: number;
}

/**
 * Applies every candidate to a scratch core instance. Any invalid input, duplicate id, unknown
 * item, id collision, or bound violation rejects the ENTIRE update; the caller then leaves the
 * previous state untouched, so no partial application is possible.
 */
function applyAutoStateCandidates(
  base: AgentState,
  candidates: AutoStateCandidates,
): AutoStateAppliedUpdate | undefined {
  try {
    let state = base;
    let objectiveChanged = false;
    let workItemsAdded = 0;
    let workItemStatusesChanged = 0;
    let decisionsAdded = 0;

    if (candidates.objective !== undefined) {
      if (countCodePoints(candidates.objective) > AUTO_STATE_MAX_OBJECTIVE_CODE_POINTS) {
        return undefined;
      }
      const current = state.snapshot();
      if (current.objective !== candidates.objective) {
        // The core has no objective setter; rebuild the snapshot and restore through the core.
        state = restoreAgentState({
          schemaVersion: 1,
          objective: candidates.objective,
          workItems: current.workItems,
          decisions: current.decisions,
        });
        objectiveChanged = true;
      }
    }

    for (const candidate of candidates.workItems) {
      if (countCodePoints(candidate.quote) > AUTO_STATE_MAX_ENTRY_CODE_POINTS) {
        return undefined;
      }
      const id = autoStateWorkItemId(candidate.quote);
      if (id === undefined) {
        return undefined;
      }
      const existing = state.getWorkItem(id);
      if (existing !== undefined) {
        // Same deterministic id but different content is a collision: reject the whole update.
        if (existing.content !== candidate.quote) {
          return undefined;
        }
        // `done` is sticky: this feature never infers it and never regresses it.
        if (existing.status === 'done' || existing.status === candidate.status) {
          continue;
        }
        state.setWorkItemStatus(id, candidate.status);
        workItemStatusesChanged += 1;
        continue;
      }
      state.addWorkItem({ id, content: candidate.quote, status: candidate.status });
      workItemsAdded += 1;
    }

    const decisionContentById = new Map(state.listDecisions().map((decision) => [decision.id, decision.content] as const));
    for (const candidate of candidates.decisions) {
      if (countCodePoints(candidate.quote) > AUTO_STATE_MAX_ENTRY_CODE_POINTS) {
        return undefined;
      }
      const id = autoStateDecisionId(candidate.quote);
      if (id === undefined) {
        return undefined;
      }
      const existingContent = decisionContentById.get(id);
      if (existingContent !== undefined) {
        if (existingContent !== candidate.quote) {
          return undefined;
        }
        continue;
      }
      state.addDecision({ id, content: candidate.quote });
      decisionContentById.set(id, candidate.quote);
      decisionsAdded += 1;
    }

    const next = state.snapshot();
    if (next.workItems.length > AUTO_STATE_MAX_WORK_ITEMS) {
      return undefined;
    }
    if (next.decisions.length > AUTO_STATE_MAX_DECISIONS) {
      return undefined;
    }
    if (
      next.objective !== undefined &&
      countCodePoints(next.objective) > AUTO_STATE_MAX_OBJECTIVE_CODE_POINTS
    ) {
      return undefined;
    }
    for (const item of next.workItems) {
      if (countCodePoints(item.content) > AUTO_STATE_MAX_ENTRY_CODE_POINTS) {
        return undefined;
      }
    }
    for (const decision of next.decisions) {
      if (countCodePoints(decision.content) > AUTO_STATE_MAX_ENTRY_CODE_POINTS) {
        return undefined;
      }
    }
    // The core stays the authority: re-validate the resulting snapshot before emitting it.
    const validated = restoreAgentState(next).snapshot();
    return {
      snapshot: validated,
      objectiveChanged,
      workItemsAdded,
      workItemStatusesChanged,
      decisionsAdded,
    };
  } catch {
    return undefined;
  }
}

function isSameAgentStateSnapshot(left: AgentStateSnapshot, right: AgentStateSnapshot): boolean {
  if (left.objective !== right.objective) {
    return false;
  }
  if (left.workItems.length !== right.workItems.length || left.decisions.length !== right.decisions.length) {
    return false;
  }
  const leftItems = new Map(left.workItems.map((item) => [item.id, item] as const));
  for (const item of right.workItems) {
    const prior = leftItems.get(item.id);
    if (prior === undefined || prior.content !== item.content || prior.status !== item.status) {
      return false;
    }
  }
  const leftDecisions = new Map(left.decisions.map((decision) => [decision.id, decision.content] as const));
  for (const decision of right.decisions) {
    if (leftDecisions.get(decision.id) !== decision.content) {
      return false;
    }
  }
  return true;
}

function createVerdictData(
  assessmentId: string,
  runSequence: number,
  changed: boolean,
  applied: AutoStateAppliedUpdate,
): JsonValue {
  return {
    schemaVersion: 1,
    assessmentId,
    runSequence,
    changed,
    objectiveChanged: applied.objectiveChanged,
    workItemsAdded: applied.workItemsAdded,
    workItemStatusesChanged: applied.workItemStatusesChanged,
    decisionsAdded: applied.decisionsAdded,
  };
}

export function createAutoState(): SupervisorFeatureModule<JsonValue, AutoStateFeatureState> {
  return {
    descriptor: AUTO_STATE_DESCRIPTOR,
    state: AUTO_STATE_STATE_CODEC,
    create: () => {
      // Observe-mode shadow only: autonomous mode always reads the persisted context state.
      // A mode change rebuilds the runtime and resets this shadow; that is expected.
      let shadow: AutoStateFeatureState | null = null;
      let shadowSeeded = false;
      const onObservation = (
        observation: SupervisorObservation,
        context: SupervisorFeatureRuntimeContext<AutoStateFeatureState>,
      ): SupervisorFeatureEmission<AutoStateFeatureState> | undefined => {
        if (observation.kind !== 'assessment-ready') {
          return undefined;
        }
        try {
          const matched = readMatchingAssessment(observation, context);
          if (matched === undefined || matched.state === undefined || !matched.state.available) {
            return undefined;
          }
          const observe = context.effectiveMode === 'observe';
          let persisted: AutoStateFeatureState | null;
          if (observe) {
            if (!shadowSeeded) {
              shadow = toAutoStateFeatureState(
                restoreAgentState(context.state ?? EMPTY_AUTO_STATE_FEATURE_STATE).snapshot(),
              );
              shadowSeeded = true;
            }
            persisted = shadow;
          } else {
            persisted = context.state;
          }
          const base = restoreAgentState(persisted ?? EMPTY_AUTO_STATE_FEATURE_STATE);
          const previous = base.snapshot();
          const applied = applyAutoStateCandidates(base, matched.state);
          if (applied === undefined) {
            return undefined;
          }
          const changed = !isSameAgentStateSnapshot(previous, applied.snapshot);
          const data = createVerdictData(
            matched.assessmentId,
            matched.runSequence,
            changed,
            applied,
          );
          if (observe) {
            shadow = toAutoStateFeatureState(applied.snapshot);
            return { facts: [{ kind: VERDICT_FACT_KIND, evidenceRefs: [], data }] };
          }
          if (!changed) {
            return { facts: [{ kind: VERDICT_FACT_KIND, evidenceRefs: [], data }] };
          }
          return {
            facts: [{ kind: VERDICT_FACT_KIND, evidenceRefs: [], data }],
            nextState: toAutoStateFeatureState(applied.snapshot),
          };
        } catch {
          return undefined;
        }
      };
      return { onObservation };
    },
  };
}

export default createAutoState;
