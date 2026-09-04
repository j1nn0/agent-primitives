import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { Type } from '@earendil-works/pi-ai';

const RUN_CHECKS_PARAMETERS = Type.Object({}, { additionalProperties: false });

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function loadWorkspaceFunction(workspaceDir, relativePath, exportName) {
  try {
    const source = readFileSync(join(workspaceDir, relativePath), 'utf8');
    const exportPattern = new RegExp(
      `export\\s+function\\s+${escapeRegExp(exportName)}\\s*\\(`,
      'u',
    );
    if (!exportPattern.test(source)) {
      return undefined;
    }

    const executable =
      source
        .replace(/\bexport\s+(?=function|const|let|var)/gu, '')
        .replace(/\bexport\s*\{[^}]*\}\s*;?/gu, '') +
      `\nmodule.exports = { ${exportName} };`;
    const module = { exports: {} };
    new Script(executable, { filename: relativePath }).runInNewContext({
      module,
      exports: module.exports,
    });
    return typeof module.exports[exportName] === 'function'
      ? module.exports[exportName]
      : undefined;
  } catch {
    return undefined;
  }
}

export function createRunChecksTool({
  workspaceDir,
  sentinels,
  recordVerification,
  checkWorkspace,
}) {
  if (typeof checkWorkspace !== 'function') {
    throw new TypeError('run_checks requires a workspace check function.');
  }
  const sentinel = sentinels[0];
  return {
    name: 'run_checks',
    label: 'Run workspace checks',
    description: 'Runs the deterministic checks for the current workspace.',
    parameters: RUN_CHECKS_PARAMETERS,
    checkWorkspace,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId;
      void params;
      void signal;
      void onUpdate;
      void ctx;

      let passed;
      try {
        passed = checkWorkspace(workspaceDir) === true;
      } catch {
        passed = false;
      }
      recordVerification({ name: 'checks', passed });
      return {
        content: [
          {
            type: 'text',
            text: passed
              ? `PASS checks (${sentinel})`
              : `FAIL: checks did not pass (${sentinel})`,
          },
        ],
        details: { passed },
      };
    },
  };
}
