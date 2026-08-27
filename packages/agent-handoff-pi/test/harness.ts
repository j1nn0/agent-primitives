import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import extension from '../src/extension.js';
import { COMMAND_NAME } from '../src/command.js';

export interface Notification {
  readonly message: string;
  readonly type: 'info' | 'warning' | 'error' | undefined;
}

export interface AppendedEntry {
  readonly customType: string;
  readonly data: unknown;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

export class FakePiHarness {
  readonly handlers = new Map<string, EventHandler>();
  readonly commands = new Map<string, CommandHandler>();
  readonly tools: Map<string, ToolDefinition> = new Map();
  readonly notifications: Notification[] = [];
  readonly appendedEntries: AppendedEntry[] = [];
  readonly context: ExtensionContext;
  readonly api: ExtensionAPI;
  private branch: unknown[];

  constructor(branch: readonly unknown[] = []) {
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
      registerTool: (tool: ToolDefinition): void => {
        this.tools.set(tool.name, tool);
      },
      appendEntry: (customType: string, data?: unknown): void => {
        const entry = { customType, data };
        this.appendedEntries.push(entry);
        this.branch.push({ type: 'custom', customType, data });
      },
    } as unknown as ExtensionAPI;

    extension(this.api);
  }

  setBranch(entries: readonly unknown[]): void {
    this.branch = [...entries];
  }

  getBranch(): readonly unknown[] {
    return this.branch;
  }

  async start(reason = 'startup'): Promise<void> {
    await this.invoke('session_start', { type: 'session_start', reason });
  }

  async command(args: string): Promise<void> {
    const handler = this.commands.get(COMMAND_NAME);
    if (handler === undefined) {
      throw new Error(`${COMMAND_NAME} command was not registered`);
    }
    await handler(args, this.context as ExtensionCommandContext);
  }

  async executeTool(
    name: string,
    params: unknown = {},
  ): Promise<AgentToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`tool was not registered: ${name}`);
    }
    return await tool.execute('test-call', params as never, undefined, undefined, this.context);
  }

  async invoke(event: string, payload: unknown = undefined): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (handler === undefined) {
      throw new Error(`event handler was not registered: ${event}`);
    }
    return await handler(payload, this.context);
  }

  private createContext(): ExtensionContext {
    return {
      ui: {
        notify: (message: string, type?: 'info' | 'warning' | 'error'): void => {
          this.notifications.push({ message, type });
        },
      },
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch as SessionEntry[],
      },
    } as unknown as ExtensionContext;
  }
}
