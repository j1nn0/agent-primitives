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
const supervisorSourcePath = join(repoRoot, 'packages/agent-supervisor-pi/src');
export const SUPERVISOR_EXTENSION_PATH = join(
  repoRoot,
  'packages/agent-supervisor-pi/dist/extension.js',
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

export function assertSupervisorDistFresh() {
  if (!existsSync(SUPERVISOR_EXTENSION_PATH)) {
    throw new Error(
      'supervisor-harness requires packages/agent-supervisor-pi/dist/extension.js. Run pnpm build first.',
    );
  }
  if (!existsSync(supervisorSourcePath)) {
    throw new Error(
      'supervisor-harness cannot inspect packages/agent-supervisor-pi/src. Run pnpm build first.',
    );
  }

  const distMtime = statSync(SUPERVISOR_EXTENSION_PATH).mtimeMs;
  const staleSource = collectTypeScriptFiles(supervisorSourcePath).find(
    (sourcePath) => statSync(sourcePath).mtimeMs > distMtime,
  );
  if (staleSource !== undefined) {
    throw new Error(
      `packages/agent-supervisor-pi/dist/extension.js is stale because ${relative(
        repoRoot,
        staleSource,
      )} is newer. Run pnpm build first.`,
    );
  }
}

export function makeIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'supervisor-harness-'));
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

export function createCleanupRegistry() {
  const cleanups = [];
  let drainPromise;

  async function drain() {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try {
        await cleanup();
      } catch (error) {
        console.error(`supervisor-harness cleanup failed: ${errorMessage(error)}`);
      }
    }
  }

  return {
    registerCleanup(cleanup) {
      if (typeof cleanup !== 'function') {
        throw new TypeError('supervisor-harness cleanup must be a function');
      }
      cleanups.push(cleanup);
    },
    cleanupAll() {
      drainPromise = (drainPromise ?? Promise.resolve()).then(drain, drain);
      return drainPromise;
    },
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeSerialize(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? '<unserializable>' : serialized;
  } catch {
    return '<unserializable>';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'unknown error';
}

function assertAuthStoreHasNoCredentials(authPath) {
  if (!existsSync(authPath)) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    throw new Error('credential-free contract failed: auth.json is not valid JSON');
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 0) {
    throw new Error('credential-free contract failed: auth.json contains credentials');
  }
}

