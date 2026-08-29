import * as handoffScenario from './scenarios/agent-handoff.mjs';
import * as toolPolicyScenario from './scenarios/agent-tool-policy.mjs';
import { runScenarioList } from './runner.mjs';

const scenarios = [handoffScenario, toolPolicyScenario];

await runScenarioList(scenarios, { label: 'B1', allowSkip: true });
