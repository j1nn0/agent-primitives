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
  readonly context: ExtensionContext;
  private branch: SessionEntry[];
  private systemPrompt = '';

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

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
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
      },
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
