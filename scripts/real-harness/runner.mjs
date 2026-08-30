/* global console, process, setTimeout, clearTimeout */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';

process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
process.env.PI_SKIP_VERSION_CHECK = '1';

const repoRoot = resolve(import.meta.dirname, '../..');

export const HANDOFF_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-handoff-pi/dist/extension.js',
);
export const TOOL_POLICY_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-tool-policy-pi/dist/extension.js',
);
export const AGENT_STATE_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-state-pi/dist/extension.js',
);
export const AGENT_PROGRESS_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-progress-pi/dist/extension.js',
);
export const AGENT_RETRY_GUARD_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-retry-guard-pi/dist/extension.js',
);
export const AGENT_EVIDENCE_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-evidence-pi/dist/extension.js',
);
export const AGENT_BUDGET_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-budget-pi/dist/extension.js',
);
export const CONTEXT_GUARD_EXTENSION_PATH = join(
  repoRoot,
  'packages/context-guard-pi/dist/extension.js',
);

const adapterDistPaths = [
  {
    name: 'agent-handoff-pi',
    extensionPath: HANDOFF_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-handoff-pi/src'),
  },
  {
    name: 'agent-tool-policy-pi',
    extensionPath: TOOL_POLICY_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-tool-policy-pi/src'),
  },
  {
    name: 'agent-state-pi',
    extensionPath: AGENT_STATE_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-state-pi/src'),
  },
  {
    name: 'agent-progress-pi',
    extensionPath: AGENT_PROGRESS_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-progress-pi/src'),
  },
  {
    name: 'agent-retry-guard-pi',
    extensionPath: AGENT_RETRY_GUARD_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-retry-guard-pi/src'),
  },
  {
    name: 'agent-evidence-pi',
    extensionPath: AGENT_EVIDENCE_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-evidence-pi/src'),
  },
  {
    name: 'agent-budget-pi',
    extensionPath: AGENT_BUDGET_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/agent-budget-pi/src'),
  },
  {
    name: 'context-guard-pi',
    extensionPath: CONTEXT_GUARD_EXTENSION_PATH,
    sourcePath: join(repoRoot, 'packages/context-guard-pi/src'),
  },
];

export const ALL_ADAPTER_EXTENSION_PATHS = adapterDistPaths.map(
  ({ extensionPath }) => extensionPath,
);

function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function assertDistFresh(adapter) {
  if (!existsSync(adapter.extensionPath)) {
    throw new Error(
      `real-harness requires ${adapter.name}/dist/extension.js. Run pnpm build first.`,
    );
  }

  const distMtime = statSync(adapter.extensionPath).mtimeMs;
  const staleSource = collectTypeScriptFiles(adapter.sourcePath).find(
    (sourcePath) => statSync(sourcePath).mtimeMs > distMtime,
  );
  if (staleSource !== undefined) {
    throw new Error('dist is stale; run pnpm build.');
  }
}

export function assertAllDistFresh() {
  for (const adapter of adapterDistPaths) {
    assertDistFresh(adapter);
  }
}

function adapterForExtensionPath(extensionPath) {
  const resolvedPath = resolve(extensionPath);
  const adapter = adapterDistPaths.find(
    (candidate) => candidate.extensionPath === resolvedPath,
  );
  if (adapter === undefined) {
    throw new Error(`unsupported real-harness extension path: ${resolvedPath}`);
  }
  return adapter;
}

