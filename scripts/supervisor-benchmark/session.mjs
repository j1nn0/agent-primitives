import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  clearActiveBenchmarkTelemetry,
  setActiveBenchmarkTelemetry,
} from './wrapper-extension.mjs';

const WRAPPER_EXTENSION_PATH = resolve(
  import.meta.dirname,
  'wrapper-extension.mjs',
);

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

function assertStringArray(value, name) {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new TypeError(`Benchmark ${name} must be an array of strings.`);
  }
}

function assertIsolation(isolation) {
  if (
    isolation === null ||
    typeof isolation !== 'object' ||
    typeof isolation.base !== 'string' ||
    typeof isolation.agentDir !== 'string' ||
    typeof isolation.workDir !== 'string'
  ) {
    throw new TypeError('Benchmark isolation must contain base, agentDir, and workDir.');
  }
}

function assertExtensionLoaderContract(extensionsResult, expectedPaths) {
  if (
    extensionsResult === undefined ||
    !Array.isArray(extensionsResult.extensions) ||
    !Array.isArray(extensionsResult.errors)
  ) {
    throw new Error('Benchmark extension loader returned a malformed result.');
  }

  if (extensionsResult.errors.length !== 0) {
    throw new Error('Benchmark extension loader returned errors.');
  }

  const expectedResolvedPaths = expectedPaths.map((path) => resolve(path));
  const loadedResolvedPaths = extensionsResult.extensions.map((extension) =>
    typeof extension?.resolvedPath === 'string'
      ? resolve(extension.resolvedPath)
      : undefined,
  );
  const loadedPathSet = new Set(loadedResolvedPaths);
  const expectedPathSet = new Set(expectedResolvedPaths);
  const exactPathSet =
    loadedResolvedPaths.length === expectedResolvedPaths.length &&
    loadedResolvedPaths.every(
      (path) => path !== undefined && expectedPathSet.has(path),
    ) &&
    loadedPathSet.size === expectedPathSet.size;

  if (!exactPathSet) {
    throw new Error('Benchmark extension loader loaded an unexpected extension set.');
  }
}

function assertSessionStorage(session, sessionManager, storage, isolation) {
  if (storage === 'memory') {
    if (session.sessionFile !== undefined) {
      throw new Error('Benchmark memory storage created a session file.');
    }
    return;
  }

  if (typeof session.sessionFile !== 'string') {
    throw new Error('Benchmark file storage did not create a session file.');
  }
  if (
    typeof sessionManager.isPersisted !== 'function' ||
    !sessionManager.isPersisted()
  ) {
    throw new Error('Benchmark file storage is not persisted.');
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
    throw new Error('Benchmark file storage escaped the isolated workspace.');
  }
}

function createUiContext() {
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
  return { uiContext, uiMessages };
}

/**
 * Create one isolated Pi session for one benchmark variant.
 *
 * The model and model runtime are deliberately supplied by the caller. This
 * module only constructs the Pi session around them; it never resolves a
 * provider or changes the caller's provider configuration.
 */
export async function createBenchmarkSession({
  isolation,
  variant,
  model,
  thinkingLevel,
  modelRuntime,
  tools,
  customTools = [],
  storage,
  sessionManager: suppliedSessionManager,
  sessionStartEvent,
  telemetry,
}) {
  if (variant !== 'baseline' && variant !== 'supervisor') {
    throw new TypeError(`Unknown benchmark variant: ${variant}`);
  }
  assertIsolation(isolation);
  if (model === undefined || model === null) {
    throw new TypeError('Benchmark model is required.');
  }
  if (modelRuntime === undefined || modelRuntime === null) {
    throw new TypeError('Benchmark modelRuntime is required.');
  }
  assertStringArray(tools, 'tools');
  if (!Array.isArray(customTools)) {
    throw new TypeError('Benchmark customTools must be an array.');
  }
  if (storage !== 'memory' && storage !== 'file') {
    throw new TypeError(`Unknown benchmark storage mode: ${storage}`);
  }
  if (variant === 'supervisor' && telemetry === undefined) {
    throw new TypeError('Supervisor benchmark sessions require telemetry.');
  }
  if (variant === 'baseline' && telemetry !== undefined) {
    throw new TypeError('Baseline benchmark sessions cannot receive telemetry.');
  }

  const additionalExtensionPaths =
    variant === 'supervisor' ? [WRAPPER_EXTENSION_PATH] : [];
  const settingsManager = SettingsManager.inMemory({
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

  if (variant === 'supervisor') {
    setActiveBenchmarkTelemetry(telemetry);
  } else {
    clearActiveBenchmarkTelemetry();
  }

  let session;
  try {
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
      sessionStartEvent,
    });
    session = created.session;

    assertExtensionLoaderContract(
      created.extensionsResult,
      additionalExtensionPaths,
    );
    assertSessionStorage(
      session,
      sessionManager,
      storage,
      isolation,
    );

    const { uiContext, uiMessages } = createUiContext();
    await session.bindExtensions({ uiContext });

    let disposed = false;
    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      session.dispose();
      clearActiveBenchmarkTelemetry();
    };

    return {
      session,
      sessionManager,
      settingsManager,
      resourceLoader,
      extensionsResult: created.extensionsResult,
      extensionLoadErrors: created.extensionsResult.errors.length,
      uiMessages,
      cleanup,
    };
  } catch (error) {
    session?.dispose();
    clearActiveBenchmarkTelemetry();
    throw error;
  }
}

export { WRAPPER_EXTENSION_PATH };
