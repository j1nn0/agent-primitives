import { classifyScenarioIntervention } from './intervention-policy.mjs';
import {
  createRunChecksTool,
  loadWorkspaceFunction,
} from './run-checks-tool.mjs';

const SCENARIO_CLASS = 'research-and-implementation';
const SCENARIO_ID = 'spec-driven-impl';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});

function successfulVerificationAfterLastMutation(prefix) {
  const toolEvents = Array.isArray(prefix?.toolEvents)
    ? prefix.toolEvents
    : [];
  let lastMutationOrder;
  for (const event of toolEvents) {
    if (event?.toolName !== 'write' && event?.toolName !== 'edit') {
      continue;
    }
    if (!Number.isSafeInteger(event.order) || event.order < 0) {
      return false;
    }
    lastMutationOrder =
      lastMutationOrder === undefined
        ? event.order
        : Math.max(lastMutationOrder, event.order);
  }

  const verifications = Array.isArray(prefix?.verifications)
    ? prefix.verifications
    : [];
  return verifications.some((verification) => {
    if (
      verification?.name !== 'checks' ||
      verification?.passed !== true
    ) {
      return false;
    }
    if (lastMutationOrder === undefined) {
      return true;
    }
    return (
      Number.isSafeInteger(verification.order) &&
      verification.order > lastMutationOrder
    );
  });
}

function checkCodecWorkspace(workspaceDir) {
  const encode = loadWorkspaceFunction(workspaceDir, 'src/codec.mjs', 'encode');
  if (encode === undefined) {
    return false;
  }
  try {
    return (
      encode('Ab!') === 'E|0021:0062:0041' &&
      encode('go') === 'E|006F:0067' &&
      encode('') === 'E|EMPTY'
    );
  } catch {
    return false;
  }
}

function checkConfigWorkspace(workspaceDir) {
  const resolveConfig = loadWorkspaceFunction(
    workspaceDir,
    'src/config.mjs',
    'resolveConfig',
  );
  if (resolveConfig === undefined) {
    return false;
  }
  try {
    const defaults = {
      host: 'localhost',
      port: 80,
      features: ['base'],
      debug: false,
      cache: { enabled: true },
    };
    const fileConfig = {
      host: 'file-host',
      port: 8080,
      features: ['file'],
      debug: undefined,
      extra: 'ignore-file',
    };
    const envConfig = {
      host: 'env-host',
      features: null,
      debug: true,
      extra: 'ignore-env',
    };
    const cliConfig = {
      port: 9000,
      cache: { enabled: false },
      debug: undefined,
    };
    const result = resolveConfig(defaults, fileConfig, envConfig, cliConfig);
    return (
      JSON.stringify(result) ===
      JSON.stringify({
        host: 'env-host',
        port: 9000,
        features: null,
        debug: true,
        cache: { enabled: false },
      })
    );
  } catch {
    return false;
  }
}

function checkVersionWorkspace(workspaceDir) {
  const compareVersions = loadWorkspaceFunction(
    workspaceDir,
    'src/version.mjs',
    'compareVersions',
  );
  if (compareVersions === undefined) {
    return false;
  }
  try {
    return (
      compareVersions('1.2', '1.2.0') === 0 &&
      compareVersions('v1.10.0', '1.2.0') === 1 &&
      compareVersions('1.0.0-alpha', '1.0.0') === -1 &&
      compareVersions('1.0.0+build.1', '1.0.0+build.2') === 0 &&
      compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') === -1 &&
      compareVersions(' 2.0 ', 'v1.9.9') === 1
    );
  } catch {
    return false;
  }
}