export function makeIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'real-harness-b1-'));
  const agentDir = join(base, 'agent');
  const workDir = join(base, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  return {
    base,
    agentDir,
    workDir,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function assertExtensionLoaderContract(extensionsResult, expectedPaths) {
  if (
    extensionsResult === undefined ||
    !Array.isArray(extensionsResult.extensions) ||
    !Array.isArray(extensionsResult.errors)
  ) {
    throw new Error('extension loader contract failed: malformed extensions result');
  }

  if (extensionsResult.errors.length !== 0) {
    throw new Error(
      `extension load failed: ${safeSerialize(extensionsResult.errors)}`,
    );
  }

  const expectedResolvedPaths = expectedPaths.map((path) => resolve(path));
  const expectedPathSet = new Set(expectedResolvedPaths);
  const loadedPaths = extensionsResult.extensions.map(
    (extension) => extension.resolvedPath ?? extension.path ?? '<unknown>',
  );
  const loadedResolvedPaths = extensionsResult.extensions.map((extension) =>
    typeof extension.resolvedPath === 'string'
      ? resolve(extension.resolvedPath)
      : undefined,
  );
  const loadedPathSet = new Set(loadedResolvedPaths);
  const exactPathSet =
    extensionsResult.extensions.length === expectedResolvedPaths.length &&
    expectedPathSet.size === expectedResolvedPaths.length &&
    loadedPathSet.size === loadedResolvedPaths.length &&
    loadedResolvedPaths.every(
      (path) => path !== undefined && expectedPathSet.has(path),
    ) &&
    expectedPathSet.size === loadedPathSet.size;

  if (!exactPathSet) {
    const expectation =
      expectedResolvedPaths.length === 1
        ? `expected exactly one extension resolving to ${expectedResolvedPaths[0]}`
        : `expected ${expectedResolvedPaths.length} extensions resolving to ${safeSerialize(expectedResolvedPaths)}`;
    throw new Error(
      `extension loader contract failed: ${expectation}; loaded ${safeSerialize(loadedPaths)}`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueTypeName(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return typeof value;
  }
  try {
    return value.constructor?.name || 'Object';
  } catch {
    return 'Object';
  }
}

export function safeSerialize(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? `<unserializable: ${valueTypeName(value)}>`
      : serialized;
  } catch {
    return `<unserializable: ${valueTypeName(value)}>`;
  }
}

function sessionMessages(session) {
  const messages = session?.messages;
  if (!Array.isArray(messages)) {
    const shape = typeof messages === 'function' ? 'method' : typeof messages;
    throw new Error(
      `real-harness session.messages contract failed: expected an array property, got ${shape}`,
    );
  }
  if (!messages.every(isRecord)) {
    throw new Error('real-harness session.messages contract failed: message was not an object');
  }
  return messages;
}

export function assistantMessages(session) {
  return sessionMessages(session).filter((message) => message.role === 'assistant');
}

export function toolResultMessages(session) {
  return sessionMessages(session).filter((message) => message.role === 'toolResult');
}

export function messageText(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    throw new Error('real-harness message contract failed: expected content array');
  }
  const textParts = [];
  for (const part of message.content) {
    if (!isRecord(part)) {
      throw new Error('real-harness message contract failed: content part was not an object');
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new Error('real-harness message contract failed: text content was not a string');
      }
      textParts.push(part.text);
    }
  }
  return textParts.join('\n');
}

export function stateEntriesFor(sessionManager, customType) {
  if (typeof sessionManager?.getBranch !== 'function') {
    throw new Error('real-harness SessionManager contract failed: getBranch is not public');
  }
  const branch = sessionManager.getBranch();
  if (!Array.isArray(branch)) {
    throw new Error('real-harness SessionManager contract failed: getBranch did not return an array');
  }
  return branch.filter(
    (entry) =>
      isRecord(entry) && entry.type === 'custom' && entry.customType === customType,
  );
}

export function createCleanupRegistry() {
  const cleanups = [];
  let drainPromise;

  async function drain() {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try {
        await cleanup();
      } catch (error) {
        console.error(`real-harness cleanup failed: ${safeSerialize(error)}`);
      }
    }
  }

  return {
    registerCleanup(cleanup) {
      if (typeof cleanup !== 'function') {
        throw new TypeError('real-harness cleanup must be a function');
      }
      cleanups.push(cleanup);
    },
    cleanupAll() {
      drainPromise = (drainPromise ?? Promise.resolve()).then(drain, drain);
      return drainPromise;
    },
  };
}

