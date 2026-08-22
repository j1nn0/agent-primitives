import { describe, expect, it, vi } from 'vitest';
import type { ContextEvent } from '@earendil-works/pi-coding-agent';
import type { PersistedState } from '../src/extension.js';
import {
  FakePiHarness,
  customEntry,
} from './harness.js';

type CandidateMessage = ContextEvent['messages'][number];
type TextBlock = { type: 'text'; text: string };
type RecoveryMessage = Extract<CandidateMessage, { role: 'custom' }>;

const STATE_CUSTOM_TYPE = 'agent-context-guard-state';

function item(
  id: string,
  content: string,
  critical = false,
  kind: 'goal' | 'constraint' | 'requirement' | 'decision' | 'fact' = 'fact',
): { id: string; kind: typeof kind; content: string; critical: boolean } {
  return { id, kind, content, critical };
}

function stateData(
  items: readonly unknown[],
  recovery: 'off' | 'critical' = 'off',
): PersistedState {
  return {
    schemaVersion: 1,
    recovery,
    items: items as PersistedState['items'],
  };
}

function latestState(harness: FakePiHarness): PersistedState {
  const entry = harness.appendedEntries.at(-1);
  expect(entry?.customType).toBe(STATE_CUSTOM_TYPE);
  return entry?.data as PersistedState;
}

function textMessage(text: string): CandidateMessage {
  return {
    role: 'user',
    content: text,
    timestamp: 1,
  } as CandidateMessage;
}

function block(text: string): TextBlock {
  return { type: 'text', text };
}

function image(data: string): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data, mimeType: 'image/png' };
}

function assistantMessage(content: readonly unknown[]): CandidateMessage {
  return {
    role: 'assistant',
    content,
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: 2,
  } as CandidateMessage;
}

function toolResultMessage(content: readonly unknown[]): CandidateMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'test-tool',
    content,
    isError: false,
    timestamp: 3,
  } as CandidateMessage;
}

function customMessage(
  content: string | readonly unknown[],
  details?: unknown,
): CandidateMessage {
  return {
    role: 'custom',
    customType: 'test-message',
    content,
    display: false,
    details,
    timestamp: 4,
  } as CandidateMessage;
}

function contextEvent(messages: readonly CandidateMessage[]): unknown {
  return { type: 'context', messages };
}

function compactEvent(id: string, summary = ''): unknown {
  return {
    type: 'session_compact',
    compactionEntry: {
      id,
      summary,
      firstKeptEntryId: 'entry-1',
    },
  };
}

function verificationMessages(harness: FakePiHarness): readonly string[] {
  return harness.notifyMessages().filter((message) =>
    /\d+ preserved, \d+ lost,/.test(message),
  );
}

async function verifyAfterCompaction(
  harness: FakePiHarness,
  id: string,
  messages: readonly CandidateMessage[],
  summary = '',
): Promise<unknown> {
  await harness.invoke('session_before_compact');
  await harness.invoke('session_compact', compactEvent(id, summary));
  return await harness.invoke('context', contextEvent(messages));
}

async function expectMutationClearsSnapshot(
  mutate: (harness: FakePiHarness) => Promise<void>,
): Promise<void> {
  const harness = new FakePiHarness();
  await harness.start();
  await harness.command('add existing fact Existing protected item');
  const notificationCount = harness.notifications.length;

  await harness.invoke('session_before_compact');
  await mutate(harness);
  await harness.invoke('session_compact', compactEvent('mutated-cycle'));
  await harness.invoke('context', contextEvent([textMessage('')]));

  expect(verificationMessages(harness)).toHaveLength(0);
  expect(harness.notifications.length).toBeGreaterThan(notificationCount);
  expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
}

async function expectSessionResetClearsPending(
  resetEvent: 'session_start' | 'session_shutdown',
): Promise<void> {
  const harness = new FakePiHarness();
  await harness.start();
  await harness.command('add protected fact Pending snapshot item');
  await harness.invoke('session_before_compact');
  const notificationCount = harness.notifications.length;

  if (resetEvent === 'session_start') {
    await harness.invoke('session_start', {
      type: 'session_start',
      reason: 'reload',
    });
  } else {
    await harness.invoke('session_shutdown');
  }
  await harness.invoke('session_compact', compactEvent(`reset-${resetEvent}`));
  await harness.invoke('context', contextEvent([textMessage('Pending snapshot item')]));

  expect(verificationMessages(harness)).toHaveLength(0);
  expect(harness.notifications.length).toBeGreaterThan(notificationCount);
  expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
}

