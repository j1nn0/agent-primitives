import * as contextGuardScenario from './scenarios/context-guard.mjs';
import * as agentStateScenario from './scenarios/agent-state.mjs';
import * as agentProgressScenario from './scenarios/agent-progress.mjs';
import * as agentRetryGuardScenario from './scenarios/agent-retry-guard.mjs';
import * as agentEvidenceScenario from './scenarios/agent-evidence.mjs';
import * as agentHandoffScenario from './scenarios/agent-handoff.mjs';
import * as agentBudgetScenario from './scenarios/agent-budget.mjs';
import * as agentToolPolicyScenario from './scenarios/agent-tool-policy.mjs';
import * as multiExtensionCoexistenceScenario from './scenarios/multi-extension-coexistence.mjs';
import { runScenarioList } from './runner.mjs';

const scenarios = [
  contextGuardScenario,
  agentStateScenario,
  agentProgressScenario,
  agentRetryGuardScenario,
  agentEvidenceScenario,
  agentHandoffScenario,
  agentBudgetScenario,
  agentToolPolicyScenario,
  multiExtensionCoexistenceScenario,
];

await runScenarioList(scenarios, {
  label: 'FULL',
  allowSkip: false,
});
