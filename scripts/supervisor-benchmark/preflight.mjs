/* global console, process */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Type } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { BENCHMARK_MODEL_FAMILIES } from './models.mjs';

const DEFAULT_MAX_REQUESTS = 8;
const PROVIDER_TIMEOUT_MS = 120_000;

// Scenario content (prompts, fixtures, filenames, scenario-specific tool names, and task
// content) is forbidden here; this neutral literal must not contaminate benchmark scenario selection.
const NEUTRAL_PROMPT = 'Reply exactly OK.';

// This fixed infrastructure allowlist is the one used by benchmark sessions. No scenario
// module or scenario-specific tool is loaded by this preflight.
const BENCHMARK_TOOL_ALLOWLIST = Object.freeze([
  'read',
  'write',
  'edit',
  'ls',
  'grep',
  'find',
]);
const PREFLIGHT_TOOL_NAME = 'preflight_noop';
const TOOL_CAPABLE_ALLOWLIST = Object.freeze([
  ...BENCHMARK_TOOL_ALLOWLIST,
  PREFLIGHT_TOOL_NAME,
]);
const PROVIDER_REQUEST_METHODS = new Set([
  'stream',
  'complete',
  'streamSimple',
  'completeSimple',
  'fetchDeferred',
  'cancelDeferred',
]);

const PREFLIGHT_TOOL = {
  name: PREFLIGHT_TOOL_NAME,
  label: 'Neutral preflight tool',
  description: 'A no-op custom tool used only to verify tool registration.',
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => ({
    content: [],
    isError: false,
  }),
};

class CallBudgetExceededError extends Error {
  constructor() {
    super('Preflight call budget exceeded.');
    this.name = 'CallBudgetExceededError';
  }
}

class DispatchBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    this.exceeded = false;
  }

  canDispatch() {
    return this.used < this.limit;
  }

  reserve() {
    if (!this.canDispatch()) {
      this.exceeded = true;
      throw new CallBudgetExceededError();
    }
    // Reserve before dispatch so failed, malformed, timed-out, and aborted requests count.
    this.used += 1;
  }
}

function parseMaxRequests(argv) {
  if (argv.length === 0) {
    return DEFAULT_MAX_REQUESTS;
  }
  if (
    argv.length !== 2 ||
    (argv[0] !== '--max-requests' && argv[0] !== '--max-calls')
  ) {
    throw new Error('Invalid preflight arguments.');
  }

  const value = Number(argv[1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_REQUESTS) {
    throw new Error('Invalid preflight request budget.');
  }
  return value;
}

function createCountingModelRuntime(modelRuntime, budget) {
  return new Proxy(modelRuntime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (typeof property === 'string' && PROVIDER_REQUEST_METHODS.has(property)) {
        return (...args) => {
          budget.reserve();
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    },
  });
}

function createRuntimeIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'supervisor-preflight-runtime-'));
  const agentDir = join(base, 'agent');
  mkdirSync(agentDir, { recursive: true });
  return {
    base,
    agentDir,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function createSessionIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'supervisor-preflight-session-'));
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

async function createPreflightSession({
  modelRuntime,
  model,
  thinkingLevel,
  tools,
  customTools = [],
}) {
  const isolation = createSessionIsolation();
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: false,
        maxRetries: 0,
        provider: { maxRetries: 0, timeoutMs: PROVIDER_TIMEOUT_MS },
      },
    });
    // Keep session history in memory so the neutral prompt and any provider output are not written to disk.
    const sessionManager = SessionManager.inMemory(isolation.workDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: isolation.workDir,
      agentDir: isolation.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: isolation.workDir,
      agentDir: isolation.agentDir,
      modelRuntime,
      model,
      thinkingLevel,
      settingsManager,
      sessionManager,
      resourceLoader,
      tools,
      customTools,
    });
    if (
      created.extensionsResult === undefined ||
      !Array.isArray(created.extensionsResult.errors) ||
      created.extensionsResult.errors.length !== 0
    ) {
      throw new Error('Preflight extension loading failed.');
    }

    session = created.session;
    await session.bindExtensions({});
    let disposed = false;
    return {
      session,
      cleanup() {
        if (disposed) {
          return;
        }
        disposed = true;
        session.dispose();
        isolation.cleanup();
      },
    };
  } catch (error) {
    session?.dispose();
    isolation.cleanup();
    throw error;
  }
}