describe('Pi context guard commands', () => {
  it('adds, rejects duplicate ids, lists, and removes protected items', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('add release constraint --critical Keep this release constraint');
    expect(latestState(harness).items).toEqual([
      item(
        'release',
        'Keep this release constraint',
        true,
        'constraint',
      ),
    ]);

    await harness.command('add release constraint Another value');
    expect(harness.notifyMessages().at(-1)).toContain('already exists');
    expect(latestState(harness).items).toHaveLength(1);

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('Keep this release constraint');

    await harness.command('remove release');
    expect(latestState(harness).items).toEqual([]);
    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('no protected items');
  });

  it('persists add, remove, clear confirmation, and recovery changes', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    expect(harness.appendedEntries).toHaveLength(0);

    await harness.command('add first fact First item');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(latestState(harness).items.map((entry) => entry.id)).toEqual(['first']);

    await harness.command('remove first');
    expect(harness.appendedEntries).toHaveLength(2);
    expect(latestState(harness).items).toEqual([]);

    await harness.command('add second fact Second item');
    expect(harness.appendedEntries).toHaveLength(3);
    await harness.command('clear');
    expect(harness.appendedEntries).toHaveLength(3);
    expect(latestState(harness).items).toHaveLength(1);
    expect(harness.notifyMessages().at(-1)).toContain('clear --yes');

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(4);
    expect(latestState(harness).items).toEqual([]);

    await harness.command('recovery critical');
    expect(harness.appendedEntries).toHaveLength(5);
    expect(latestState(harness).recovery).toBe('critical');
  });

  it('reports status, recovery mode, invalid syntax, and invalid kinds through the UI', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected constraint --critical Do not change this');
    await harness.command('status');
    const status = harness.notifyMessages().at(-1) ?? '';
    expect(status).toContain('1 items');
    expect(status).toContain('1 critical');
    expect(status).toContain('recovery off');

    await harness.command('recovery critical');
    expect(harness.notifyMessages().at(-1)).toContain('critical');

    await harness.command('unknown-subcommand');
    expect(harness.notifyMessages().at(-1)).toContain('Usage: /context-guard');
    await harness.command('add invalid unsupported Some content');
    expect(harness.notifyMessages().at(-1)).toContain('Usage: /context-guard');
  });
});

describe('Pi context guard persistence', () => {
  it('restores the latest state on session_start', async () => {
    const original = new FakePiHarness();
    await original.start();
    await original.command('add restored goal --critical Continue this goal');
    await original.command('recovery critical');

    const restored = new FakePiHarness(original.getBranch());
    await restored.start();
    await restored.command('status');
    const status = restored.notifyMessages().at(-1) ?? '';
    expect(status).toContain('1 items');
    expect(status).toContain('1 critical');
    expect(status).toContain('recovery critical');
    await restored.command('list');
    expect(restored.notifyMessages().at(-1)).toContain('Continue this goal');
  });

  it('loads only the current branch and does not mix another branch or session', async () => {
    const current = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('current', 'Current branch item')]),
    );
    const other = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('other', 'Other session item')]),
    );
    const harness = new FakePiHarness([current]);
    await harness.start();
    await harness.command('list');

    const list = harness.notifyMessages().at(-1) ?? '';
    expect(list).toContain('Current branch item');
    expect(list).not.toContain('Other session item');
    expect(harness.getBranch()).not.toContain(other);
  });

  it('discards a malformed latest state without falling back to an older valid state', async () => {
    const oldContent = 'older valid content';
    const malformedContent = 'malformed private content';
    const older = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('older', oldContent)]),
    );
    const latest = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([
        {
          id: 'bad',
          kind: 'unsupported',
          content: malformedContent,
          critical: true,
        },
      ]),
    );
    const harness = new FakePiHarness([older, latest]);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifyMessages()[0]).toContain('discarded');
    expect(harness.notifyMessages()[0]).not.toContain(oldContent);
    expect(harness.notifyMessages()[0]).not.toContain(malformedContent);

    await harness.command('status');
    const status = harness.notifyMessages().at(-1) ?? '';
    expect(status).toContain('0 items');
    expect(status).toContain('degraded yes');
    expect(status).not.toContain(oldContent);
  });
});

