import * as agentStateScenario from './scenarios/agent-state.mjs';
import * as agentProgressScenario from './scenarios/agent-progress.mjs';
import * as agentRetryGuardScenario from './scenarios/agent-retry-guard.mjs';
import * as agentEvidenceScenario from './scenarios/agent-evidence.mjs';
import * as agentBudgetScenario from './scenarios/agent-budget.mjs';
import { runScenarioList } from './runner.mjs';

const scenarios = [
  agentStateScenario,
  agentProgressScenario,
  agentRetryGuardScenario,
  agentEvidenceScenario,
  agentBudgetScenario,
];

await runScenarioList(scenarios, { label: 'B2a', allowSkip: false });
