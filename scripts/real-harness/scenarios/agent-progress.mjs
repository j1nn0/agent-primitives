import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AGENT_PROGRESS_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-progress-state';
const FIRST_MILESTONE = 'b2a-progress-first';
const SECOND_MILESTONE = 'b2a-progress-second';

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

function parseProgressVerdict(message) {
  if (message === undefined || message.isError !== false) {
    return undefined;
  }
  const text = messageText(message);
  const firstLine = text.split('\n')[0] ?? '';
  const unknown = /^Agent Progress: unknown \(([^)]+)\)\.$/.exec(firstLine);
  if (unknown !== null) {
    return { outcome: 'unknown', reason: unknown[1], text };
  }
  const known = /^Agent Progress: (progress|no_progress)\.$/.exec(firstLine);
  return known === null
    ? undefined
    : { outcome: known[1], reason: undefined, text };
}

export const name = 'agent-progress-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_PROGRESS_EXTENSION_PATH],
      expectedExtensionPath: AGENT_PROGRESS_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());
    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          AGENT_PROGRESS_EXTENSION_PATH,
      'loader contract passed for the agent-progress adapter',
    );
    check(
      harness.session.sessionFile === undefined,
      'agent-progress session is in-memory',
    );

    const firstAddEvents = await runScriptedTurn(
      harness,
      'Record the first progress milestone.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_progress_add_milestone', {
            milestone: FIRST_MILESTONE,
          }),
        ),
        fauxAssistantMessage(fauxText('The first milestone was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      firstAddEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_progress_add_milestone',
      ),
      'S1 captured the real first milestone tool event',
    );
    const firstAddEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      firstAddEnvelope?.schemaVersion === 1 &&
        firstAddEnvelope.hasBaseline === false &&
        firstAddEnvelope.currentMilestones?.length === 1 &&
        firstAddEnvelope.currentMilestones[0] === FIRST_MILESTONE &&
        firstAddEnvelope.recordedMilestones?.length === 0,
      'S1 persisted the first milestone before judgment',
    );

    const firstJudgeEvents = await runScriptedTurn(
      harness,
      'Judge the first progress milestone.',
      [
        fauxAssistantMessage(fauxToolCall('agent_progress_judge', {})),
        fauxAssistantMessage(fauxText('The first progress judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      firstJudgeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_progress_judge',
      ),
      'S1 captured the real agent_progress_judge tool event',
    );
    const firstJudgeResult = latestToolResult(harness.session, 'agent_progress_judge');
    const firstVerdict = parseProgressVerdict(firstJudgeResult);
    check(
      firstVerdict?.outcome === 'unknown' &&
        firstVerdict.reason === 'missing_baseline' &&
        firstVerdict.text.includes(`- ${FIRST_MILESTONE}`),
      'S1 surfaced the missing-baseline verdict through the real tool result',
    );
    const baselineEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      baselineEnvelope?.hasBaseline === true &&
        baselineEnvelope.recordedMilestones?.length === 1 &&
        baselineEnvelope.recordedMilestones[0] === FIRST_MILESTONE,
      'S1 persisted the established progress baseline',
    );

    await runScriptedTurn(
      harness,
      'Record a second progress milestone.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_progress_add_milestone', {
            milestone: SECOND_MILESTONE,
          }),
        ),
        fauxAssistantMessage(fauxText('The second milestone was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();

    const secondJudgeEvents = await runScriptedTurn(
      harness,
      'Judge the changed progress milestone set.',
      [
        fauxAssistantMessage(fauxToolCall('agent_progress_judge', {})),
        fauxAssistantMessage(fauxText('The changed progress judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      secondJudgeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_progress_judge',
      ),
      'S2 captured the real changed-set progress judgment',
    );
    const secondJudgeResult = latestToolResult(harness.session, 'agent_progress_judge');
    const secondVerdict = parseProgressVerdict(secondJudgeResult);
    check(
      secondVerdict?.outcome === 'progress' &&
        secondVerdict.reason === undefined &&
        secondVerdict.text.includes(`New milestones:\n- ${SECOND_MILESTONE}`) &&
        secondVerdict.text.includes(`- ${FIRST_MILESTONE}`) &&
        secondVerdict.text.includes(`- ${SECOND_MILESTONE}`),
      'S2 surfaced the grown milestone set through the real tool result',
    );
    const grownEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      grownEnvelope?.hasBaseline === true &&
        grownEnvelope.currentMilestones?.length === 2 &&
        grownEnvelope.currentMilestones[1] === SECOND_MILESTONE &&
        grownEnvelope.recordedMilestones?.length === 2 &&
        grownEnvelope.recordedMilestones[1] === SECOND_MILESTONE,
      'S2 persisted the grown progress state envelope',
    );

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    harness.assertFauxNetworkIdentity();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'agent-progress wiring verified' }
      : { status: 'fail', reason: 'agent-progress assertions failed' };
  } finally {
    await cleanupAll();
  }
}