describe('Pi context guard compaction lifecycle', () => {
  it('does not snapshot or verify when session_compact has no preceding before event', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected fact Current registry item');
    const notificationCount = harness.notifications.length;

    await harness.invoke('session_compact', compactEvent('without-before', 'Current registry item'));
    const result = await harness.invoke(
      'context',
      contextEvent([textMessage('Current registry item')]),
    );

    expect(result).toBeUndefined();
    expect(verificationMessages(harness)).toHaveLength(0);
    expect(harness.notifications.length).toBe(notificationCount + 1);
    expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
  });

  it('verifies once after compaction and consumes the pending verification on the first context event', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected fact Keep this literal item');
    const beforeLifecycle = harness.notifications.length;

    const first = await verifyAfterCompaction(
      harness,
      'compaction-once',
      [textMessage('Keep this literal item')],
    );
    const verificationCount = verificationMessages(harness).length;
    const second = await harness.invoke(
      'context',
      contextEvent([textMessage('missing now')]),
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(verificationCount).toBe(1);
    expect(verificationMessages(harness)).toHaveLength(1);
    expect(harness.notifications.length).toBeGreaterThan(beforeLifecycle);
  });

  it('clears pending state on session_start', async () => {
    await expectSessionResetClearsPending('session_start');
  });

  it('clears pending state on session_shutdown', async () => {
    await expectSessionResetClearsPending('session_shutdown');
  });

  it('uses a fresh snapshot after an earlier snapshot is invalidated and a new before event runs', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add first fact First snapshot item');
    await harness.invoke('session_before_compact');
    await harness.command('add second fact Second snapshot item');

    const result = await verifyAfterCompaction(
      harness,
      'fresh-snapshot',
      [textMessage('First snapshot item'), textMessage('Second snapshot item')],
    );

    expect(result).toBeUndefined();
    expect(verificationMessages(harness).at(-1)).toContain('2 preserved');
    expect(verificationMessages(harness).at(-1)).toContain('0 lost');
  });

  it('clears the pending snapshot for add, remove, clear, and recovery changes', async () => {
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('add new fact New registry item');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('remove existing');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('clear --yes');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('recovery critical');
    });
  });
});

describe('Pi context guard verification', () => {
  it('uses the system prompt and effective context messages instead of the compaction summary', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add from-system fact effective-system-text');
    await harness.command('add from-summary fact summary-only-text');
    harness.setSystemPrompt('The effective-system-text is in the current system prompt.');

    await verifyAfterCompaction(
      harness,
      'projection',
      [textMessage('ordinary current message')],
      'summary-only-text and effective-system-text were both in the summary',
    );

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('1 preserved');
    expect(reportNotification).toContain('1 lost');
  });

  it('projects text blocks from user, assistant, custom, and tool result messages while excluding images', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add user-item fact user-visible-text');
    await harness.command('add assistant-item fact assistant-visible-text');
    await harness.command('add custom-item fact custom-visible-text');
    await harness.command('add tool-item fact tool-visible-text');
    await harness.command('add image-item fact image-only-text');

    const messages = [
      textMessage('user-visible-text'),
      assistantMessage([block('assistant-visible-text'), image('image-only-text')]),
      customMessage([block('custom-visible-text')], { hidden: 'image-only-text' }),
      toolResultMessage([block('tool-visible-text'), image('image-only-text')]),
    ];
    await verifyAfterCompaction(harness, 'all-message-roles', messages);

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('4 preserved');
    expect(reportNotification).toContain('1 lost');
  });

  it('reports a paraphrased constraint as lost with the literal verifier', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add public-api constraint --critical Do not alter the public API');

    await verifyAfterCompaction(
      harness,
      'paraphrase',
      [textMessage('The public API must remain unchanged.')],
    );

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('0 preserved');
    expect(reportNotification).toContain('1 lost');
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('public-api');
  });

  it('reports only by default and injects nothing when recovery is off', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical constraint --critical Keep this critical item');

    const result = await verifyAfterCompaction(
      harness,
      'report-only',
      [textMessage('different context')],
    );

    expect(result).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(0);
  });
});

