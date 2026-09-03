import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import {
  SupervisorAssessmentCapture,
  SupervisorAssessmentEvidenceCollector,
} from '../src/assessment/evidence.js';
import {
  classifySupervisorShellCommand,
  computeSupervisorPathDigest,
  isSupervisorTrustedBuiltin,
  SUPERVISOR_COMPLETION_SUPPORTING_KINDS,
  SUPERVISOR_VERIFICATION_KINDS,
  type SupervisorVerificationKind,
} from '../src/assessment/verification.js';
import { validateSupervisorFeatureDescriptor } from '../src/feature.js';
import type { SupervisorFeatureModule } from '../src/module.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';

function toolRegistry(...entries: readonly (readonly [string, string])[]): () => readonly unknown[] {
  return () => entries.map(([name, source]) => ({ name, sourceInfo: { source } }));
}

function toolResult(
  toolName: string,
  input: Record<string, unknown> = {},
  isError = false,
  text = 'result',
): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: `${toolName}-call`,
    toolName,
    input,
    content: [{ type: 'text', text }],
    isError,
    details: {},
  } as ToolResultEvent;
}

const ALL_PROTECTED_BUILTINS = toolRegistry(
  ['bash', 'builtin'],
  ['powershell', 'builtin'],
  ['edit', 'builtin'],
  ['write', 'builtin'],
  ['read', 'builtin'],
);

function collectOne(
  toolName: string,
  command: string,
  isError = false,
): SupervisorAssessmentEvidenceCollector {
  const collector = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);
  collector.observeToolResult(toolResult(toolName, { command }, isError));
  return collector;
}

describe('deterministic verification classifier', () => {
  it('exposes a closed set of verification kinds', () => {
    expect(SUPERVISOR_VERIFICATION_KINDS).toEqual([
      'test',
      'lint',
      'typecheck',
      'build',
      'validation',
      'repository-inspection',
      'read-back',
    ]);
    expect(SUPERVISOR_COMPLETION_SUPPORTING_KINDS).toEqual([
      'test',
      'lint',
      'typecheck',
      'build',
      'validation',
      'read-back',
    ]);
  });

  it.each([
    ['pnpm test', 'test'],
    ['pnpm run test', 'test'],
    ['npm test', 'test'],
    ['npm run test', 'test'],
    ['yarn test', 'test'],
    ['bun test', 'test'],
    ['vitest', 'test'],
    ['jest', 'test'],
    ['pytest', 'test'],
    ['python -m pytest', 'test'],
    ['phpunit', 'test'],
    ['vendor/bin/phpunit', 'test'],
    ['php artisan test', 'test'],
    ['go test', 'test'],
    ['cargo test', 'test'],
    ['dotnet test', 'test'],
    ['pnpm lint', 'lint'],
    ['npm run lint', 'lint'],
    ['eslint', 'lint'],
    ['eslint .', 'lint'],
    ['oxlint', 'lint'],
    ['ruff check', 'lint'],
    ['pnpm typecheck', 'typecheck'],
    ['npm run typecheck', 'typecheck'],
    ['tsc', 'typecheck'],
    ['tsc --noEmit', 'typecheck'],
    ['vue-tsc', 'typecheck'],
    ['vue-tsc --noEmit', 'typecheck'],
    ['mypy', 'typecheck'],
    ['pyright', 'typecheck'],
    ['phpstan', 'typecheck'],
    ['psalm', 'typecheck'],
    ['pnpm build', 'build'],
    ['npm run build', 'build'],
    ['cargo build', 'build'],
    ['go build', 'build'],
    ['mvn package', 'build'],
    ['gradle build', 'build'],
    ['./gradlew build', 'build'],
    ['composer validate', 'validation'],
    ['git diff --check', 'validation'],
    ['git diff', 'repository-inspection'],
    ['git status', 'repository-inspection'],
  ] as const satisfies readonly (readonly [string, SupervisorVerificationKind])[])(
    'classifies the supported simple command %s as %s',
    (command, expectedKind) => {
      expect(classifySupervisorShellCommand(command)).toBe(expectedKind);
      expect(collectOne('bash', command).getRecords()[0]?.verificationKind).toBe(expectedKind);
    },
  );

  it('classifies a recognized command even when the result failed', () => {
    const collector = collectOne('powershell', 'pnpm test', true);
    const record = collector.getRecords()[0];

    expect(record?.isError).toBe(true);
    expect(record?.verificationKind).toBe('test');
  });

  it.each([
    'echo "npm test"',
    'echo done',
    'ls',
    'cat file',
  ])('rejects non-verification commands that could fool substring matching: %s', (command) => {
    expect(classifySupervisorShellCommand(command)).toBeNull();
    expect(collectOne('bash', command).getRecords()[0]?.verificationKind).toBeNull();
  });

  it.each([
    'pnpm test && echo ok',
    'pnpm test || true',
    'pnpm test; true',
    'pnpm test | cat',
    'pnpm test > log',
    'pnpm test 2>&1',
    '$(pnpm test)',
    'pnpm test # comment',
    'MODE=test pnpm test',
    'pnpm test\n',
  ])('rejects ambiguous shell syntax: %s', (command) => {
    expect(classifySupervisorShellCommand(command)).toBeNull();
    expect(collectOne('bash', command).getRecords()[0]?.verificationKind).toBeNull();
  });

  it('does not trust a custom bash or write that shadows a builtin name', () => {
    const customBash = new SupervisorAssessmentEvidenceCollector(
      toolRegistry(['bash', 'sdk'], ['write', 'builtin']),
    );
    customBash.observeToolResult(toolResult('bash', { command: 'pnpm test' }));
    expect(customBash.getRecords()[0]?.verificationKind).toBeNull();

    const customWrite = new SupervisorAssessmentEvidenceCollector(toolRegistry(['write', 'extension']));
    customWrite.observeToolResult(toolResult('write', { path: '/tmp/custom.txt' }));
    expect(customWrite.getMutationEpoch()).toBe(0);
    expect(customWrite.getRecords()[0]?.mutationEpoch).toBe(0);
    expect(customWrite.getRecords()[0]?.verificationKind).toBeNull();
  });

  it('uses the effective last registry entry for provenance', () => {
    expect(
      isSupervisorTrustedBuiltin('write', toolRegistry(['write', 'builtin'], ['write', 'sdk'])),
    ).toBe(false);
    expect(
      isSupervisorTrustedBuiltin('write', toolRegistry(['write', 'sdk'], ['write', 'builtin'])),
    ).toBe(true);
  });
});

