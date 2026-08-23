import type {
  DiscoveryLifecycle,
  DiscoveryLifecycleStatus,
  RuntimeState,
} from './types.js';

/**
 * Lifecycle state for captured discoveries.
 *
 * Being backed by evidence and being currently authoritative are different
 * properties. A fact whose evidence still resolves can have been replaced by a
 * later observation, so the two are tracked separately: provenance answers
 * "what was this based on", lifecycle answers "does it still stand".
 *
 * Phase 1 only ever changes status. Nothing here deletes an item, guesses that
 * one fact replaces another, or asks a model to decide.
 */

export type DiscoveryLifecycleFailure =
  | 'unknown-item'
  | 'not-a-discovery'
  | 'same-item'
  | 'already-retired'
  | 'already-superseded'
  | 'target-not-active';

export type DiscoveryLifecycleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: DiscoveryLifecycleFailure;
      /** The id the failure is about, so a caller can name it accurately. */
      readonly subject: string;
    };

function nowIso(): string {
  return new Date().toISOString();
}

export function createDiscoveryLifecycle(
  status: DiscoveryLifecycleStatus = 'active',
): DiscoveryLifecycle {
  const timestamp = nowIso();
  return { status, createdAt: timestamp, updatedAt: timestamp };
}

export function copyDiscoveryLifecycle(
  lifecycle: DiscoveryLifecycle,
): DiscoveryLifecycle {
  return lifecycle.supersededBy === undefined
    ? {
        status: lifecycle.status,
        createdAt: lifecycle.createdAt,
        updatedAt: lifecycle.updatedAt,
      }
    : {
        status: lifecycle.status,
        createdAt: lifecycle.createdAt,
        updatedAt: lifecycle.updatedAt,
        supersededBy: lifecycle.supersededBy,
      };
}

/**
 * The status of a discovery item. A discovery with no lifecycle record is
 * treated as active: that is how state persisted before schema v5 restores,
 * and an absent record must never silently withhold recovery.
 */
export function discoveryStatus(
  state: RuntimeState,
  itemId: string,
): DiscoveryLifecycleStatus {
  return state.discoveryLifecycle.get(itemId)?.status ?? 'active';
}

/**
 * Whether recovery may re-inject an item. Only discoveries can be held back,
 * and only once someone explicitly retired or superseded them; manual and
 * extracted items are never filtered here.
 */
export function isRecoverableItem(state: RuntimeState, itemId: string): boolean {
  if (!state.discoveryItemIds.has(itemId)) {
    return true;
  }
  return discoveryStatus(state, itemId) === 'active';
}

function requireDiscovery(
  state: RuntimeState,
  itemId: string,
): DiscoveryLifecycleFailure | undefined {
  if (!state.guard.has(itemId)) {
    return 'unknown-item';
  }
  if (!state.discoveryItemIds.has(itemId)) {
    return 'not-a-discovery';
  }
  return undefined;
}

function transition(
  state: RuntimeState,
  itemId: string,
  next: Omit<DiscoveryLifecycle, 'createdAt' | 'updatedAt'>,
): void {
  const previous = state.discoveryLifecycle.get(itemId);
  const timestamp = nowIso();
  state.discoveryLifecycle.set(itemId, {
    ...next,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
}

/** Marks a discovery as no longer authoritative, without deleting anything. */
export function retireDiscovery(
  state: RuntimeState,
  itemId: string,
): DiscoveryLifecycleResult {
  const failure = requireDiscovery(state, itemId);
  if (failure !== undefined) {
    return { ok: false, failure, subject: itemId };
  }
  const status = discoveryStatus(state, itemId);
  if (status === 'retired') {
    return { ok: false, failure: 'already-retired', subject: itemId };
  }
  if (status === 'superseded') {
    return { ok: false, failure: 'already-superseded', subject: itemId };
  }

  transition(state, itemId, { status: 'retired' });
  return { ok: true };
}

/**
 * Records that one discovery replaced another. The replacement has to be an
 * active discovery itself, so a superseded chain cannot point at something
 * that no longer stands.
 */
export function supersedeDiscovery(
  state: RuntimeState,
  itemId: string,
  supersededBy: string,
): DiscoveryLifecycleResult {
  if (itemId === supersededBy) {
    return { ok: false, failure: 'same-item', subject: itemId };
  }

  const failure = requireDiscovery(state, itemId);
  if (failure !== undefined) {
    return { ok: false, failure, subject: itemId };
  }
  const status = discoveryStatus(state, itemId);
  if (status === 'retired') {
    return { ok: false, failure: 'already-retired', subject: itemId };
  }
  if (status === 'superseded') {
    return { ok: false, failure: 'already-superseded', subject: itemId };
  }
  const targetFailure = requireDiscovery(state, supersededBy);
  if (targetFailure !== undefined) {
    return { ok: false, failure: targetFailure, subject: supersededBy };
  }
  if (discoveryStatus(state, supersededBy) !== 'active') {
    return { ok: false, failure: 'target-not-active', subject: supersededBy };
  }

  transition(state, itemId, { status: 'superseded', supersededBy });
  return { ok: true };
}
