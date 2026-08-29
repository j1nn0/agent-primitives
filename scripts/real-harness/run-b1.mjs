/* global console, process, setTimeout, clearTimeout */

import * as handoffScenario from './scenarios/agent-handoff.mjs';
import * as toolPolicyScenario from './scenarios/agent-tool-policy.mjs';
import { assertAllDistFresh } from './runner.mjs';

const SCENARIO_TIMEOUT_MS = 60000;
const scenarios = [handoffScenario, toolPolicyScenario];

async function runWithTimeout(scenario) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `scenario ${scenario.name} timed out after ${SCENARIO_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, SCENARIO_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scenario.run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'unknown error';
}

async function main() {
  try {
    assertAllDistFresh();
  } catch (error) {
    console.error(`REAL-HARNESS B1 cannot run: ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    let result;
    try {
      result = await runWithTimeout(scenario);
      if (
        result === undefined ||
        !['pass', 'fail', 'skip'].includes(result.status)
      ) {
        throw new Error('scenario returned an invalid result');
      }
    } catch (error) {
      result = { status: 'fail', reason: errorMessage(error) };
    }

    if (result.status === 'pass') {
      passed += 1;
    } else if (result.status === 'fail') {
      failed += 1;
    } else {
      skipped += 1;
    }

    const reason = result.reason === undefined ? '' : ` — ${result.reason}`;
    console.log(`scenario ${scenario.name}: ${result.status}${reason}`);
  }

  console.log(
    `REAL-HARNESS B1 SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  if (failed !== 0) {
    process.exitCode = 1;
  }
}

await main();
