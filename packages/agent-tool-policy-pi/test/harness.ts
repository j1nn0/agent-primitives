import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIDialogOptions,
  SessionEntry,
  ToolCallEventResult,
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

export interface ConfirmationCall {
  readonly title: string;
  readonly message: string;
  readonly options: ExtensionUIDialogOptions | undefined;
}

export type ConfirmHandler = (
  title: string,
  message: string,
  options: ExtensionUIDialogOptions | undefined,
) => Promise<boolean | undefined> | boolean | undefined;

export interface ToolCallOptions {
  readonly hasUI?: boolean;
  readonly signal?: AbortSignal;
  readonly confirm?: ConfirmHandler;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

export class FakePiHarness {
  readonly handlers = new Map<string, EventHandler>();
  readonly commands = new Map<string, CommandHandler>();
  readonly tools: Map<string, ToolDefinition> = new Map();
  readonly notifications: Notification[] = [];
  readonly appendedEntries: AppendedEntry[] = [];
  readonly confirmationCalls: ConfirmationCall[] = [];
  readonly context: ExtensionContext;
  readonly api: ExtensionAPI;
  private branch: unknown[];
  private hasUI = true;
  private signal: AbortSignal | undefined = new AbortController().signal;
  private confirmHandler: ConfirmHandler = async () => false;
  private nextToolCallId = 1;

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

  setHasUI(hasUI: boolean): void {
    this.hasUI = hasUI;
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  setConfirm(handler: ConfirmHandler): void {
    this.confirmHandler = handler;
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

  async executeToolCall(
    name: string,
    input: Record<string, unknown> = {},
    options: ToolCallOptions = {},
  ): Promise<ToolCallEventResult | undefined> {
    const handler = this.handlers.get('tool_call');
    if (handler === undefined) {
      throw new Error('event handler was not registered: tool_call');
    }

    const event = {
      type: 'tool_call',
      toolName: name,
      toolCallId: `test-call-${this.nextToolCallId}`,
      input,
    };
    this.nextToolCallId += 1;
    return (await handler(event, this.createContext(options))) as ToolCallEventResult | undefined;
  }

  async invokeToolCall(
    name: string,
    input: Record<string, unknown> = {},
    options: ToolCallOptions = {},
  ): Promise<ToolCallEventResult | undefined> {
    return await this.executeToolCall(name, input, options);
  }

  async executeTool(
    name: string,
    input: Record<string, unknown> = {},
    options: ToolCallOptions = {},
  ): Promise<ToolCallEventResult | undefined> {
    return await this.executeToolCall(name, input, options);
  }

  async invoke(
    event: string,
    payload: unknown = undefined,
    ctx: ExtensionContext = this.context,
  ): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (handler === undefined) {
      throw new Error(`event handler was not registered: ${event}`);
    }
    return await handler(payload, ctx);
  }

  private createContext(options: ToolCallOptions = {}): ExtensionContext {
    const getHasUI = (): boolean => options.hasUI ?? this.hasUI;
    const getSignal = (): AbortSignal | undefined => options.signal ?? this.signal;

    return {
      get hasUI(): boolean {
        return getHasUI();
      },
      get signal(): AbortSignal | undefined {
        return getSignal();
      },
      ui: {
        confirm: async (
          title: string,
          message: string,
          dialogOptions?: ExtensionUIDialogOptions,
        ): Promise<boolean | undefined> => {
          this.confirmationCalls.push({ title, message, options: dialogOptions });
          const confirm = options.confirm ?? this.confirmHandler;
          return await confirm(title, message, dialogOptions);
        },
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