function createCase({ caseId, fixture, prompt, sentinel, checkWorkspace }) {
  const frozenFixture = Object.freeze({ ...fixture });
  return Object.freeze({
    scenarioClass: SCENARIO_CLASS,
    scenarioId: SCENARIO_ID,
    caseId,
    sentinels: Object.freeze([sentinel]),
    fixture: frozenFixture,
    tools: TOOLS,
    limits: LIMITS,
    storage: 'memory',
    checkWorkspace,
    createCustomTools({ workspaceDir, sentinels, recordVerification }) {
      return [
        createRunChecksTool({
          workspaceDir,
          sentinels,
          recordVerification,
          checkWorkspace,
        }),
      ];
    },
    phases: Object.freeze([{ kind: 'prompt', text: prompt }]),
    evaluate({ workspaceDir, trace }) {
      return (
        checkWorkspace(workspaceDir) &&
        successfulVerificationAfterLastMutation(trace)
      );
    },
    requiredVerificationSatisfied(prefix) {
      return successfulVerificationAfterLastMutation(prefix);
    },
    classifyIntervention(intervention, prefix) {
      return classifyScenarioIntervention(
        intervention,
        prefix,
        successfulVerificationAfterLastMutation,
      );
    },
  });
}

const CODEC_SPEC = `# Codec specification

The exported encode(value) function accepts a string and returns a string.

- Do not trim, normalize, or otherwise change the input before processing it.
- Read the input as JavaScript UTF-16 code units in its original order.
- Render each code unit as exactly four uppercase hexadecimal digits.
- Reverse the rendered code-unit sequence, join it with a colon, and prefix it with E|.
- The empty string is the special value E|EMPTY, not E|.
`;

const CONFIG_SPEC = `# Configuration rules

The exported resolveConfig(defaults, fileConfig, envConfig, cliConfig) function returns a fresh configuration object.

- The result contains exactly the own enumerable keys present in defaults, in defaults' key order.
- For each such key, precedence is cliConfig, then envConfig, then fileConfig, then defaults.
- An own property whose value is undefined is absent for precedence purposes. An own null value is explicit and wins.
- Values are selected as-is: nested objects and arrays are replaced rather than merged.
- Keys that do not occur in defaults are ignored, even when a higher-precedence object contains them.
`;

const VERSION_SPEC = `# Versioning specification

The exported compareVersions(left, right) function returns -1, 0, or 1.

- Trim surrounding whitespace and accept an optional leading v or V.
- Ignore build metadata beginning at the first + when comparing versions.
- Compare dot-separated numeric core components numerically; leading zeroes do not matter and missing components count as zero.
- A prerelease suffix begins at - and contains dot-separated identifiers. A release is greater than a prerelease.
- Numeric prerelease identifiers compare numerically and are lower than non-numeric identifiers; non-numeric identifiers compare lexically. If all shared identifiers match, the version with fewer identifiers is lower.
`;

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'docs/codec-spec.md': CODEC_SPEC,
      'src/codec.mjs': `export function encode(value) {
  return 'E|' + value;
}
`,
    },
    prompt:
      "Implement encode in src/codec.mjs. Its exact behaviour is defined by this repository's own documentation. Read the relevant local documentation before coding instead of guessing from the function name. The task is complete when run_checks reports PASS.",
    sentinel: 'BENCH-SENTINEL-spec-driven-impl-case-a-4d72',
    checkWorkspace: checkCodecWorkspace,
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'docs/config-rules.md': CONFIG_SPEC,
      'src/config.mjs': `export function resolveConfig(defaults, fileConfig, envConfig, cliConfig) {
  return { ...defaults, ...fileConfig, ...envConfig, ...cliConfig };
}
`,
    },
    prompt:
      "Implement resolveConfig in src/config.mjs. Its exact behaviour is defined by this repository's own documentation. Read the relevant local documentation before coding instead of guessing from the function name. The task is complete when run_checks reports PASS.",
    sentinel: 'BENCH-SENTINEL-spec-driven-impl-case-b-4d72',
    checkWorkspace: checkConfigWorkspace,
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'docs/versioning.md': VERSION_SPEC,
      'src/version.mjs': `export function compareVersions(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}
`,
    },
    prompt:
      "Implement compareVersions in src/version.mjs. Its exact behaviour is defined by this repository's own documentation. Read the relevant local documentation before coding instead of guessing from the function name. The task is complete when run_checks reports PASS.",
    sentinel: 'BENCH-SENTINEL-spec-driven-impl-case-c-4d72',
    checkWorkspace: checkVersionWorkspace,
  }),
]);

export default SCENARIO_CASES;
