/* global setImmediate */

import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  CONTEXT_GUARD_EXTENSION_PATH,
  assistantMessages,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  runScriptedTurn,
  stateEntriesFor,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-context-guard-state';
const RECOVERY_CUSTOM_TYPE = 'agent-context-guard-recovery';
const MANUAL_ITEM_ID = 'crit';
const MANUAL_CONTENT = 'Never ship the unsafe flag.';
const EXTRACTED_CONTENT = 'never commit the database password';
const COMPACTION_ITEM_ID = 'g3-critical';
const COMPACTION_ITEM_CONTENT = 'Never forget the red compaction beacon.';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

function stateItems(envelope) {
  return isRecord(envelope) && Array.isArray(envelope.items) ? envelope.items : [];
}

function findItem(envelope, content) {
  return stateItems(envelope).find(
    (item) => isRecord(item) && item.content === content,
  );
}

function contentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

function latestAssistantText(session) {
  const message = assistantMessages(session).at(-1);
  return message === undefined || !Array.isArray(message.content)
    ? undefined
    : contentText(message.content);
}

function recoveryEntries(sessionManager) {
  return sessionManager.getBranch().filter(
    (entry) =>
      isRecord(entry) &&
      entry.type === 'custom_message' &&
      entry.customType === RECOVERY_CUSTOM_TYPE,
  );
}

async function waitForRecovery(sessionManager) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = recoveryEntries(sessionManager).at(-1);
    if (entry !== undefined) {
      return entry;
    }
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  return undefined;
}

function observeCompaction(check, condition, label, reason) {
  check(condition, label);
  if (!condition) {
    throw new Error(
      `COMPACTION_REAL_RUNTIME_NOT_DETERMINISTIC: ${reason}`,
    );
  }
}