export function assertExtensionLoaderContract(extensionsResult, expectedPaths) {
  if (
    extensionsResult === undefined ||
    !Array.isArray(extensionsResult.extensions) ||
    !Array.isArray(extensionsResult.errors)
  ) {
    throw new Error('extension loader contract failed: malformed extensions result');
  }
  if (extensionsResult.errors.length !== 0) {
    throw new Error(
      `extension loader contract failed: extension load errors ${safeSerialize(
        extensionsResult.errors,
      )}`,
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
    throw new Error(
      `extension loader contract failed: expected exactly ${
        expectedResolvedPaths.length
      } extension path(s) ${safeSerialize(expectedResolvedPaths)}; loaded ${safeSerialize(
        loadedPaths,
      )}`,
    );
  }
}

function assertSessionStorage(session, sessionManager, storage, isolation) {
  if (storage === 'memory') {
    if (session.sessionFile !== undefined) {
      throw new Error('in-memory session contract failed: session file was created');
    }
    return;
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
}

const noOpTheme = Object.freeze({
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
  getFgAnsi: () => '',
  getBgAnsi: () => '',
  getColorMode: () => 'truecolor',
  getThinkingBorderColor: () => (text) => text,
  getBashModeBorderColor: () => (text) => text,
});

export async function createIsolatedSession({
  isolation,
  storage = 'memory',
  additionalExtensionPaths = [],
  expectedExtensionPath,
  expectedExtensionPaths,
  customTools = [],
  sessionManager: suppliedSessionManager,
  settingsManager: suppliedSettingsManager,
  sessionStartEvent,
} = {}) {
  if (isolation === undefined) {
    throw new Error('supervisor-harness isolation is required');
  }
  if (storage !== 'memory' && storage !== 'file') {
    throw new Error(`supervisor-harness storage mode is invalid: ${storage}`);
  }
  if (
    !Array.isArray(additionalExtensionPaths) ||
    !additionalExtensionPaths.every((path) => typeof path === 'string')
  ) {
    throw new Error('supervisor-harness extension paths must be an array of strings');
  }

  const expectedPaths =
    expectedExtensionPaths === undefined
      ? typeof expectedExtensionPath === 'string'
        ? [expectedExtensionPath]
        : additionalExtensionPaths
      : expectedExtensionPaths;
  if (
    !Array.isArray(expectedPaths) ||
    !expectedPaths.every((path) => typeof path === 'string')
  ) {
    throw new Error('supervisor-harness expected extension paths must be an array of strings');
  }

  assertSupervisorDistFresh();

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
  assertAuthStoreHasNoCredentials(authPath);

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
    sessionStartEvent,
  });

  const uiMessages = [];
  const uiContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify(message, type) {
      uiMessages.push({ message, type });
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: noOpTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'UI not available' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  let disposed = false;
  let unsubscribeEvents = () => {};
  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeEvents();
    session.dispose();
    try {
      faux.unregister();
    } catch {
      // The isolated faux provider is already gone.
    }
  };

  try {
    assertExtensionLoaderContract(extensionsResult, expectedPaths);
    assertSessionStorage(session, sessionManager, storage, isolation);
    await session.bindExtensions({ uiContext });
    assertAuthStoreHasNoCredentials(authPath);
  } catch (error) {
    cleanup();
    throw error;
  }

  const events = [];
  unsubscribeEvents = session.subscribe((event) => {
    events.push(event);
  });

  const armAgentEndWaiter = () => {
    let settled = false;
    let unsubscribe = () => {};
    let timer;
    let resolvePromise;
    let rejectPromise;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      callback(value);
    };
    const waiter = new Promise((resolvePromise_, rejectPromise_) => {
      resolvePromise = resolvePromise_;
      rejectPromise = rejectPromise_;
    });
    timer = setTimeout(() => {
      finish(
        rejectPromise,
        new Error('agent_end not observed within 30s'),
      );
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
    Object.defineProperty(waiter, 'cancel', {
      value: () => finish(resolvePromise),
    });
    return waiter;
  };

  const assertNoPendingFauxResponses = () => {
    const pending = faux.getPendingResponseCount();
    if (pending !== 0) {
      throw new Error(`faux provider has ${pending} pending scripted response(s)`);
    }
  };
  const assertNoAuthCredentials = () => {
    assertAuthStoreHasNoCredentials(authPath);
  };
  const assertStorage = () =>
    assertSessionStorage(session, sessionManager, storage, isolation);

  return {
    session,
    extensionsResult,
    sessionManager,
    faux,
    uiMessages,
    cleanup,
    events,
    authPath,
    armAgentEndWaiter,
    assertNoPendingFauxResponses,
    assertNoAuthCredentials,
    assertStorage,
  };
}

export async function runScriptedTurn(harness, prompt, responses) {
  const eventStart = harness.events.length;
  harness.faux.setResponses(responses);
  const turnFinished = harness.armAgentEndWaiter();
  try {
    await harness.session.prompt(prompt);
    await turnFinished;
  } catch (error) {
    turnFinished.cancel?.();
    throw error;
  }
  harness.assertNoAuthCredentials();
  return harness.events.slice(eventStart);
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

export async function runScenarioList(
  scenarios,
  { label, allowSkip = true } = {},
) {
  const runLabel = label ?? 'FULL';
  try {
    assertSupervisorDistFresh();
  } catch (error) {
    console.error(
      `SUPERVISOR-HARNESS ${runLabel} cannot run: ${errorMessage(error)}`,
    );
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
      const validStatuses = allowSkip
        ? ['pass', 'fail', 'skip']
        : ['pass', 'fail'];
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

    const reason = result.reason === undefined ? '' : String(result.reason);
    console.log(`scenario ${scenario.name}: ${result.status} — ${reason}`);
  }

  console.log(
    `SUPERVISOR-HARNESS ${runLabel} SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  if (failed !== 0 || (!allowSkip && skipped !== 0)) {
    process.exitCode = 1;
  }
  return { passed, failed, skipped };
}