function assertAuthStoreHasNoCredentials(authPath) {
  if (!existsSync(authPath)) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    throw new Error('credential-free contract failed: auth store is not valid JSON');
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== 0) {
    throw new Error('credential-free contract failed: auth store contains credentials');
  }
}

export function createCheck() {
  const checks = [];
  const result = { status: 'pass', checks };

  function check(condition, label) {
    const passed = Boolean(condition);
    checks.push({ status: passed ? 'pass' : 'fail', label });
    if (passed) {
      console.log(`  PASS ${label}`);
    } else {
      result.status = 'fail';
      console.error(`  FAIL ${label}`);
    }
    return passed;
  }

  return { check, result };
}

export async function createIsolatedSession({
  isolation,
  storage = 'memory',
  additionalExtensionPaths = [],
  expectedExtensionPath,
  expectedExtensionPaths,
  customTools = [],
  sessionManager: suppliedSessionManager,
  settingsManager: suppliedSettingsManager,
}) {
  if (isolation === undefined) {
    throw new Error('real-harness isolation is required');
  }
  if (storage !== 'memory' && storage !== 'file') {
    throw new Error(`real-harness storage mode is invalid: ${storage}`);
  }
  const expectedPaths =
    expectedExtensionPaths === undefined
      ? typeof expectedExtensionPath === 'string'
        ? [expectedExtensionPath]
        : undefined
      : expectedExtensionPaths;
  if (
    !Array.isArray(expectedPaths) ||
    !expectedPaths.every((path) => typeof path === 'string')
  ) {
    throw new Error('real-harness expectedExtensionPath is required');
  }

  const normalizedExpectedPaths = expectedPaths.map((path) => resolve(path));
  for (const expectedPath of normalizedExpectedPaths) {
    assertDistFresh(adapterForExtensionPath(expectedPath));
  }

  const settingsManager =
    suppliedSettingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
  let sessionManager = suppliedSessionManager;
  if (sessionManager === undefined) {
    if (storage === 'file') {
      const sessionDir = join(isolation.base, 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      sessionManager = SessionManager.create(isolation.workDir, sessionDir);
    } else {
      sessionManager = SessionManager.inMemory(isolation.workDir);
    }
  }
  const authPath = join(isolation.agentDir, 'auth.json');
  const modelRuntime = await ModelRuntime.create({
    authPath,
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
    additionalExtensionPaths: additionalExtensionPaths.map((path) => resolve(path)),
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

  const assertSessionStorage = () => {
    if (storage === 'memory') {
      if (session.sessionFile !== undefined) {
        throw new Error('in-memory session contract failed: session file was created');
      }
      return true;
    }

    if (typeof session.sessionFile !== 'string') {
      throw new Error('file-backed session contract failed: session file was not created');
    }
    if (
      typeof sessionManager.isPersisted !== 'function' ||
      !sessionManager.isPersisted()
    ) {
      throw new Error('file-backed session contract failed: session manager is not persisted');
    }
    const relativeSessionFile = relative(
      resolve(isolation.base),
      resolve(session.sessionFile),
    );
    if (
      relativeSessionFile === '' ||
      relativeSessionFile === '..' ||
      relativeSessionFile.startsWith(`..${sep}`) ||
      isAbsolute(relativeSessionFile)
    ) {
      throw new Error(
        `file-backed session contract failed: session file is outside isolation base (${session.sessionFile})`,
      );
    }
    return true;
  };

  try {
    assertExtensionLoaderContract(extensionsResult, normalizedExpectedPaths);
    assertSessionStorage();
    await session.bindExtensions({});
  } catch (error) {
    session.dispose();
    throw error;
  }

  const sessionFile = session.sessionFile;
  const events = [];
  session.subscribe((event) => {
    events.push(event);
  });

  const armAgentEndWaiter = () =>
    new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback(value);
      };
      const timer = setTimeout(() => {
        finish(rejectPromise, new Error('agent_end not observed within 30s'));
      }, 30000);
      unsubscribe = session.subscribe((event) => {
        if (
          event !== null &&
          typeof event === 'object' &&
          event.type === 'agent_end'
        ) {
          finish(resolvePromise);
        }
      });
    });

  const assertInMemorySession = () => {
    if (session.sessionFile !== undefined) {
      throw new Error('in-memory session contract failed: session file was created');
    }
    return true;
  };

  const assertNoAuthCredentials = () => {
    assertAuthStoreHasNoCredentials(authPath);
    return true;
  };

  const assertFauxNetworkIdentity = (turnStartMessageIndex = 0) => {
    const messages = sessionMessages(session);
    const assistants = assistantMessages(session);
    if (assistants.length === 0) {
      throw new Error('network identity contract failed: no assistant message observed');
    }

    const modelId = faux.getModel().id;
    for (const [index, message] of assistants.entries()) {
      if (message.provider !== 'faux' || message.model !== modelId) {
        throw new Error(
          `network identity contract failed: assistant message ${index} expected provider faux and model ${modelId}; got ${safeSerialize(message)}`,
        );
      }
    }

    const turnAssistants = messages
      .slice(turnStartMessageIndex)
      .filter((message) => message.role === 'assistant');
    if (turnAssistants.length === 0) {
      throw new Error('network identity contract failed: no assistant message observed for turn');
    }
    assertAuthStoreHasNoCredentials(authPath);
    return true;
  };

  const assertNoPendingFauxResponses = () => {
    const pending = faux.getPendingResponseCount();
    if (pending !== 0) {
      throw new Error(`faux provider has ${pending} pending scripted response(s)`);
    }
    return true;
  };

  return {
    faux,
    session,
    sessionManager,
    sessionFile,
    storage,
    events,
    extensionsResult,
    armAgentEndWaiter,
    assertNoPendingFauxResponses,
    assertInMemorySession,
    assertSessionStorage,
    assertFauxNetworkIdentity,
    assertNoAuthCredentials,
    authPath,
  };
}

