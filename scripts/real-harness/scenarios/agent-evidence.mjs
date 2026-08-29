import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AGENT_EVIDENCE_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-evidence-state';
const CLAIM_ID = 'b2a-evidence-claim';
const EVIDENCE_ID = 'b2a-evidence-record';
const SUBJECT = 'real-runtime';

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

function parseEvidenceVerdict(message) {
  if (message === undefined || message.isError !== false) {
    return undefined;
  }
  const text = messageText(message);
  const jsonLine = text.split('\n').at(-1);
  if (jsonLine === undefined) {
    return undefined;
  }
  try {
    return { ...JSON.parse(jsonLine), text };
  } catch {
    return undefined;
  }
}

export const name = 'agent-evidence-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_EVIDENCE_EXTENSION_PATH],
      expectedExtensionPath: AGENT_EVIDENCE_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());
    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          AGENT_EVIDENCE_EXTENSION_PATH,
      'loader contract passed for the agent-evidence adapter',
    );
    check(
      harness.session.sessionFile === undefined,
      'agent-evidence session is in-memory',
    );

    const claimEvents = await runScriptedTurn(
      harness,
      'Record the claim and its required evidence.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_evidence_add_claim', {
            id: CLAIM_ID,
            requires: [{ evidenceId: EVIDENCE_ID, subject: SUBJECT }],
          }),
        ),
        fauxAssistantMessage(fauxText('The evidence claim was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      claimEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_evidence_add_claim',
      ),
      'S1 captured the real agent_evidence_add_claim tool event',
    );
    const claimEnvelope = latestStateEnvelope(harness.sessionManager);
    const claim = Array.isArray(claimEnvelope?.claims)
      ? claimEnvelope.claims.find((candidate) => candidate?.id === CLAIM_ID)
      : undefined;
    check(
      claimEnvelope?.schemaVersion === 1 &&
        claim?.id === CLAIM_ID &&
        claim.requires?.length === 1 &&
        claim.requires[0]?.evidenceId === EVIDENCE_ID &&
        claim.requires[0]?.subject === SUBJECT &&
        claimEnvelope.evidence?.length === 0,
      'S1 persisted the structured claim relationship',
    );

    await runScriptedTurn(
      harness,
      'Record the confirming evidence.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_evidence_add_evidence', {
            id: EVIDENCE_ID,
            outcome: 'confirmed',
            subject: SUBJECT,
          }),
        ),
        fauxAssistantMessage(fauxText('The confirming evidence was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const evidenceEnvelope = latestStateEnvelope(harness.sessionManager);
    const evidence = Array.isArray(evidenceEnvelope?.evidence)
      ? evidenceEnvelope.evidence.find((candidate) => candidate?.id === EVIDENCE_ID)
      : undefined;
    check(
      evidenceEnvelope?.schemaVersion === 1 &&
        evidence?.id === EVIDENCE_ID &&
        evidence.outcome === 'confirmed' &&
        evidence.subject === SUBJECT,
      'S1 persisted the linked confirming evidence',
    );

    const judgeEvents = await runScriptedTurn(
      harness,
      'Judge the recorded claim against its evidence.',
      [
        fauxAssistantMessage(fauxToolCall('agent_evidence_judge', {})),
        fauxAssistantMessage(fauxText('The evidence judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      judgeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_evidence_judge',
      ),
      'S1 captured the real agent_evidence_judge tool event',
    );
    const judge = parseEvidenceVerdict(
      latestToolResult(harness.session, 'agent_evidence_judge'),
    );
    check(
      judge?.claims?.length === 1 &&
        judge.claims[0]?.claimId === CLAIM_ID &&
        judge.claims[0]?.outcome === 'supported',
      'S1 surfaced the supported claim relationship through the real tool result',
    );

    const getEvents = await runScriptedTurn(
      harness,
      'Read the current evidence state.',
      [
        fauxAssistantMessage(fauxToolCall('agent_evidence_get', {})),
        fauxAssistantMessage(fauxText('The evidence state was read.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      getEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_evidence_get',
      ),
      'S2 captured the real agent_evidence_get tool event',
    );
    const getResult = latestToolResult(harness.session, 'agent_evidence_get');
    const getText = getResult === undefined ? '' : messageText(getResult);
    check(
      getResult !== undefined &&
        getResult.isError === false &&
        getText.includes(CLAIM_ID) &&
        getText.includes(EVIDENCE_ID) &&
        getText.includes('outcome=confirmed') &&
        getText.includes(`subject=${SUBJECT}`),
      'S2 get returned the structured claim and evidence state',
    );

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    harness.assertFauxNetworkIdentity();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'agent-evidence wiring verified' }
      : { status: 'fail', reason: 'agent-evidence assertions failed' };
  } finally {
    await cleanupAll();
  }
}
