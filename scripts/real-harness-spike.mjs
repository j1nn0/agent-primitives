/* global console, process, setTimeout, clearTimeout, setImmediate */

// Real-harness feasibility spike (Phase A).
//
// Proves that the real Pi 0.84.2 runtime — real extension loading path, real
// agent loop, real tool execution pipeline, real event dispatch — can drive
// repository adapters deterministically with:
//   - zero provider/network calls (pi-ai "faux" scripted provider, in-process;
//     ModelRuntime created with allowModelNetwork: false; PI_OFFLINE=1)
//   - zero user config/session access (agentDir/cwd/auth/models all pointed at
//     throwaway temp dirs; SessionManager.inMemory(); SettingsManager.inMemory())
//
// This is NOT the FakePiHarness layer: extension code is loaded through the
// real resource loader, tool calls flow through the real agent loop
// (scripted model response -> tool executor -> extension events), and
// assertions run against the real session state the runtime produced.
//
// Temporary Phase-A spike; not wired into CI.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';

process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
process.env.PI_SKIP_VERSION_CHECK = '1';

const repoRoot = resolve(import.meta.dirname, '..');
const handoffExtensionPath = join(repoRoot, 'packages/agent-handoff-pi/dist/extension.js');
const toolPolicyExtensionPath = join(repoRoot, 'packages/agent-tool-policy-pi/dist/extension.js');

for (const extensionPath of [handoffExtensionPath, toolPolicyExtensionPath]) {
  if (!existsSync(extensionPath)) {
    console.error(`real-harness spike requires built adapters; missing ${extensionPath}. Run pnpm build first.`);
    process.exit(1);
  }
}

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function makeIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'real-harness-spike-'));
  return {
    base,
    agentDir: join(base, 'agent'),
    workDir: join(base, 'work'),
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

async function createIsolatedSession(options) {
  const { isolation, additionalExtensionPaths, customTools } = options;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(isolation.workDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(isolation.agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(isolation.agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider();
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd: isolation.workDir,
    agentDir: isolation.agentDir,
    settingsManager,
    additionalExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: isolation.workDir,
    agentDir: isolation.agentDir,
    modelRuntime,
    model: faux.getModel(),
    settingsManager,
    sessionManager,
    resourceLoader,
    noTools: 'builtin',
    customTools,
  });
  const loadErrors = extensionsResult?.errors ?? [];
  if (loadErrors.length > 0) {
    throw new Error(`extension load failed: ${JSON.stringify(loadErrors)}`);
  }

  const events = [];
  session.subscribe((event) => {
    events.push(JSON.stringify(event));
  });
  const armAgentEndWaiter = () =>
    new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('agent_end not observed within 30s')), 30000);
      const unsubscribe = session.subscribe((event) => {
        if (event !== null && typeof event === 'object' && event.type === 'agent_end') {
          clearTimeout(timer);
          unsubscribe();
          resolvePromise();
        }
      });
    });
  return { faux, session, sessionManager, events, extensionsResult, armAgentEndWaiter };
}

async function scenarioHandoff() {
  console.log('scenario: agent-handoff-pi through the real runtime');
  const isolation = makeIsolation();
  try {
    const { faux, session, sessionManager, events, extensionsResult, armAgentEndWaiter } =
      await createIsolatedSession({ isolation, additionalExtensionPaths: [handoffExtensionPath] });

    check(extensionsResult !== undefined, 'extensions result present');
    const loadedExtensions = JSON.stringify(extensionsResult);
    check(
      loadedExtensions.includes('agent-handoff-pi'),
      'real resource loader loaded the handoff adapter extension file',
    );
    check(session.sessionFile === undefined, 'session is in-memory (no session file)');

    faux.setResponses([
      fauxAssistantMessage([
        fauxText('Creating the requested handoff packet.'),
        fauxToolCall('agent_handoff_create', {
          schemaVersion: 1,
          id: 'spike-packet-1',
          source: 'orchestrator-spike',
          goal: 'Prove real-harness adapter execution.',
        }),
      ]),
      fauxAssistantMessage(fauxText('Handoff packet created.')),
    ]);

    const turnFinished = armAgentEndWaiter();
    await session.prompt('Please create a handoff packet for the spike.');
    await turnFinished;

    const branch = JSON.stringify(sessionManager.getBranch());
    check(
      branch.includes('agent-handoff-state'),
      'adapter persisted its state through the real runtime appendEntry path',
    );
    check(branch.includes('spike-packet-1'), 'created packet content reached real session state');
    check(
      events.some((event) => event.includes('agent_handoff_create')),
      'real event stream observed the adapter tool call',
    );

    session.dispose();
  } finally {
    isolation.cleanup();
  }
}