export async function runScriptedTurn(harness, prompt, responses) {
  const eventStart = harness.events.length;
  const messageStart = sessionMessages(harness.session).length;
  harness.faux.setResponses(responses);
  const turnFinished = harness.armAgentEndWaiter();
  await harness.session.prompt(prompt);
  await turnFinished;
  harness.assertFauxNetworkIdentity(messageStart);
  return harness.events.slice(eventStart);
}

export const SCENARIO_TIMEOUT_MS = 60000;

async function runWithTimeout(scenario, cleanup) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void cleanup.cleanupAll().then(() => {
        reject(
          new Error(
            `scenario ${scenario.name} timed out after ${SCENARIO_TIMEOUT_MS / 1000}s`,
          ),
        );
      });
    }, SCENARIO_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scenario.run(cleanup), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function runScenarioList(
  scenarios,
  { label, allowSkip = true } = {},
) {
  const runLabel = label ?? 'REAL-HARNESS';
  const labelPrefix = label === undefined ? 'REAL-HARNESS' : `REAL-HARNESS ${runLabel}`;
  try {
    assertAllDistFresh();
  } catch (error) {
    console.error(`${labelPrefix} cannot run: ${errorMessage(error)}`);
    process.exitCode = 1;
    return { passed: 0, failed: 1, skipped: 0 };
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    const cleanup = createCleanupRegistry();
    let result;
    try {
      result = await runWithTimeout(scenario, cleanup);
      const validStatuses = allowSkip ? ['pass', 'fail', 'skip'] : ['pass', 'fail'];
      if (
        result === undefined ||
        !validStatuses.includes(result.status)
      ) {
        throw new Error('scenario returned an invalid result');
      }
    } catch (error) {
      result = { status: 'fail', reason: errorMessage(error) };
    } finally {
      await cleanup.cleanupAll();
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
    `${labelPrefix} SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  if (failed !== 0 || (!allowSkip && skipped !== 0)) {
    process.exitCode = 1;
  }
  return { passed, failed, skipped };
}