function hasPositiveTokenTotal(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hasSuccessfulStopReason(value) {
  return value === 'stop' || value === 'length' || value === 'toolUse';
}

function hasSuccessfulAssistant(session) {
  const messages = session.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return hasSuccessfulStopReason(message.stopReason);
    }
  }
  return false;
}

async function runSimpleSessionCheck({ modelRuntime, model, thinkingLevel, budget }) {
  if (!budget.canDispatch()) {
    return { sessionExecuted: false, tokenUsagePositive: false };
  }

  let bundle;
  try {
    bundle = await createPreflightSession({
      modelRuntime,
      model,
      thinkingLevel,
      tools: [],
    });
    await bundle.session.prompt(NEUTRAL_PROMPT, {
      expandPromptTemplates: false,
      source: 'extension',
    });
    await bundle.session.waitForIdle();
    const totalTokens = bundle.session.getSessionStats()?.tokens?.total;
    return {
      sessionExecuted: hasSuccessfulAssistant(bundle.session),
      tokenUsagePositive: hasPositiveTokenTotal(totalTokens),
    };
  } catch {
    return { sessionExecuted: false, tokenUsagePositive: false };
  } finally {
    bundle?.cleanup();
  }
}

async function runToolCapableSessionCheck({
  modelRuntime,
  model,
  thinkingLevel,
}) {
  let bundle;
  try {
    bundle = await createPreflightSession({
      modelRuntime,
      model,
      thinkingLevel,
      tools: TOOL_CAPABLE_ALLOWLIST,
      customTools: [PREFLIGHT_TOOL],
    });
    const activeToolNames = new Set(bundle.session.getActiveToolNames());
    const allToolsActive = TOOL_CAPABLE_ALLOWLIST.every((name) =>
      activeToolNames.has(name),
    );
    const customTool = bundle.session.getToolDefinition(PREFLIGHT_TOOL_NAME);
    return (
      allToolsActive &&
      customTool?.name === PREFLIGHT_TOOL_NAME &&
      typeof customTool.execute === 'function'
    );
  } catch {
    return false;
  } finally {
    bundle?.cleanup();
  }
}

async function runAuxiliaryUsageCheck({ modelRuntime, model, budget }) {
  if (!budget.canDispatch()) {
    return { callCompleted: false, usagePositive: false };
  }

  const modelRegistry = new ModelRegistry(modelRuntime);
  try {
    const response = await modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: 'user',
            content: NEUTRAL_PROMPT,
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 32,
        maxRetries: 0,
        timeoutMs: PROVIDER_TIMEOUT_MS,
      },
    );
    return {
      callCompleted:
        response?.role === 'assistant' && hasSuccessfulStopReason(response.stopReason),
      usagePositive: hasPositiveTokenTotal(response?.usage?.totalTokens),
    };
  } catch {
    return { callCompleted: false, usagePositive: false };
  }
}

function emptyChecks() {
  return {
    modelResolves: 'FAIL',
    authenticationConfigured: 'FAIL',
    simpleSessionExecutes: 'FAIL',
    reportedTokenUsagePositive: 'FAIL',
    toolCapableSessionCreated: 'FAIL',
    auxiliaryCallUsagePositive: 'FAIL',
  };
}

function makeFailedFamilyReport(modelFamily) {
  const checks = emptyChecks();
  return {
    modelFamily: modelFamily.modelFamily,
    modelId: modelFamily.modelId,
    provider: modelFamily.provider,
    thinkingLevel: modelFamily.thinkingLevel,
    usageMeasurable: false,
    status: 'FAIL',
    checks,
    failures: Object.keys(checks),
  };
}

