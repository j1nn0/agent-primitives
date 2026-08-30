/* global setImmediate */

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  ALL_ADAPTER_EXTENSION_PATHS,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const CUSTOM_TOOL_NAME = 'multi_extension_echo';
const CONTEXT_ITEM_ID = 'coexistence-context';
const CONTEXT_ITEM_CONTENT = 'Preserve every adapter state independently.';
const WORK_ITEM_ID = 'coexistence-work';
const MILESTONE_ID = 'coexistence-milestone';
const RETRY_STRATEGY_ID = 'coexistence-strategy';
const EVIDENCE_ID = 'coexistence-evidence';
const CLAIM_ID = 'coexistence-claim';
const HANDOFF_ID = 'coexistence-handoff';
const BUDGET_ID = 'coexistence-budget';

const POLICY_DENY = {
  default: 'allow',
  allow: [],
  deny: [CUSTOM_TOOL_NAME],
  requiresApproval: [],
};
const POLICY_ALLOW = {
  default: 'allow',
  allow: [],
  deny: [],
  requiresApproval: [],
};

const STATE_CUSTOM_TYPES = [
  'agent-context-guard-state',
  'agent-state-state',
  'agent-progress-state',
  'agent-retry-state',
  'agent-evidence-state',
  'agent-handoff-state',
  'agent-budget-state',
  'agent-tool-policy-state',
];

function createEchoTool(invocations) {
  return {
    name: CUSTOM_TOOL_NAME,
    label: 'Multi-extension Echo',
    description: 'Deterministic custom tool for the coexistence scenario.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      invocations.push(true);
      return { content: [{ type: 'text', text: 'multi-extension-echo-ok' }] };
    },
  };
}

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager, customType) {
  return stateEntriesFor(sessionManager, customType).at(-1)?.data;
}

