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
import { join, resolve } from 'node:path';

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
];

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

function assertExtensionLoaderContract(extensionsResult, expectedExtensionPath) {
  if (
    extensionsResult === undefined ||
    !Array.isArray(extensionsResult.extensions) ||
    !Array.isArray(extensionsResult.errors)
  ) {
    throw new Error('extension loader contract failed: malformed extensions result');
  }

  if (extensionsResult.errors.length !== 0) {
    throw new Error(
      `extension load failed: ${JSON.stringify(extensionsResult.errors)}`,
    );
  }

  const expectedPath = resolve(expectedExtensionPath);
  const matchingExtensions = extensionsResult.extensions.filter(
    (extension) => extension.resolvedPath === expectedPath,
  );
  if (
    extensionsResult.extensions.length !== 1 ||
    matchingExtensions.length !== 1
  ) {
    const loadedPaths = extensionsResult.extensions.map(
      (extension) => extension.resolvedPath ?? extension.path ?? '<unknown>',
    );
    throw new Error(
      `extension loader contract failed: expected exactly one extension resolving to ${expectedPath}; loaded ${JSON.stringify(loadedPaths)}`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectProviderMentions(value, path, modelId, result) {
  if (value === null || typeof value !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(value, 'provider')) {
    result.count += 1;
    if (value.provider !== 'faux') {
      throw new Error(
        `network identity contract failed at ${path}.provider: expected faux provider`,
      );
    }

    const modelIds = [];
    if (typeof value.model === 'string') {
      modelIds.push(value.model);
    } else if (isRecord(value.model) && typeof value.model.id === 'string') {
      modelIds.push(value.model.id);
    }
    if (typeof value.modelId === 'string') {
      modelIds.push(value.modelId);
    }
    if (
      modelIds.length === 0 &&
      typeof value.id === 'string' &&
      (Object.prototype.hasOwnProperty.call(value, 'api') ||
        Object.prototype.hasOwnProperty.call(value, 'baseUrl') ||
        Object.prototype.hasOwnProperty.call(value, 'name'))
    ) {
      modelIds.push(value.id);
    }

    if (modelIds.length === 0 || modelIds.some((candidate) => candidate !== modelId)) {
      throw new Error(
        `network identity contract failed at ${path}: expected faux model ${modelId}`,
      );
    }
  }

  for (const [key, child] of Object.entries(value)) {
    collectProviderMentions(child, `${path}.${key}`, modelId, result);
  }
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
  additionalExtensionPaths = [],
  expectedExtensionPath,
  customTools = [],
  sessionManager: suppliedSessionManager,
}) {
  if (isolation === undefined) {
    throw new Error('real-harness isolation is required');
  }
  if (typeof expectedExtensionPath !== 'string') {
    throw new Error('real-harness expectedExtensionPath is required');
  }

  const adapter = adapterForExtensionPath(expectedExtensionPath);
  assertDistFresh(adapter);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionManager =
    suppliedSessionManager ?? SessionManager.inMemory(isolation.workDir);
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

  try {
    assertExtensionLoaderContract(extensionsResult, expectedExtensionPath);
    if (session.sessionFile !== undefined) {
      throw new Error('in-memory session contract failed: session file was created');
    }
  } catch (error) {
    session.dispose();
    throw error;
  }

  const events = [];
  session.subscribe((event) => {
    const serialized = JSON.stringify(event);
    if (serialized === undefined) {
      throw new Error('real-harness event capture failed: event was not serializable');
    }
    events.push(serialized);
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

  const assertFauxNetworkIdentity = () => {
    const modelId = faux.getModel().id;
    const result = { count: 0 };
    for (const [index, serialized] of events.entries()) {
      let event;
      try {
        event = JSON.parse(serialized);
      } catch {
        throw new Error(`network identity contract failed: event ${index} is not JSON`);
      }
      collectProviderMentions(event, `event[${index}]`, modelId, result);
    }
    if (result.count === 0) {
      throw new Error('network identity contract failed: no provider event observed');
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
    events,
    extensionsResult,
    armAgentEndWaiter,
    assertNoPendingFauxResponses,
    assertInMemorySession,
    assertFauxNetworkIdentity,
    assertNoAuthCredentials,
    authPath,
  };
}