describe('Pi context guard recovery', () => {
  it('recovers only critical failures in one message using the pending snapshot', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical-one constraint --critical Before snapshot one');
    await harness.command('add critical-two constraint --critical Before snapshot two');
    await harness.command('add ordinary fact Before snapshot ordinary');
    await harness.command('recovery critical');
    await harness.invoke('session_before_compact');
    await harness.invoke('session_compact', compactEvent('recover-once'));

    await harness.command('remove critical-one');
    await harness.command('add critical-one constraint --critical After snapshot one');
    const result = await harness.invoke(
      'context',
      contextEvent([textMessage('none of the protected text is present')]),
    );
    await Promise.resolve();

    const returnedMessages = (result as { messages?: CandidateMessage[] } | undefined)?.messages;
    expect(returnedMessages).toHaveLength(2);
    const returnedRecovery = returnedMessages?.at(-1) as RecoveryMessage | undefined;
    expect(returnedRecovery?.content).toContain('Before snapshot one');
    expect(returnedRecovery?.content).toContain('Before snapshot two');
    expect(returnedRecovery?.content).not.toContain('Before snapshot ordinary');
    expect(returnedRecovery?.content).not.toContain('After snapshot one');

    expect(harness.sentMessages).toHaveLength(1);
    const sent = harness.sentMessages[0]?.message as {
      details?: { sourceCompactionId?: string; itemIds?: readonly string[] };
    } | undefined;
    expect(sent?.details?.sourceCompactionId).toBe('recover-once');
    expect(sent?.details?.itemIds).toEqual(['critical-one', 'critical-two']);
  });

  it('does not recover twice for one compaction but recovers again for a later compaction', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical constraint --critical Restore this item');
    await harness.command('recovery critical');

    const first = await verifyAfterCompaction(
      harness,
      'first-recovery',
      [textMessage('missing')],
    );
    await Promise.resolve();
    const sentAfterFirst = harness.sentMessages.length;
    const notificationCountAfterFirst = verificationMessages(harness).length;

    const second = await harness.invoke('context', contextEvent([textMessage('still missing')]));
    await Promise.resolve();
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(sentAfterFirst);
    expect(verificationMessages(harness)).toHaveLength(notificationCountAfterFirst);

    const later = await verifyAfterCompaction(
      harness,
      'later-recovery',
      [textMessage('missing again')],
    );
    await Promise.resolve();
    expect(later).toBeDefined();
    expect(harness.sentMessages).toHaveLength(sentAfterFirst + 1);
    const laterMessage = harness.sentMessages.at(-1)?.message as {
      details?: { sourceCompactionId?: string };
    } | undefined;
    expect(laterMessage?.details?.sourceCompactionId).toBe('later-recovery');
  });
});

describe('Pi context guard privacy', () => {
  it('keeps candidate text, protected content, recovery body, and console output private', async () => {
    const protectedContent = 'PRIVATE-PROTECTED-CONTENT';
    const candidateContent = 'PRIVATE-CANDIDATE-CONTEXT';
    const recoveryBody = `Protected context restored after compaction:\n\n- ${protectedContent}`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    try {
      const harness = new FakePiHarness();
      await harness.start();
      await harness.command(`add private constraint --critical ${protectedContent}`);
      await harness.command('recovery critical');
      harness.setSystemPrompt(candidateContent);
      await verifyAfterCompaction(
        harness,
        'privacy-lifecycle',
        [textMessage('not protected')],
        `${candidateContent} ${protectedContent}`,
      );
      await Promise.resolve();
      await harness.command('status');

      const uiOutput = [
        ...harness.notifyMessages(),
        ...harness.statuses.map((entry) => `${entry.key} ${entry.text ?? ''}`),
      ].join('\n');
      expect(uiOutput).not.toContain(candidateContent);
      expect(uiOutput).not.toContain(protectedContent);
      expect(uiOutput).not.toContain(recoveryBody);

      const sentMessage = harness.sentMessages[0]?.message as {
        details?: unknown;
      } | undefined;
      const details = JSON.stringify(sentMessage?.details);
      expect(details).not.toContain(candidateContent);
      expect(details).not.toContain(protectedContent);
      expect(details).not.toContain(recoveryBody);

      const malformed = new FakePiHarness([
        customEntry(
          STATE_CUSTOM_TYPE,
          stateData([
            item('malformed', protectedContent, true),
            { id: 'invalid', kind: 'unsupported', content: protectedContent },
          ]),
        ),
      ]);
      await malformed.start();
      expect(malformed.notifyMessages().join('\n')).not.toContain(protectedContent);

      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});