async function runCommand(harness, command) {
  await harness.session.prompt(command);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function runToolTurn(harness, toolName, input) {
  return runScriptedTurn(
    harness,
    `Run the ${toolName} coexistence probe.`,
    [
      fauxAssistantMessage(fauxToolCall(toolName, input)),
      fauxAssistantMessage(fauxText(`${toolName} probe complete.`)),
    ],
  );
}

function checkToolExecution(check, events, toolName, label) {
  check(
    events.some(
      (event) =>
        event.type === 'tool_execution_start' && event.toolName === toolName,
    ),
    label,
  );
}

function customTypesFor(sessionManager) {
  const branch = sessionManager.getBranch();
  return new Set(
    branch
      .filter((entry) => entry?.type === 'custom')
      .map((entry) => entry.customType),
  );
}

export const name = 'multi-extension-coexistence';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);
  const invocations = [];

  try {
    const primary = await createIsolatedSession({
      isolation,
      storage: 'file',
      additionalExtensionPaths: ALL_ADAPTER_EXTENSION_PATHS,
      expectedExtensionPaths: ALL_ADAPTER_EXTENSION_PATHS,
      customTools: [createEchoTool(invocations)],
    });
    let primaryDisposed = false;
    const disposePrimary = () => {
      if (!primaryDisposed) {
        primary.session.dispose();
        primaryDisposed = true;
      }
    };
    registerCleanup(disposePrimary);

    const loadedPaths = primary.extensionsResult.extensions.map(
      (extension) => extension.resolvedPath,
    );
    check(
      loadedPaths.length === ALL_ADAPTER_EXTENSION_PATHS.length &&
        new Set(loadedPaths).size === ALL_ADAPTER_EXTENSION_PATHS.length &&
        ALL_ADAPTER_EXTENSION_PATHS.every((path) => loadedPaths.includes(path)),
      'C1 loaded all 8 Pi adapters with the exact extension set',
    );
    check(
      primary.assertSessionStorage(),
      'C1 coexistence probe started file-backed',
    );

    await runCommand(
      primary,
      `/agent-tool-policy set ${JSON.stringify(POLICY_DENY)}`,
    );
    const blockedEvents = await runToolTurn(primary, CUSTOM_TOOL_NAME, {});
    checkToolExecution(
      check,
      blockedEvents,
      CUSTOM_TOOL_NAME,
      'C2 captured the blocked custom-tool execution event',
    );
    const blockedResult = latestToolResult(primary.session, CUSTOM_TOOL_NAME);
    const blockedOutput =
      blockedResult === undefined ? '' : messageText(blockedResult);
    check(
      invocations.length === 0 && blockedResult?.isError === true,
      'C2 policy blocked the custom tool before execution',
    );
    check(
      blockedOutput.includes('tool call denied by tool policy'),
      'C2 surfaced the policy block reason through the real tool result',
    );

    await runCommand(
      primary,
      `/agent-tool-policy set ${JSON.stringify(POLICY_ALLOW)}`,
    );
    const allowedEvents = await runToolTurn(primary, CUSTOM_TOOL_NAME, {});
    checkToolExecution(
      check,
      allowedEvents,
      CUSTOM_TOOL_NAME,
      'C3 captured the allowed custom-tool execution event',
    );
    const allowedResult = latestToolResult(primary.session, CUSTOM_TOOL_NAME);
    check(
      invocations.length === 1 &&
        allowedResult?.isError === false &&
        messageText(allowedResult).includes('multi-extension-echo-ok'),
      'C3 policy allowed the custom tool and the real runtime executed it',
    );

    await runCommand(
      primary,
      `/context-guard add ${CONTEXT_ITEM_ID} constraint --critical ${CONTEXT_ITEM_CONTENT}`,
    );

    const stateEvents = await runToolTurn(
      primary,
      'agent_state_add_work_item',
      {
        id: WORK_ITEM_ID,
        content: 'Verify independent state persistence.',
        status: 'open',
      },
    );
    checkToolExecution(
      check,
      stateEvents,
      'agent_state_add_work_item',
      'C4 agent-state tool executed alongside the other adapters',
    );

    const progressEvents = await runToolTurn(
      primary,
      'agent_progress_add_milestone',
      { milestone: MILESTONE_ID },
    );
    checkToolExecution(
      check,
      progressEvents,
      'agent_progress_add_milestone',
      'C4 agent-progress tool executed alongside the other adapters',
    );

    const retryPolicyEvents = await runToolTurn(
      primary,
      'agent_retry_set_policy',
      { maxAttempts: 3, maxStrategyAttempts: 2 },
    );
    checkToolExecution(
      check,
      retryPolicyEvents,
      'agent_retry_set_policy',
      'C4 agent-retry policy tool executed alongside the other adapters',
    );
    const retryAttemptEvents = await runToolTurn(
      primary,
      'agent_retry_add_attempt',
      { outcome: 'failure', strategyId: RETRY_STRATEGY_ID },
    );
    checkToolExecution(
      check,
      retryAttemptEvents,
      'agent_retry_add_attempt',
      'C4 agent-retry attempt tool executed alongside the other adapters',
    );

    const evidenceEvents = await runToolTurn(
      primary,
      'agent_evidence_add_evidence',
      { id: EVIDENCE_ID, outcome: 'confirmed', subject: 'coexistence' },
    );
    checkToolExecution(
      check,
      evidenceEvents,
      'agent_evidence_add_evidence',
      'C4 agent-evidence tool executed alongside the other adapters',
    );
    const claimEvents = await runToolTurn(primary, 'agent_evidence_add_claim', {
      id: CLAIM_ID,
      requires: [{ evidenceId: EVIDENCE_ID, subject: 'coexistence' }],
    });
    checkToolExecution(
      check,
      claimEvents,
      'agent_evidence_add_claim',
      'C4 agent-evidence claim tool executed alongside the other adapters',
    );

    const handoffEvents = await runToolTurn(primary, 'agent_handoff_create', {
      schemaVersion: 1,
      id: HANDOFF_ID,
      source: 'multi-extension-coexistence',
      goal: 'Resume all independent adapter state safely.',
    });
    checkToolExecution(
      check,
      handoffEvents,
      'agent_handoff_create',
      'C4 agent-handoff tool executed alongside the other adapters',
    );

    const budgetEvents = await runToolTurn(primary, 'agent_budget_set', {
      id: BUDGET_ID,
      consumed: 1,
      limit: 2,
    });
    checkToolExecution(
      check,
      budgetEvents,
      'agent_budget_set',
      'C4 agent-budget tool executed alongside the other adapters',
    );

    primary.assertNoPendingFauxResponses();
    primary.assertFauxNetworkIdentity();

    const primaryCustomTypes = customTypesFor(primary.sessionManager);
    check(
      primaryCustomTypes.size === STATE_CUSTOM_TYPES.length &&
        STATE_CUSTOM_TYPES.every((customType) => primaryCustomTypes.has(customType)),
      'P1 persisted all 8 adapter states under distinct custom-entry types',
    );

    const contextState = latestStateEnvelope(
      primary.sessionManager,
      'agent-context-guard-state',
    );
    check(
      contextState?.schemaVersion === 5 &&
        contextState.items?.some(
          (item) =>
            item?.id === CONTEXT_ITEM_ID &&
            item.content === CONTEXT_ITEM_CONTENT &&
            item.critical === true,
        ),
      'P2 Context Guard state persisted independently',
    );

    const agentState = latestStateEnvelope(
      primary.sessionManager,
      'agent-state-state',
    );
    check(
      agentState?.schemaVersion === 1 &&
        agentState.state?.workItems?.some(
          (item) =>
            item?.id === WORK_ITEM_ID &&
            item.content === 'Verify independent state persistence.' &&
            item.status === 'open',
        ),
      'P2 Agent State state persisted independently',
    );

    const progressState = latestStateEnvelope(
      primary.sessionManager,
      'agent-progress-state',
    );
    check(
      progressState?.schemaVersion === 1 &&
        progressState.currentMilestones?.includes(MILESTONE_ID),
      'P2 Agent Progress state persisted independently',
    );

    const retryState = latestStateEnvelope(
      primary.sessionManager,
      'agent-retry-state',
    );
    check(
      retryState?.schemaVersion === 1 &&
        retryState.attempts?.some(
          (attempt) =>
            attempt?.outcome === 'failure' &&
            attempt.strategyId === RETRY_STRATEGY_ID,
        ) &&
        retryState.policy?.maxAttempts === 3 &&
        retryState.policy?.maxStrategyAttempts === 2,
      'P2 Agent Retry Guard state persisted independently',
    );

    const evidenceState = latestStateEnvelope(
      primary.sessionManager,
      'agent-evidence-state',
    );
    check(
      evidenceState?.schemaVersion === 1 &&
        evidenceState.evidence?.some(
          (record) =>
            record?.id === EVIDENCE_ID &&
            record.outcome === 'confirmed' &&
            record.subject === 'coexistence',
        ) &&
        evidenceState.claims?.some(
          (claim) =>
            claim?.id === CLAIM_ID &&
            claim.requires?.some(
              (requirement) =>
                requirement.evidenceId === EVIDENCE_ID &&
                requirement.subject === 'coexistence',
            ),
        ),
      'P2 Agent Evidence state persisted independently',
    );

    const handoffState = latestStateEnvelope(
      primary.sessionManager,
      'agent-handoff-state',
    );
    check(
      handoffState?.schemaVersion === 1 &&
        handoffState.packets?.some(
          (packet) =>
            packet?.id === HANDOFF_ID &&
            packet.source === 'multi-extension-coexistence',
        ),
      'P2 Agent Handoff state persisted independently',
    );

    const budgetState = latestStateEnvelope(
      primary.sessionManager,
      'agent-budget-state',
    );
    check(
      budgetState?.schemaVersion === 1 &&
        budgetState.budgets?.some(
          (budget) =>
            budget?.id === BUDGET_ID &&
            budget.consumed === 1 &&
            budget.limit === 2,
        ),
      'P2 Agent Budget state persisted independently',
    );

    const policyState = latestStateEnvelope(
      primary.sessionManager,
      'agent-tool-policy-state',
    );
    check(
      policyState?.schemaVersion === 1 &&
        JSON.stringify(policyState.policy) === JSON.stringify(POLICY_ALLOW),
      'P2 Agent Tool Policy state persisted independently',
    );

    const sessionFile = primary.sessionFile;
    check(
      primary.assertSessionStorage() && typeof sessionFile === 'string',
      'R1 Session A is file-backed after the coexistence turns',
    );
    if (result.status === 'fail' || typeof sessionFile !== 'string') {
      return { status: 'fail', reason: 'coexistence persistence assertions failed' };
    }

    disposePrimary();
    const resumeManager = SessionManager.open(sessionFile);
    const resumed = await createIsolatedSession({
      isolation,
      storage: 'file',
      sessionManager: resumeManager,
      additionalExtensionPaths: ALL_ADAPTER_EXTENSION_PATHS,
      expectedExtensionPaths: ALL_ADAPTER_EXTENSION_PATHS,
      customTools: [createEchoTool(invocations)],
    });
    registerCleanup(() => resumed.session.dispose());

    const resumedPaths = resumed.extensionsResult.extensions.map(
      (extension) => extension.resolvedPath,
    );
    check(
      resumed.sessionFile === sessionFile &&
        resumedPaths.length === ALL_ADAPTER_EXTENSION_PATHS.length &&
        new Set(resumedPaths).size === ALL_ADAPTER_EXTENSION_PATHS.length &&
        ALL_ADAPTER_EXTENSION_PATHS.every((path) => resumedPaths.includes(path)),
      'R1 Session B reopened the file with all 8 adapters',
    );

    const resumedCustomTypes = customTypesFor(resumed.sessionManager);
    check(
      resumedCustomTypes.size === STATE_CUSTOM_TYPES.length &&
        STATE_CUSTOM_TYPES.every((customType) => resumedCustomTypes.has(customType)),
      'R2 Session B retained every independent adapter state entry',
    );

    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-context-guard-state')?.items?.some(
        (item) => item?.id === CONTEXT_ITEM_ID,
      ),
      'R2 Session B restored Context Guard state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-state-state')?.state?.workItems?.some(
        (item) => item?.id === WORK_ITEM_ID,
      ),
      'R2 Session B restored Agent State state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-progress-state')?.currentMilestones?.includes(
        MILESTONE_ID,
      ),
      'R2 Session B restored Agent Progress state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-retry-state')?.attempts?.some(
        (attempt) => attempt?.strategyId === RETRY_STRATEGY_ID,
      ),
      'R2 Session B restored Agent Retry Guard state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-evidence-state')?.claims?.some(
        (claim) => claim?.id === CLAIM_ID,
      ),
      'R2 Session B restored Agent Evidence state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-handoff-state')?.packets?.some(
        (packet) => packet?.id === HANDOFF_ID,
      ),
      'R2 Session B restored Agent Handoff state',
    );
    check(
      latestStateEnvelope(resumed.sessionManager, 'agent-budget-state')?.budgets?.some(
        (budget) => budget?.id === BUDGET_ID,
      ),
      'R2 Session B restored Agent Budget state',
    );
    check(
      JSON.stringify(
        latestStateEnvelope(resumed.sessionManager, 'agent-tool-policy-state')?.policy,
      ) === JSON.stringify(POLICY_ALLOW),
      'R2 Session B restored Agent Tool Policy state',
    );

    const resumedEchoEvents = await runToolTurn(
      resumed,
      CUSTOM_TOOL_NAME,
      {},
    );
    checkToolExecution(
      check,
      resumedEchoEvents,
      CUSTOM_TOOL_NAME,
      'R3 resumed policy and custom-tool registration allowed execution',
    );
    check(
      invocations.length === 2 &&
        latestToolResult(resumed.session, CUSTOM_TOOL_NAME)?.isError === false,
      'R3 resumed Session B executed the custom tool',
    );

    const resumedReadEvents = await runScriptedTurn(
      resumed,
      'Read every restored adapter state.',
      [
        fauxAssistantMessage([
          fauxToolCall('agent_state_get', {}),
          fauxToolCall('agent_progress_get', {}),
          fauxToolCall('agent_retry_get', {}),
          fauxToolCall('agent_evidence_get', {}),
          fauxToolCall('agent_handoff_get', {}),
          fauxToolCall('agent_budget_get', {}),
        ]),
        fauxAssistantMessage(fauxText('Every restored adapter state was read.')),
      ],
    );
    for (const toolName of [
      'agent_state_get',
      'agent_progress_get',
      'agent_retry_get',
      'agent_evidence_get',
      'agent_handoff_get',
      'agent_budget_get',
    ]) {
      checkToolExecution(
        check,
        resumedReadEvents,
        toolName,
        `R3 resumed ${toolName} through the shared runtime`,
      );
    }
    const resumedReadMarkers = [
      ['agent_state_get', WORK_ITEM_ID],
      ['agent_progress_get', MILESTONE_ID],
      ['agent_retry_get', RETRY_STRATEGY_ID],
      ['agent_evidence_get', EVIDENCE_ID],
      ['agent_handoff_get', HANDOFF_ID],
      ['agent_budget_get', BUDGET_ID],
    ];
    for (const [toolName, marker] of resumedReadMarkers) {
      const toolResult = latestToolResult(resumed.session, toolName);
      check(
        toolResult?.isError === false && messageText(toolResult).includes(marker),
        `R3 ${toolName} returned its restored state`,
      );
    }
    resumed.assertNoPendingFauxResponses();
    resumed.assertFauxNetworkIdentity();

    return result.status === 'pass'
      ? { status: 'pass', reason: 'all 8 Pi adapters coexisted and resumed independently' }
      : { status: 'fail', reason: 'coexistence assertions failed' };
  } finally {
    await cleanupAll();
  }
}
