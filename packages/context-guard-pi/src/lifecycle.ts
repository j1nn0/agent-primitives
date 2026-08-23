import {
  createLiteralVerifier,
  verifyContext,
} from '@j1nn0/agent-context-guard';
import type {
  ContextGuard,
  ContextItem,
  ContextSnapshot,
  VerificationReport,
} from '@j1nn0/agent-context-guard';
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
} from '@earendil-works/pi-coding-agent';
import type { LastVerification, RecoveryMode } from './types.js';

type CandidateMessage = ContextEvent['messages'][number];

// Pi 0.84.2 declares ContextEventResult in dist/core/extensions/types.d.ts but
// does not re-export it from the package root, so it is mirrored here with the
// message type still taken from ContextEvent.
type ContextEventResult = { messages?: ContextEvent['messages'] };

type RecoveryMessage = Extract<CandidateMessage, { role: 'custom' }>;

type TextBlock = {
  readonly type: 'text';
  readonly text: string;
};

interface LifecycleDependencies {
  readonly pi: ExtensionAPI;
  readonly getGuard: () => ContextGuard;
  readonly getRecoveryMode: () => RecoveryMode;
  /**
   * Whether recovery may re-inject one item. Verification still reports every
   * item honestly; this only decides what is worth putting back, so a
   * discovery someone retired or superseded stops returning after compaction.
   */
  readonly isRecoverableItem: (itemId: string) => boolean;
}

export interface LifecycleController {
  clearPendingSnapshot(): void;
  resetForSession(): void;
  captureSnapshot(): void;
  handleCompaction(event: SessionCompactEvent, ctx: ExtensionContext): void;
  handleContext(
    event: ContextEvent,
    ctx: ExtensionContext,
  ): Promise<ContextEventResult | undefined>;
  getLastVerification(): LastVerification | undefined;
  getLastUnverifiableCompactionId(): string | undefined;
}

interface PendingVerification {
  readonly compactionId: string;
  readonly snapshot: ContextSnapshot;
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const block = value as Record<string, unknown>;
  return block.type === 'text' && typeof block.text === 'string';
}

function projectContent(content: unknown): readonly string[] {
  if (typeof content === 'string') {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block) =>
    isTextBlock(block) ? [block.text] : [],
  );
}

function projectMessage(message: CandidateMessage): readonly string[] {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'custom':
    case 'toolResult':
      return projectContent(message.content);
    case 'bashExecution':
      return message.excludeFromContext
        ? []
        : [message.command, message.output];
    case 'branchSummary':
    case 'compactionSummary':
      return [message.summary];
    default:
      return [];
  }
}

function projectContext(
  systemPrompt: string,
  messages: readonly CandidateMessage[],
): string {
  return [systemPrompt, ...messages.flatMap(projectMessage)].join('\n');
}

function formatVerificationNotification(report: VerificationReport): string {
  const criticalFailureLabel =
    report.criticalFailures.length === 1
      ? 'critical failure'
      : 'critical failures';
  return `Context Guard: ${report.preserved.length} preserved, ${report.lost.length} lost, ${report.criticalFailures.length} ${criticalFailureLabel}.`;
}

function createRecoveryMessage(
  content: string,
  details: {
    readonly schemaVersion: 1;
    readonly sourceCompactionId: string;
    readonly itemIds: readonly string[];
  },
): RecoveryMessage {
  return {
    role: 'custom',
    customType: 'agent-context-guard-recovery',
    content,
    display: false,
    details,
    timestamp: Date.now(),
  };
}

function recoveryContent(items: readonly ContextItem[]): string {
  return [
    'Protected context restored after compaction:',
    '',
    ...items.map((item) => `- ${item.content}`),
  ].join('\n');
}

export function createLifecycle(
  dependencies: LifecycleDependencies,
): LifecycleController {
  let pendingSnapshot: ContextSnapshot | undefined;
  let pendingVerification: PendingVerification | undefined;
  let lastVerification: LastVerification | undefined;
  let lastUnverifiableCompactionId: string | undefined;
  const recoveredCompactions = new Set<string>();
  const verifier = createLiteralVerifier();

  function clearPendingSnapshot(): void {
    pendingSnapshot = undefined;
  }

  function resetForSession(): void {
    clearPendingSnapshot();
    pendingVerification = undefined;
    lastVerification = undefined;
    lastUnverifiableCompactionId = undefined;
    recoveredCompactions.clear();
  }

  function captureSnapshot(): void {
    // Always replace the prior snapshot: a failed compaction cannot leave a
    // stale snapshot available for a later compaction cycle.
    clearPendingSnapshot();
    pendingSnapshot = dependencies.getGuard().snapshot();
  }

  function handleCompaction(
    event: SessionCompactEvent,
    ctx: ExtensionContext,
  ): void {
    const snapshot = pendingSnapshot;
    pendingVerification = undefined;
    clearPendingSnapshot();

    if (snapshot === undefined) {
      lastUnverifiableCompactionId = event.compactionEntry.id;
      ctx.ui.notify(
        'Context Guard: compaction could not be verified because no pre-compaction snapshot was available.',
        'warning',
      );
      return;
    }

    lastUnverifiableCompactionId = undefined;
    pendingVerification = {
      compactionId: event.compactionEntry.id,
      snapshot,
    };
  }

  async function handleContext(
    event: ContextEvent,
    ctx: ExtensionContext,
  ): Promise<ContextEventResult | undefined> {
    const verification = pendingVerification;
    pendingVerification = undefined;

    if (verification === undefined) {
      return undefined;
    }

    const report = await verifyContext({
      snapshot: verification.snapshot,
      context: projectContext(ctx.getSystemPrompt(), event.messages),
      verifier,
    });
    lastUnverifiableCompactionId = undefined;
    lastVerification = {
      compactionId: verification.compactionId,
      report,
    };
    ctx.ui.notify(formatVerificationNotification(report), 'info');

    if (dependencies.getRecoveryMode() !== 'critical') {
      return undefined;
    }

    if (recoveredCompactions.has(verification.compactionId)) {
      return undefined;
    }

    const criticalItems = report.criticalFailures.flatMap((itemId) => {
      if (!dependencies.isRecoverableItem(itemId)) {
        return [];
      }
      const item = verification.snapshot.items.find(
        (candidate) => candidate.id === itemId,
      );
      return item === undefined ? [] : [item];
    });
    if (criticalItems.length === 0) {
      return undefined;
    }

    recoveredCompactions.add(verification.compactionId);
    const content = recoveryContent(criticalItems);
    const itemIds = criticalItems.map((item) => item.id);
    const details = {
      schemaVersion: 1 as const,
      sourceCompactionId: verification.compactionId,
      itemIds,
    };
    const recoveryMessage = createRecoveryMessage(content, details);

    // Deliver the persisted copy after this handler returns. Sending while Pi
    // is still assembling the imminent call would mutate session state from
    // inside its own dispatch; the returned messages already cover that call.
    queueMicrotask(() => {
      dependencies.pi.sendMessage(
        {
          customType: 'agent-context-guard-recovery',
          content,
          display: false,
          details,
        },
        { triggerTurn: false },
      );
    });

    return {
      messages: [...event.messages, recoveryMessage],
    };
  }

  return {
    clearPendingSnapshot,
    resetForSession,
    captureSnapshot,
    handleCompaction,
    handleContext,
    getLastVerification: (): LastVerification | undefined =>
      lastVerification,
    getLastUnverifiableCompactionId: (): string | undefined =>
      lastUnverifiableCompactionId,
  };
}
