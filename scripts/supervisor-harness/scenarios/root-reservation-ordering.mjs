/* global console, process */

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  runScriptedTurn,
} from '../runner.mjs';
import { resolve } from 'node:path';

const PROBE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/probe-extension.mjs',
);
const PROBE_PROFILE = 'root-reservation-ordering';
const SUPERVISOR_STATE_CUSTOM_TYPE = 'agent-supervisor-state';
const FEATURE_ID = 'probe-root-reservation-state';
const STATE_MARKER = 'root-reservation-ordering';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function parseFeatureStatus(output, label) {
  const line = output
    .split('\n')
    .find((entry) => entry.startsWith(`- ${FEATURE_ID}:`));
  if (line === undefined) {
    throw new Error(`status command omitted ${FEATURE_ID} at ${label}`);
  }
  const match =
    /requested=([^,]+), effective=([^,]+), runtime=([^,]+), status=([^\s]+)(?: reason=(\S+))?/u.exec(
      line,
    );
  if (match === null) {
    throw new Error(`status command omitted runtime fields for ${FEATURE_ID} at ${label}`);
  }
  return {
    line,
    requestedMode: match[1],
    effectiveMode: match[2],
    runtimeMode: match[3],
    status: match[4],
    reason: match[5] ?? null,
  };
}

function parseStatus(output, label) {
  const rootMatch = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(output);
  if (rootMatch === null) {
    throw new Error(`status command omitted Current root at ${label}`);
  }
  return {
    output,
    root: { id: rootMatch[1], status: rootMatch[2] },
    feature: parseFeatureStatus(output, label),
  };
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  if (harness.faux.state.callCount !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  return parseStatus(notifyText(harness.uiMessages.slice(messageStart)), label);
}

function rootSequence(rootId) {
  const match = /^root-(\d+)$/u.exec(rootId);
  return match === null ? undefined : Number(match[1]);
}

function persistedStateEntries(sessionManager) {
  return sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry?.type === 'custom' &&
        entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE,
    )
    .map((entry) => entry.data);
}

function runtimeSequence(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'runtime' ||
    !isRecord(value.state) ||
    value.state.schemaVersion !== 1 ||
    typeof value.state.nextRootRequestSequence !== 'number' ||
    !Number.isSafeInteger(value.state.nextRootRequestSequence) ||
    value.state.nextRootRequestSequence < 1
  ) {
    return undefined;
  }
  return value.state.nextRootRequestSequence;
}

function isFeatureStateForRoot(value, rootRequestId) {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === 'feature' &&
    isRecord(value.state) &&
    value.state.schemaVersion === 1 &&
    value.state.featureId === FEATURE_ID &&
    value.state.featureSchemaVersion === 1 &&
    isRecord(value.state.data) &&
    value.state.data.marker === STATE_MARKER &&
    value.state.data.rootRequestId === rootRequestId
  );
}

function findOrdering(entries, rootRequestId, nextRootRequestSequence) {
  return {
    runtimeIndex: entries.findIndex(
      (entry) => runtimeSequence(entry) === nextRootRequestSequence,
    ),
    featureIndex: entries.findIndex((entry) =>
      isFeatureStateForRoot(entry, rootRequestId),
    ),
  };
}

export const name = 'root-reservation-ordering';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = PROBE_PROFILE;
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
  });

  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'file',
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
    });
    registerCleanup(harness.cleanup);

    const events = await runScriptedTurn(
      harness,
      'Complete the root reservation ordering probe turn.',
      [fauxAssistantMessage(fauxText('Root reservation ordering turn complete.'))],
    );
    check(
      events.filter((event) => event?.type === 'agent_start').length === 1 &&
        events.filter((event) => event?.type === 'agent_end').length === 1,
      'file-backed session completed one real scripted assistant turn',
    );
    harness.assertNoPendingFauxResponses();

    const status = await captureStatus(harness, 'after scripted turn');
    const sequence = rootSequence(status.root.id);
    check(
      status.root.status === 'settled' && sequence !== undefined,
      `root request settled with a numeric sequence (${status.root.id})`,
    );
    check(
      status.feature.status === 'active' &&
        status.feature.effectiveMode === 'autonomous' &&
        status.feature.runtimeMode === 'autonomous',
      'stateful persistence-requiring feature is active with autonomous runtime mode',
    );
    harness.assertNoPendingFauxResponses();

    const sessionFile = harness.session.sessionFile;
    if (typeof sessionFile !== 'string') {
      return { status: 'fail', reason: 'file-backed session did not expose a session file' };
    }

    const memoryEntries = persistedStateEntries(harness.sessionManager);
    const memoryOrdering = findOrdering(memoryEntries, status.root.id, sequence + 1);
    check(
      memoryOrdering.runtimeIndex >= 0,
      `in-memory state entries contain the runtime reservation for ${status.root.id}`,
    );
    check(
      memoryOrdering.featureIndex >= 0,
      `in-memory state entries contain feature state derived from ${status.root.id}`,
    );
    check(
      memoryOrdering.runtimeIndex < memoryOrdering.featureIndex,
      'in-memory runtime reservation precedes root-derived feature state',
    );

    console.log(
      `  TRACE root-reservation-ordering in-memory indices: runtime=${memoryOrdering.runtimeIndex}, feature=${memoryOrdering.featureIndex}`,
    );

    harness.cleanup();
    const reopenedManager = SessionManager.open(sessionFile);
    const diskEntries = persistedStateEntries(reopenedManager);
    const diskOrdering = findOrdering(diskEntries, status.root.id, sequence + 1);
    check(
      diskOrdering.runtimeIndex >= 0,
      `on-disk state entries contain the runtime reservation for ${status.root.id}`,
    );
    check(
      diskOrdering.featureIndex >= 0,
      `on-disk state entries contain feature state derived from ${status.root.id}`,
    );
    check(
      diskOrdering.runtimeIndex < diskOrdering.featureIndex,
      'on-disk runtime reservation precedes root-derived feature state',
    );

    console.log(
      `  TRACE root-reservation-ordering on-disk indices: runtime=${diskOrdering.runtimeIndex}, feature=${diskOrdering.featureIndex}`,
    );

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: `root reservation ordering verified (runtime=${diskOrdering.runtimeIndex}, feature=${diskOrdering.featureIndex})`,
        }
      : { status: 'fail', reason: 'root reservation ordering assertions failed' };
  } finally {
    await cleanupAll();
  }
}