async function runCompactionProbe({ registerCleanup, check }) {
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const harness = await createIsolatedSession({
    isolation,
    settingsManager,
    additionalExtensionPaths: [CONTEXT_GUARD_EXTENSION_PATH],
    expectedExtensionPath: CONTEXT_GUARD_EXTENSION_PATH,
  });
  registerCleanup(() => harness.session.dispose());

  observeCompaction(
    check,
    harness.extensionsResult.extensions.length === 1 &&
      harness.extensionsResult.extensions[0]?.resolvedPath ===
        CONTEXT_GUARD_EXTENSION_PATH,
    'G3 loaded the context-guard extension with the loader contract',
    'the compaction probe did not load exactly the expected extension',
  );
  observeCompaction(
    check,
    harness.session.sessionFile === undefined,
    'G3 compaction probe stayed in-memory',
    'the compaction probe created a session file',
  );

  await harness.session.prompt('/context-guard recovery critical');
  await harness.session.prompt(
    `/context-guard add ${COMPACTION_ITEM_ID} constraint --critical ${COMPACTION_ITEM_CONTENT}`,
  );
  const protectedEnvelope = latestStateEnvelope(harness.sessionManager);
  const protectedItem = findItem(protectedEnvelope, COMPACTION_ITEM_CONTENT);
  observeCompaction(
    check,
    protectedEnvelope?.schemaVersion === 5 &&
      protectedEnvelope.recovery === 'critical' &&
      protectedItem?.id === COMPACTION_ITEM_ID &&
      protectedItem.kind === 'constraint' &&
      protectedItem.critical === true,
    'G3 persisted the critical item before compaction',
    'the pre-compaction state envelope did not contain the requested critical item',
  );

  const warmupCallCount = harness.faux.state.callCount;
  await runScriptedTurn(harness, 'Warm up the compaction branch.', [
    fauxAssistantMessage(fauxText('Warm-up completed.')),
  ]);
  harness.assertNoPendingFauxResponses();
  observeCompaction(
    check,
    harness.faux.state.callCount === warmupCallCount + 1,
    'G3 warm-up used exactly one faux completion',
    `the warm-up used ${harness.faux.state.callCount - warmupCallCount} faux completions`,
  );

  const summaryText = 'The session continued without notable change.';
  harness.faux.setResponses([fauxAssistantMessage(fauxText(summaryText))]);
  const compactionCallCount = harness.faux.state.callCount;
  const compactResult = await harness.session.compact();
  harness.assertNoPendingFauxResponses();
  observeCompaction(
    check,
    harness.faux.state.callCount === compactionCallCount + 1,
    'G3 compaction used exactly the scripted summarization completion',
    `compaction used ${harness.faux.state.callCount - compactionCallCount} faux completions`,
  );
  observeCompaction(
    check,
    isRecord(compactResult) &&
      typeof compactResult.summary === 'string' &&
      !compactResult.summary.includes(COMPACTION_ITEM_CONTENT),
    'G3 summarization completed without reintroducing the protected item',
    'the compaction result was malformed or its summary contained the protected item',
  );

  const compactionEntries = harness.sessionManager.getBranch().filter(
    (entry) => isRecord(entry) && entry.type === 'compaction',
  );
  const compactionEntry = compactionEntries.at(-1);
  observeCompaction(
    check,
    compactionEntries.length === 1 && typeof compactionEntry?.id === 'string',
    'G3 produced one real compaction entry',
    'the real session did not expose one identifiable compaction entry',
  );

  const continueCallCount = harness.faux.state.callCount;
  await runScriptedTurn(harness, 'Continue.', [
    fauxAssistantMessage(fauxText('Continued.')),
  ]);
  harness.assertNoPendingFauxResponses();
  harness.assertFauxNetworkIdentity();
  observeCompaction(
    check,
    harness.faux.state.callCount === continueCallCount + 1,
    'G3 continuation used exactly one faux completion',
    `the continuation used ${harness.faux.state.callCount - continueCallCount} faux completions`,
  );
  observeCompaction(
    check,
    latestAssistantText(harness.session) === 'Continued.',
    'G3 completed the post-compaction scripted turn',
    'the post-compaction assistant message did not match the scripted response',
  );

  const recoveryEntry = await waitForRecovery(harness.sessionManager);
  const recoveryContent =
    recoveryEntry === undefined ? '' : contentText(recoveryEntry.content);
  observeCompaction(
    check,
    recoveryEntry !== undefined &&
      recoveryEntry.type === 'custom_message' &&
      recoveryEntry.customType === RECOVERY_CUSTOM_TYPE &&
      recoveryEntry.display === false &&
      recoveryContent.includes(COMPACTION_ITEM_CONTENT),
    'G3 persisted critical recovery through the real sendMessage path',
    'the first post-compaction context event did not produce the expected recovery message',
  );
  observeCompaction(
    check,
    recoveryEntry?.details?.schemaVersion === 1 &&
      recoveryEntry.details.sourceCompactionId === compactionEntry?.id &&
      Array.isArray(recoveryEntry.details.itemIds) &&
      recoveryEntry.details.itemIds.includes(COMPACTION_ITEM_ID),
    'G3 recovery carried structured compaction and item references',
    'the recovery message details did not identify the source compaction and critical item',
  );

  harness.assertInMemorySession();
  harness.assertNoAuthCredentials();
}

