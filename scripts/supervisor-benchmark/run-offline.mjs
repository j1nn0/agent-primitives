import * as telemetryTransparencyScenario from './offline/telemetry-transparency.mjs';
import * as metricsScenario from './offline/metrics.mjs';
import * as variantEngineScenario from './offline/variant-engine.mjs';
import * as scenarioOracleScenario from './offline/scenario-oracles.mjs';
import * as planScenario from './offline/plan.mjs';
import { runScenarioList } from '../supervisor-harness/runner.mjs';

await runScenarioList([
  metricsScenario,
  telemetryTransparencyScenario,
  variantEngineScenario,
  scenarioOracleScenario,
  planScenario,
], {
  label: 'BENCHMARK-OFFLINE',
  allowSkip: false,
});