async function scenarioToolPolicy() {
  console.log('scenario: agent-tool-policy-pi through the real runtime');

  const echoCalls = [];
  const echoTool = {
    name: 'spike_echo',
    label: 'Spike Echo',
    description: 'Deterministic spike tool used to observe policy interception.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      echoCalls.push(true);
      return { content: [{ type: 'text', text: 'echo-ok' }] };
    },
  };

  const policies = {
    unconfigured: null,
    enforcingAllow: { default: 'allow', allow: [], deny: [], requiresApproval: [] },
    enforcingDeny: { default: 'allow', allow: [], deny: ['spike_echo'], requiresApproval: [] },
    approvalNoUi: { default: 'allow', allow: [], deny: [], requiresApproval: ['spike_echo'] },
  };

  const expectations = {
    unconfigured: {
      executed: false,
      reason: 'no policy configured; tool call blocked',
      label: 'unconfigured state blocks tool calls (fail-closed)',
    },
    enforcingAllow: {
      executed: true,
      reason: null,
      label: 'enforcing allow policy executes the tool through the real runtime',
    },
    enforcingDeny: {
      executed: false,
      reason: 'tool call denied by tool policy',
      label: 'enforcing deny policy blocks through the real interception path',
    },
    approvalNoUi: {
      executed: false,
      reason: 'requires approval, but no UI available',
      label: 'approval requirement fails closed in a headless session (hasUI=false)',
    },
  };

  for (const [name, policy] of Object.entries(policies)) {
    console.log(`  case: ${name}`);
    const isolation = makeIsolation();
    try {
      const { faux, session, sessionManager, events, armAgentEndWaiter } = await createIsolatedSession({
        isolation,
        additionalExtensionPaths: [toolPolicyExtensionPath],
        customTools: [echoTool],
      });
      echoCalls.length = 0;

      if (policy !== null) {
        // Configure through the adapter's real command dispatch path.
        await session.prompt(`/agent-tool-policy set ${JSON.stringify(policy)}`);
        await new Promise((resolveTick) => setImmediate(resolveTick));
      }

      const turnFinished = armAgentEndWaiter();
      faux.setResponses([
        fauxAssistantMessage([fauxText('Trying the tool.'), fauxToolCall('spike_echo', {})]),
        fauxAssistantMessage(fauxText('done')),
      ]);
      await session.prompt('Please run the spike echo tool.');
      await turnFinished;

      if (expectations[name].executed) {
        check(echoCalls.length === 1, 'tool executed through the real runtime');
      } else {
        check(echoCalls.length === 0, 'tool execution stayed blocked');
        const allJson = `${JSON.stringify(sessionManager.getBranch())}\n${events.join('\n')}`;
        check(allJson.includes(expectations[name].reason), `block reason surfaced: ${expectations[name].reason}`);
        if (process.env.SPIKE_DEBUG && !allJson.includes(expectations[name].reason)) {
          const branchText = JSON.stringify(sessionManager.getBranch());
          console.error(`    [debug ${name}] policy-mentions:`, branchText.split('Agent Tool Policy: ').slice(1).map((piece) => piece.slice(0, 90)));
          console.error(`    [debug ${name}] event-types:`, events.map((e) => JSON.parse(e).type).join(','));
        }
      }
      check(session.sessionFile === undefined, 'session stayed in-memory');

      session.dispose();
    } finally {
      isolation.cleanup();
    }
  }
}

try {
  await scenarioHandoff();
  await scenarioToolPolicy();
  if (failures > 0) {
    console.error(`REAL-HARNESS SPIKE FAILED: ${failures} check(s)`);
    process.exitCode = 1;
  } else {
    console.log('REAL-HARNESS SPIKE PASSED: real Pi runtime drove repository adapters end to end.');
  }
} catch (error) {
  console.error('REAL-HARNESS SPIKE ERRORED:', error);
  process.exitCode = 1;
}