export const name = 'context-guard-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [CONTEXT_GUARD_EXTENSION_PATH],
      expectedExtensionPath: CONTEXT_GUARD_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());

    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          CONTEXT_GUARD_EXTENSION_PATH,
      'G1 loaded the context-guard extension with the loader contract',
    );
    check(
      harness.session.sessionFile === undefined,
      'G1 context-guard session is in-memory',
    );

    await harness.session.prompt(
      '/context-guard add crit constraint --critical Never ship the unsafe flag.',
    );
    const addedEnvelope = latestStateEnvelope(harness.sessionManager);
    const addedItem = findItem(addedEnvelope, MANUAL_CONTENT);
    check(
      addedEnvelope?.schemaVersion === 5 &&
        addedItem?.id === MANUAL_ITEM_ID &&
        addedItem.kind === 'constraint' &&
        addedItem.critical === true &&
        addedItem.content === MANUAL_CONTENT,
      'G1 persisted the structured critical protected item',
    );

    const beforeStatusEntries = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const beforeStatusEntry = beforeStatusEntries.at(-1);
    await harness.session.prompt('/context-guard status');
    const afterStatusEntries = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const afterStatusEnvelope = latestStateEnvelope(harness.sessionManager);
    const afterStatusItem = findItem(afterStatusEnvelope, MANUAL_CONTENT);
    check(
      afterStatusEntries.length === beforeStatusEntries.length &&
        afterStatusEntries.at(-1)?.id === beforeStatusEntry?.id &&
        afterStatusEnvelope?.schemaVersion === 5 &&
        afterStatusEnvelope.recovery === 'off' &&
        afterStatusEnvelope.extraction === 'off' &&
        afterStatusEnvelope.discovery === 'off' &&
        afterStatusItem?.id === MANUAL_ITEM_ID &&
        afterStatusItem.kind === 'constraint' &&
        afterStatusItem.critical === true &&
        afterStatusItem.content === MANUAL_CONTENT &&
        Array.isArray(afterStatusEnvelope.autoItemIds) &&
        afterStatusEnvelope.autoItemIds.length === 0,
      'G1 read-only status completed without mutating the state envelope',
    );

    await harness.session.prompt('/context-guard recovery critical');
    const recoveryEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      recoveryEnvelope?.schemaVersion === 5 &&
        recoveryEnvelope.recovery === 'critical' &&
        findItem(recoveryEnvelope, MANUAL_CONTENT)?.id === MANUAL_ITEM_ID,
      'G1 wired the recovery critical command and persisted its mode',
    );

    await harness.session.prompt('/context-guard extraction automatic');
    const extractionEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      extractionEnvelope?.schemaVersion === 5 &&
        extractionEnvelope.extraction === 'automatic' &&
        extractionEnvelope.recovery === 'critical',
      'G1 wired the automatic extraction command and persisted its mode',
    );

    const g2CallCount = harness.faux.state.callCount;
    await runScriptedTurn(
      harness,
      'Please remember: never commit the database password.',
      [
        fauxAssistantMessage(
          fauxText(
            '{"schemaVersion":1,"add":[{"content":"never commit the database password","kind":"constraint","critical":true}],"removeAutoItemIds":[]}',
          ),
        ),
        fauxAssistantMessage(fauxText('Understood.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    harness.assertFauxNetworkIdentity();
    check(
      harness.faux.state.callCount === g2CallCount + 2,
      `G2 consumed one extraction and one turn faux completion (observed ${harness.faux.state.callCount - g2CallCount})`,
    );
    check(
      latestAssistantText(harness.session) === 'Understood.',
      'G2 completed the scripted turn with the second faux response',
    );
    const extractedEnvelope = latestStateEnvelope(harness.sessionManager);
    const extractedItem = findItem(extractedEnvelope, EXTRACTED_CONTENT);
    check(
      extractedEnvelope?.schemaVersion === 5 &&
        extractedItem?.kind === 'constraint' &&
        extractedItem?.content === EXTRACTED_CONTENT &&
        extractedItem?.critical === true &&
        typeof extractedItem.id === 'string' &&
        extractedItem.id.startsWith('auto:constraint:') &&
        Array.isArray(extractedEnvelope.autoItemIds) &&
        extractedEnvelope.autoItemIds.includes(extractedItem.id),
      'G2 persisted the extraction-added automatic constraint with provenance',
    );

    try {
      await runCompactionProbe({ registerCleanup, check });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('COMPACTION_REAL_RUNTIME_NOT_DETERMINISTIC:')
      ) {
        throw error;
      }
      throw new Error(
        `COMPACTION_REAL_RUNTIME_NOT_DETERMINISTIC: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        { cause: error },
      );
    }

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'context-guard G1, G2, and G3 verified' }
      : {
          status: 'fail',
          reason: 'PRODUCTION_BUG_REVIEW_REQUIRED: context-guard assertions failed',
        };
  } finally {
    await cleanupAll();
  }
}
