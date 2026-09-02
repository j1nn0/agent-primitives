import * as kernelDefaultScenario from './scenarios/kernel-default.mjs';
import * as kernelRuntimeProbeScenario from './scenarios/kernel-runtime-probe.mjs';
import * as rootRequestLifecycleScenario from './scenarios/root-request-lifecycle.mjs';
import * as fileBackedResumeScenario from './scenarios/file-backed-resume.mjs';
import * as factVisibilityScenario from './scenarios/fact-visibility.mjs';
import * as featureFailureIsolationScenario from './scenarios/feature-failure-isolation.mjs';
import * as featureConfigSemanticsScenario from './scenarios/feature-config-semantics.mjs';
import * as modeCommandRuntimeScenario from './scenarios/mode-command-runtime.mjs';
import * as persistenceRecoveryScenario from './scenarios/persistence-recovery.mjs';
import * as retryLoopBreakerScenario from './scenarios/retry-loop-breaker.mjs';
import * as retryLoopBreakerCoexistenceScenario from './scenarios/retry-loop-breaker-coexistence.mjs';
import * as rootReservationOrderingScenario from './scenarios/root-reservation-ordering.mjs';
import * as assessmentFoundationScenario from './scenarios/assessment-foundation.mjs';
import { runScenarioList } from './runner.mjs';

const scenarios = [
  kernelDefaultScenario,
  kernelRuntimeProbeScenario,
  rootRequestLifecycleScenario,
  fileBackedResumeScenario,
  factVisibilityScenario,
  featureFailureIsolationScenario,
  featureConfigSemanticsScenario,
  modeCommandRuntimeScenario,
  persistenceRecoveryScenario,
  retryLoopBreakerScenario,
  retryLoopBreakerCoexistenceScenario,
  assessmentFoundationScenario,
  rootReservationOrderingScenario,
];

await runScenarioList(scenarios, {
  label: 'FULL',
  allowSkip: false,
});
