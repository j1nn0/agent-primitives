import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import extension from '../src/extension.js';

export interface Notification {
  readonly message: string;
  readonly type: 'info' | 'warning' | 'error' | undefined;
}

export interface StatusUpdate {
  readonly key: string;
  readonly text: string | undefined;
}

export interface AppendedEntry {
  readonly customType: string;
  readonly data: unknown;
}

export interface SentMessage {
  readonly message: unknown;
  readonly options: unknown;
}

export interface ModelCompleteCall {
  readonly model: unknown;
  readonly context: unknown;
  readonly options: unknown;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export class FakePiHarness {
  readonly handlers = new Map<string, EventHandler>();
  readonly commands = new Map<string, CommandHandler>();
  readonly notifications: Notification[] = [];
  readonly statuses: StatusUpdate[] = [];
  readonly appendedEntries: AppendedEntry[] = [];
  readonly sentMessages: SentMessage[] = [];
  readonly completeCalls: ModelCompleteCall[] = [];
  context: ExtensionContext;
  private branch: SessionEntry[];
  private sessionId = 'fake-session';
  private sessionIdFailure = false;
  private systemPrompt = '';
  private modelValue: unknown = {
    id: 'fake-model',
    api: 'openai-responses',
    reasoning: true,
  };
  private completionResponse: unknown = {
    stopReason: 'stop',
    content: [
      {
        type: 'text',
        text: '{"schemaVersion":1,"add":[],"removeAutoItemIds":[]}',
      },
    ],
  };
  private completionError: unknown;

  readonly modelRegistry = {
    complete: async (
      model: unknown,
      context: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      this.completeCalls.push({ model, context, options });
      if (this.completionError !== undefined) {
        throw this.completionError;
      }
      return this.completionResponse;
    },
  };

  readonly api: ExtensionAPI;

  constructor(branch: readonly SessionEntry[] = []) {
    this.branch = [...branch];
    this.context = this.createContext();
    this.api = {
      on: (event: string, handler: EventHandler): void => {
        this.handlers.set(event, handler);
      },
      registerCommand: (
        name: string,
        options: { handler: CommandHandler },
      ): void => {
        this.commands.set(name, options.handler);
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.appendedEntries.push({ customType, data });
        this.branch.push({
          type: 'custom',
          customType,
          data,
        } as SessionEntry);
      },
      sendMessage: (message: unknown, options: unknown): void => {
        this.sentMessages.push({ message, options });
      },
    } as unknown as ExtensionAPI;

    extension(this.api);
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  setSessionIdFailure(failure: boolean): void {
    this.sessionIdFailure = failure;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setModelAvailable(available: boolean): void {
    this.modelValue = available
      ? { id: 'fake-model', api: 'openai-responses', reasoning: true }
      : undefined;
    this.context = this.createContext();
  }

  setCompletionResponse(response: unknown): void {
    this.completionError = undefined;
    this.completionResponse = response;
  }

  setCompletionError(error: unknown): void {
    this.completionError = error;
  }

  setCompletionDeferred(): {
    readonly promise: Promise<unknown>;
    readonly resolve: (response: unknown) => void;
    readonly reject: (error: unknown) => void;
  } {
    let resolvePromise: (response: unknown) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.setCompletionResponse(promise);
    return {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
  }

  setBranch(entries: readonly SessionEntry[]): void {
    this.branch = [...entries];
  }

  getBranch(): readonly SessionEntry[] {
    return this.branch;
  }

  async start(): Promise<void> {
    await this.invoke('session_start', {
      type: 'session_start',
      reason: 'startup',
    });
  }

  async command(args: string): Promise<void> {
    const handler = this.commands.get('context-guard');
    if (handler === undefined) {
      throw new Error('context-guard command was not registered');
    }
    await handler(args, this.context as ExtensionCommandContext);
  }

  async invoke(event: string, payload: unknown = undefined): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (handler === undefined) {
      throw new Error(`event handler was not registered: ${event}`);
    }
    return await handler(payload, this.context);
  }

  async startTurn(turnIndex = 0): Promise<void> {
    await this.invoke('turn_start', {
      type: 'turn_start',
      turnIndex,
      timestamp: 1,
    });
  }

  async toolResult(
    toolCallId: string,
    toolName: string,
    content: readonly unknown[],
  ): Promise<void> {
    await this.invoke('tool_result', {
      type: 'tool_result',
      toolCallId,
      toolName,
      input: {},
      content,
      isError: false,
    });
  }

  async endTurn(turnIndex = 0): Promise<void> {
    await this.invoke('turn_end', {
      type: 'turn_end',
      turnIndex,
      message: {
        role: 'assistant',
        content: [],
        timestamp: 2,
      },
      toolResults: [],
    });
  }

  notifyMessages(): readonly string[] {
    return this.notifications.map((entry) => entry.message);
  }

  private createContext(): ExtensionContext {
    return {
      ui: {
        notify: (
          message: string,
          type?: 'info' | 'warning' | 'error',
        ): void => {
          this.notifications.push({ message, type });
        },
        setStatus: (key: string, text: string | undefined): void => {
          this.statuses.push({ key, text });
        },
      },
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
        getSessionId: (): string => {
          if (this.sessionIdFailure) {
            throw new Error('stale session');
          }
          return this.sessionId;
        },
      },
      model: this.modelValue,
      modelRegistry: this.modelRegistry,
      getSystemPrompt: (): string => this.systemPrompt,
    } as unknown as ExtensionContext;
  }
}

export function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: 'custom',
    id: `${customType}-entry`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  } as SessionEntry;
}