describe('Root-local mutation epochs', () => {
  it('increments for successful trusted writes and edits, but not a failed mutation', () => {
    const collector = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);

    collector.observeToolResult(toolResult('write', { path: '/tmp/a.txt' }));
    collector.observeToolResult(toolResult('edit', { path: '/tmp/b.txt' }));
    collector.observeToolResult(toolResult('write', { path: '/tmp/c.txt' }, true));

    expect(collector.getMutationEpoch()).toBe(2);
    expect(collector.getRecords().map((record) => record.mutationEpoch)).toEqual([1, 2, 2]);
    expect(collector.getRecords().map((record) => record.verificationKind)).toEqual([null, null, null]);
  });

  it('clears the epoch and pending read-back state for a new Root Request', () => {
    const capture = new SupervisorAssessmentCapture(ALL_PROTECTED_BUILTINS);

    capture.beginRootRequest('first task');
    capture.observeToolResult(toolResult('write', { path: '/tmp/a.txt' }));
    expect(capture.getMutationEpoch()).toBe(1);

    capture.beginRootRequest('second task');
    expect(capture.getMutationEpoch()).toBe(0);
    expect(capture.getEvidence()).toEqual([]);
  });
});

describe('read-back verification', () => {
  it('recognizes a successful read after one trusted mutation', () => {
    const collector = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);

    collector.observeToolResult(toolResult('write', { path: 'tmp/./a.txt' }));
    collector.observeToolResult(toolResult('read', { path: 'tmp/a.txt' }));

    expect(collector.getRecords().map((record) => record.verificationKind)).toEqual([null, 'read-back']);
    expect(collector.getRecords().map((record) => record.mutationEpoch)).toEqual([1, 1]);
  });

  it('requires every pending mutated path to be read successfully', () => {
    const collector = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);

    collector.observeToolResult(toolResult('write', { path: '/tmp/a.txt' }));
    collector.observeToolResult(toolResult('write', { path: '/tmp/b.txt' }));
    collector.observeToolResult(toolResult('read', { path: '/tmp/a.txt' }));
    collector.observeToolResult(toolResult('read', { path: '/tmp/b.txt' }));

    expect(collector.getRecords().map((record) => record.verificationKind)).toEqual([
      null,
      null,
      null,
      'read-back',
    ]);
  });

  it('does not complete read-back on a failed read or an untrusted mutation', () => {
    const failedRead = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);
    failedRead.observeToolResult(toolResult('write', { path: '/tmp/a.txt' }));
    failedRead.observeToolResult(toolResult('read', { path: '/tmp/a.txt' }, true));
    expect(failedRead.getRecords()[1]?.verificationKind).toBeNull();
    failedRead.observeToolResult(toolResult('read', { path: '/tmp/a.txt' }));
    expect(failedRead.getRecords()[2]?.verificationKind).toBe('read-back');

    const untrustedMutation = new SupervisorAssessmentEvidenceCollector(
      toolRegistry(['write', 'sdk'], ['read', 'builtin']),
    );
    untrustedMutation.observeToolResult(toolResult('write', { path: '/tmp/a.txt' }));
    untrustedMutation.observeToolResult(toolResult('read', { path: '/tmp/a.txt' }));
    expect(untrustedMutation.getMutationEpoch()).toBe(0);
    expect(untrustedMutation.getRecords()[1]?.verificationKind).toBeNull();
  });

  it('hashes only canonical paths and never retains the raw path in metadata', () => {
    const path = '/private/path/../result.txt';
    const collector = new SupervisorAssessmentEvidenceCollector(ALL_PROTECTED_BUILTINS);
    collector.observeToolResult(toolResult('write', { path }, false, 'write result'));
    collector.observeToolResult(toolResult('read', { path: '/private/result.txt' }, false, 'read result'));

    const [writeRecord, readRecord] = collector.getRecords();
    expect(readRecord?.verificationKind).toBe('read-back');
    expect(computeSupervisorPathDigest(path)).not.toBeNull();
    expect(JSON.stringify(writeRecord)).not.toContain(path);
    expect(JSON.stringify(readRecord)).not.toContain(path);
    expect(JSON.stringify(writeRecord)).not.toContain('command');
  });
});


type KernelEventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;

class KernelRecordingPi {
  public readonly handlers = new Map<string, KernelEventHandler>();
  public readonly branch: SessionEntry[] = [];
  public readonly model = { reasoning: false, thinkingLevelMap: {} };
  public readonly completionResponse = {
    stopReason: 'stop',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          schemaVersion: 1,
          claims: [
            {
              kind: 'verification',
              quote: 'Done.',
              evidence: [{ id: 'e2', quote: 'tests passed' }],
            },
          ],
        }),
      },
    ],
  };
  public readonly modelRegistry = {
    complete: async (): Promise<unknown> => this.completionResponse,
  };
  public readonly pi: ExtensionAPI;

  public constructor() {
    this.pi = {
      on: (type: string, handler: unknown): void => {
        this.handlers.set(type, handler as KernelEventHandler);
      },
      registerCommand: (): void => undefined,
      appendEntry: (): void => undefined,
      sendUserMessage: (): void => undefined,
      getAllTools: (): readonly unknown[] => [
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        { name: 'write', sourceInfo: { source: 'builtin' } },
      ],
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
        getSessionId: (): string => 'session-1',
      },
      model: this.model,
      modelRegistry: this.modelRegistry,
      ui: { notify: (): void => undefined },
    } as unknown as ExtensionContext;
  }

  public async emit(type: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw new Error(`No handler for ${type}`);
    }
    return handler(event, this.context());
  }
}

function assessmentConsumer(): SupervisorFeatureModule {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id: 'assessment-consumer',
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: [],
      provides: [],
      requires: ['kernel:assessment'],
      conflictsWith: [],
      usesAuxiliaryModel: true,
      interventionIntents: [],
    }),
    create: () => ({}),
  };
}

describe('assessment fact verification metadata', () => {
  it('surfaces deterministic metadata without copying command, path, or result text', async () => {
    const recording = new KernelRecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [assessmentConsumer()]);
    kernel.register();

    await recording.emit('input', { type: 'input', source: 'interactive', text: 'task' });
    await recording.emit('tool_result', toolResult('write', { path: '/private/changed.txt' }, false, 'write output'));
    await recording.emit('tool_result', toolResult('bash', { command: 'pnpm test' }, false, 'tests passed'));
    await recording.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      toolResults: [],
    });
    await recording.emit('agent_settled', { type: 'agent_settled' });

    const fact = kernel.getFacts()[0];
    expect(fact?.data).toMatchObject({
      mutationEpoch: 1,
      evidence: [
        { id: 'e1', mutationEpoch: 1, verificationKind: null },
        { id: 'e2', mutationEpoch: 1, verificationKind: 'test' },
      ],
    });
    const serialized = JSON.stringify(fact);
    expect(serialized).not.toContain('pnpm test');
    expect(serialized).not.toContain('/private/changed.txt');
    expect(serialized).not.toContain('write output');
    expect(serialized).not.toContain('tests passed');
  });
});