async function verifyModelFamily(modelFamily, modelRuntime, budget) {
  const checks = emptyChecks();
  let model;
  try {
    model = modelRuntime.getModel(modelFamily.provider, modelFamily.modelName);
    if (
      model !== undefined &&
      model.provider === modelFamily.provider &&
      model.id === modelFamily.modelName
    ) {
      checks.modelResolves = 'PASS';
    }
  } catch {
    model = undefined;
  }

  let authenticationConfigured = false;
  try {
    // Mirror the validation Pi itself performs before sending a prompt: an
    // environment-configured key, or a stored credential resolved offline.
    // hasConfiguredAuth alone only sees env-var keys and misses stored API keys and OAuth.
    authenticationConfigured =
      modelRuntime.hasConfiguredAuth(modelFamily.provider) === true ||
      (await modelRuntime.checkAuth(modelFamily.provider)) !== undefined;
  } catch {
    // Leave the initialized false value in place when auth inspection fails.
  }
  if (authenticationConfigured) {
    checks.authenticationConfigured = 'PASS';
  }

  let simpleResult = { sessionExecuted: false, tokenUsagePositive: false };
  if (model !== undefined && authenticationConfigured) {
    simpleResult = await runSimpleSessionCheck({
      modelRuntime,
      model,
      thinkingLevel: modelFamily.thinkingLevel,
      budget,
    });
  }
  if (simpleResult.sessionExecuted) {
    checks.simpleSessionExecutes = 'PASS';
  }
  if (simpleResult.tokenUsagePositive) {
    checks.reportedTokenUsagePositive = 'PASS';
  }

  if (model !== undefined) {
    const toolSessionCreated = await runToolCapableSessionCheck({
      modelRuntime,
      model,
      thinkingLevel: modelFamily.thinkingLevel,
    });
    if (toolSessionCreated) {
      checks.toolCapableSessionCreated = 'PASS';
    }
  }

  let auxiliaryResult = { callCompleted: false, usagePositive: false };
  if (model !== undefined && authenticationConfigured) {
    auxiliaryResult = await runAuxiliaryUsageCheck({
      modelRuntime,
      model,
      budget,
    });
  }
  if (auxiliaryResult.callCompleted && auxiliaryResult.usagePositive) {
    checks.auxiliaryCallUsagePositive = 'PASS';
  }

  const failures = Object.entries(checks)
    .filter(([, status]) => status !== 'PASS')
    .map(([name]) => name);
  return {
    modelFamily: modelFamily.modelFamily,
    modelId: modelFamily.modelId,
    provider: modelFamily.provider,
    thinkingLevel: modelFamily.thinkingLevel,
    usageMeasurable:
      auxiliaryResult.callCompleted &&
      simpleResult.sessionExecuted &&
      simpleResult.tokenUsagePositive &&
      auxiliaryResult.usagePositive,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
  };
}

function makeReport(maxRequests, budget, families, failureKind) {
  const allFamiliesPassed = families.every((family) => family.status === 'PASS');
  return {
    schemaVersion: 1,
    status:
      failureKind === undefined && !budget.exceeded && allFamiliesPassed
        ? 'PASS'
        : 'FAIL',
    requestBudget: {
      maxRequests,
      dispatchedRequests: budget.used,
      exceeded: budget.exceeded,
    },
    ...(failureKind === undefined ? {} : { failureKind }),
    families,
  };
}

async function main() {
  let maxRequests;
  try {
    maxRequests = parseMaxRequests(process.argv.slice(2));
  } catch {
    const budget = new DispatchBudget(DEFAULT_MAX_REQUESTS);
    console.log(
      JSON.stringify(
        makeReport(
          DEFAULT_MAX_REQUESTS,
          budget,
          BENCHMARK_MODEL_FAMILIES.map(makeFailedFamilyReport),
          'input',
        ),
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const budget = new DispatchBudget(maxRequests);
  const reports = [];
  let runtimeIsolation;
  let failureKind;
  try {
    runtimeIsolation = createRuntimeIsolation();
    // The user's real auth.json is read only for authentication. The currently configured
    // openai-codex OAuth token is long-lived, so no token rewrite is expected.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(homedir(), '.pi', 'agent', 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(runtimeIsolation.agentDir, 'models.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const countedModelRuntime = createCountingModelRuntime(modelRuntime, budget);

    // This is one shared budget for all model families; it is never reset per family.
    for (const modelFamily of BENCHMARK_MODEL_FAMILIES) {
      reports.push(
        await verifyModelFamily(modelFamily, countedModelRuntime, budget),
      );
    }
  } catch {
    failureKind = 'runtime';
  } finally {
    runtimeIsolation?.cleanup();
  }

  if (failureKind !== undefined) {
    reports.push(
      ...BENCHMARK_MODEL_FAMILIES
        .slice(reports.length)
        .map(makeFailedFamilyReport),
    );
  }

  console.log(
    JSON.stringify(makeReport(maxRequests, budget, reports, failureKind), null, 2),
  );
  if (
    failureKind !== undefined ||
    budget.exceeded ||
    reports.some((family) => family.status !== 'PASS')
  ) {
    process.exitCode = 1;
  }
}

await main();
