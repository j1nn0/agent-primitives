import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AGENT_BUDGET_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-budget-state';
const BUDGET_ID = 'b2a-budget';
const BUDGET_LIMIT = 10;

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

function parseBudgetVerdict(message) {
  if (message === undefined || message.isError !== false) {
    return undefined;
  }
  const text = messageText(message);
  const prefix = `- ${BUDGET_ID}: `;
  const line = text.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    return undefined;
  }
  const match = /^(within_budget|exhausted) \(remaining (-?\d+(?:\.\d+)?)\)$/.exec(
    line.slice(prefix.length),
  );
  return match === null
    ? undefined
    : { outcome: match[1], remaining: Number(match[2]), text };
}

export const name = 'agent-budget-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_BUDGET_EXTENSION_PATH],
      expectedExtensionPath: AGENT_BUDGET_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());
    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          AGENT_BUDGET_EXTENSION_PATH,
      'loader contract passed for the agent-budget adapter',
    );
    check(
      harness.session.sessionFile === undefined,
      'agent-budget session is in-memory',
    );

    const initialSetEvents = await runScriptedTurn(
      harness,
      'Create an in-budget record.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_budget_set', {
            id: BUDGET_ID,
            consumed: 0,
            limit: BUDGET_LIMIT,
          }),
        ),
        fauxAssistantMessage(fauxText('The in-budget record was created.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      initialSetEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_budget_set',
      ),
      'S1 captured the real initial agent_budget_set tool event',
    );
    const initialEnvelope = latestStateEnvelope(harness.sessionManager);
    const initialBudget = Array.isArray(initialEnvelope?.budgets)
      ? initialEnvelope.budgets.find((budget) => budget?.id === BUDGET_ID)
      : undefined;
    check(
      initialEnvelope?.schemaVersion === 1 &&
        initialBudget?.id === BUDGET_ID &&
        initialBudget.consumed === 0 &&
        initialBudget.limit === BUDGET_LIMIT,
      'S1 persisted the initial budget record',
    );

    const firstJudgeEvents = await runScriptedTurn(
      harness,
      'Judge the initial budget.',
      [
        fauxAssistantMessage(fauxToolCall('agent_budget_judge', {})),
        fauxAssistantMessage(fauxText('The initial budget judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      firstJudgeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_budget_judge',
      ),
      'S1 captured the real initial agent_budget_judge tool event',
    );
    const firstVerdict = parseBudgetVerdict(
      latestToolResult(harness.session, 'agent_budget_judge'),
    );
    check(
      firstVerdict?.outcome === 'within_budget' &&
        firstVerdict.remaining === BUDGET_LIMIT,
      'S1 surfaced the in-budget verdict through the real tool result',
    );

    await runScriptedTurn(
      harness,
      'Replace the budget with over-limit consumption.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_budget_set', {
            id: BUDGET_ID,
            consumed: BUDGET_LIMIT + 1,
            limit: BUDGET_LIMIT,
          }),
        ),
        fauxAssistantMessage(fauxText('The over-limit budget was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const overLimitEnvelope = latestStateEnvelope(harness.sessionManager);
    const overLimitBudget = Array.isArray(overLimitEnvelope?.budgets)
      ? overLimitEnvelope.budgets.find((budget) => budget?.id === BUDGET_ID)
      : undefined;
    check(
      overLimitBudget?.id === BUDGET_ID &&
        overLimitBudget.consumed === BUDGET_LIMIT + 1 &&
        overLimitBudget.limit === BUDGET_LIMIT,
      'S1 persisted the over-limit budget replacement',
    );

    await runScriptedTurn(
      harness,
      'Judge the over-limit budget.',
      [
        fauxAssistantMessage(fauxToolCall('agent_budget_judge', {})),
        fauxAssistantMessage(fauxText('The over-limit budget judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const overLimitVerdict = parseBudgetVerdict(
      latestToolResult(harness.session, 'agent_budget_judge'),
    );
    check(
      overLimitVerdict?.outcome === 'exhausted' &&
        overLimitVerdict.remaining === -1,
      'S1 surfaced the exhausted verdict through the real tool result',
    );

    const removeEvents = await runScriptedTurn(
      harness,
      'Remove the budget record.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_budget_remove', { id: BUDGET_ID }),
        ),
        fauxAssistantMessage(fauxText('The budget record was removed.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      removeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_budget_remove',
      ),
      'S2 captured the real agent_budget_remove tool event',
    );
    const removedEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      removedEnvelope?.schemaVersion === 1 &&
        Array.isArray(removedEnvelope.budgets) &&
        removedEnvelope.budgets.length === 0,
      'S2 persisted removal of the budget record',
    );

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    harness.assertFauxNetworkIdentity();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'agent-budget wiring verified' }
      : { status: 'fail', reason: 'agent-budget assertions failed' };
  } finally {
    await cleanupAll();
  }
}
