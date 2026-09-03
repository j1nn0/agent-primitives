import {
  fauxAssistantMessage,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import {
  SUPERVISOR_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  runScriptedTurn,
} from '../runner.mjs';

const SUPERVISOR_CONFIG_CUSTOM_TYPE = 'agent-supervisor-config';
// The production profile intentionally includes completion-gate as an assessment consumer.
const ACTIVE_FEATURE_STATUS =
  'maturity=validated, default=autonomous, requested=autonomous, effective=autonomous, runtime=autonomous, status=active';
const NO_CLAIM_ASSESSMENT_RESPONSE = fauxAssistantMessage(
  fauxText(JSON.stringify({ schemaVersion: 1, claims: [] })),
);

function supervisorConfigEntries(sessionManager) {
  return sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry?.type === 'custom' &&
        entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE,
    );
}

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

export const name = 'kernel-default';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'memory',
      additionalExtensionPaths: [SUPERVISOR_EXTENSION_PATH],
      expectedExtensionPath: SUPERVISOR_EXTENSION_PATH,
    });
    registerCleanup(harness.cleanup);

    const extensions = harness.extensionsResult.extensions;
    const supervisorExtension = extensions[0];
    check(
      extensions.length === 1 &&
        supervisorExtension?.resolvedPath === SUPERVISOR_EXTENSION_PATH,
      'loaded exactly the supervisor production dist extension',
    );
    check(
      harness.extensionsResult.errors.length === 0,
      'supervisor extension loading returned no errors',
    );
    check(
      supervisorExtension?.tools.size === 0,
      'supervisor extension registered zero tools',
    );
    check(
      supervisorExtension?.commands.size === 1 &&
        supervisorExtension.commands.has('agent-supervisor'),
      'supervisor extension registered exactly the agent-supervisor command',
    );

    const callsBeforeStatus = harness.faux.state.callCount;
    const notifyCountBeforeStatus = harness.uiMessages.length;
    await harness.session.prompt('/agent-supervisor status');
    const statusMessages = harness.uiMessages.slice(notifyCountBeforeStatus);
    const statusOutput = notifyText(statusMessages);
    check(
      statusOutput.includes('Agent Supervisor'),
      'status command produced captured Supervisor status output',
    );
    check(
      harness.faux.state.callCount === callsBeforeStatus,
      'status command caused zero faux model calls',
    );
    check(
      statusOutput.includes('Requested global mode: autonomous') &&
        statusOutput.includes('Effective global mode: autonomous'),
      'status output shows the autonomous default global mode',
    );
    check(
      statusOutput.includes('Registered features: 2') &&
        statusOutput.includes(`- completion-gate: ${ACTIVE_FEATURE_STATUS}`) &&
        statusOutput.includes(`- retry-loop-breaker: ${ACTIVE_FEATURE_STATUS}`),
      'status output reports both production built-in features active',
    );
    check(
      supervisorConfigEntries(harness.sessionManager).length === 0,
      'loading and status created no agent-supervisor-config session entry',
    );

    const notifyCountAfterStatus = harness.uiMessages.length;
    const callsBeforeNormalRun = harness.faux.state.callCount;
    let normalEvents = [];
    let normalRunCompleted = false;
    try {
      normalEvents = await runScriptedTurn(
        harness,
        'Reply with the scripted completion.',
        [
          fauxAssistantMessage(fauxText('scripted completion')),
          NO_CLAIM_ASSESSMENT_RESPONSE,
        ],
      );
      normalRunCompleted = true;
    } catch {
      normalRunCompleted = false;
    }
    check(
      normalRunCompleted,
      'normal scripted agent prompt completed successfully',
    );
    check(
      harness.uiMessages.length === notifyCountAfterStatus,
      'Supervisor stayed silent during the normal run',
    );
    check(
      harness.faux.state.callCount === callsBeforeNormalRun + 2,
      'normal run consumed one AGENT call and one AUXILIARY ASSESSMENT call',
    );
    check(
      normalEvents.filter((event) => event?.type === 'agent_start').length === 1 &&
        normalEvents.filter((event) => event?.type === 'agent_end').length === 1 &&
        normalEvents.filter((event) => event?.type === 'turn_start').length === 1 &&
        normalEvents.filter((event) => event?.type === 'turn_end').length === 1,
      'normal run had no automatic follow-up turn',
    );
    check(
      harness.faux.getPendingResponseCount() === 0,
      'no unconsumed faux responses remain',
    );
    harness.assertNoAuthCredentials();

    return result.status === 'pass'
      ? { status: 'pass', reason: 'default Supervisor kernel wiring verified' }
      : { status: 'fail', reason: 'default Supervisor kernel assertions failed' };
  } finally {
    await cleanupAll();
  }
}
