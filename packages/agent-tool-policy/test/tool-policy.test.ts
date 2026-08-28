import { describe, expect, it } from 'vitest';
import * as toolPolicyApi from '../src/index.js';
import {
  ToolPolicyError,
  judgeToolPolicy,
} from '../src/index.js';
import type { ToolPolicyErrorCode } from '../src/index.js';

function expectToolPolicyError(
  action: () => unknown,
  code: ToolPolicyErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ToolPolicyError);
  expect((thrown as ToolPolicyError).name).toBe('ToolPolicyError');
  expect((thrown as ToolPolicyError).code).toBe(code);
  expect((thrown as ToolPolicyError).message).toBe(
    'Invalid tool policy input.',
  );
}

describe('agent tool policy public boundary', () => {
  it('exports only the public runtime values', () => {
    expect(Object.keys(toolPolicyApi).sort()).toEqual([
      'ToolPolicyError',
      'judgeToolPolicy',
    ]);
  });

  it('reports an explicit allow rule', () => {
    expect(
      judgeToolPolicy({
        tool: 'mcp__srv__search',
        policy: { default: 'deny', allow: ['mcp__srv__search'], deny: [] },
      }),
    ).toEqual({ outcome: 'allowed', source: 'rule' });
  });

  it('reports an explicit deny rule', () => {
    expect(
      judgeToolPolicy({
        tool: 'shell',
        policy: { default: 'allow', allow: [], deny: ['shell'] },
      }),
    ).toEqual({ outcome: 'denied', source: 'rule' });
  });

  it('reports an explicit requires-approval rule', () => {
    expect(
      judgeToolPolicy({
        tool: 'mcp__srv__write',
        policy: {
          default: 'deny',
          allow: [],
          deny: [],
          requiresApproval: ['mcp__srv__write'],
        },
      }),
    ).toEqual({ outcome: 'requires_approval', source: 'rule' });
  });

  it('uses a declared allow default for an unmatched tool', () => {
    expect(
      judgeToolPolicy({
        tool: 'search',
        policy: { default: 'allow', allow: [], deny: [] },
      }),
    ).toEqual({ outcome: 'allowed', source: 'default' });
  });

  it('uses a declared deny default for an unmatched tool', () => {
    expect(
      judgeToolPolicy({
        tool: 'search',
        policy: { default: 'deny', allow: [], deny: [] },
      }),
    ).toEqual({ outcome: 'denied', source: 'default' });
  });

  it('uses a declared requires-approval default for an unmatched tool', () => {
    expect(
      judgeToolPolicy({
        tool: 'search',
        policy: { default: 'requires_approval', allow: [], deny: [] },
      }),
    ).toEqual({ outcome: 'requires_approval', source: 'default' });
  });

  it('treats an omitted requiresApproval list as empty', () => {
    expect(
      judgeToolPolicy({
        tool: 'search',
        policy: { default: 'deny', allow: [], deny: [] },
      }),
    ).toEqual({ outcome: 'denied', source: 'default' });
  });

  it('matches exact names case-sensitively and preserves MCP names', () => {
    expect(
      judgeToolPolicy({
        tool: 'bash',
        policy: { default: 'requires_approval', allow: [], deny: ['Bash'] },
      }),
    ).toEqual({ outcome: 'requires_approval', source: 'default' });
    expect(
      judgeToolPolicy({
        tool: 'mcp__srv__search',
        policy: {
          default: 'deny',
          allow: ['mcp__srv__search'],
          deny: [],
        },
      }),
    ).toEqual({ outcome: 'allowed', source: 'rule' });
  });

  it('allows empty policy lists', () => {
    expect(
      judgeToolPolicy({
        tool: 'search',
        policy: {
          default: 'allow',
          allow: [],
          deny: [],
          requiresApproval: [],
        },
      }),
    ).toEqual({ outcome: 'allowed', source: 'default' });
  });

  it('rejects duplicate entries within every policy list', () => {
    expectToolPolicyError(
      () =>
        judgeToolPolicy({
          tool: 'tool',
          policy: { default: 'allow', allow: ['tool', 'tool'], deny: [] },
        }),
      'invalid_input',
    );
    expectToolPolicyError(
      () =>
          judgeToolPolicy({
            tool: 'tool',
            policy: { default: 'allow', allow: [], deny: ['tool', 'tool'] },
          }),
      'invalid_input',
    );
    expectToolPolicyError(
      () =>
        judgeToolPolicy({
          tool: 'tool',
          policy: {
            default: 'allow',
            allow: [],
            deny: [],
            requiresApproval: ['tool', 'tool'],
          },
        }),
      'invalid_input',
    );
  });

  it('rejects every cross-list overlap combination', () => {
    const policies: unknown[] = [
      {
        default: 'allow',
        allow: ['tool'],
        deny: ['tool'],
        requiresApproval: [],
      },
      {
        default: 'allow',
        allow: ['tool'],
        deny: [],
        requiresApproval: ['tool'],
      },
      {
        default: 'allow',
        allow: [],
        deny: ['tool'],
        requiresApproval: ['tool'],
      },
      {
        default: 'allow',
        allow: ['tool'],
        deny: ['tool'],
        requiresApproval: ['tool'],
      },
    ];

    for (const policy of policies) {
      expectToolPolicyError(
        () => judgeToolPolicy({ tool: 'tool', policy }),
        'invalid_input',
      );
    }
  });

  it('rejects missing policy, tool, and required policy fields', () => {
    const validPolicy = { default: 'deny', allow: [], deny: [] };
    const invalidInputs: unknown[] = [
      { tool: 'tool' },
      { policy: validPolicy },
      { tool: 'tool', policy: { allow: [], deny: [] } },
      { tool: 'tool', policy: { default: 'deny', deny: [] } },
      { tool: 'tool', policy: { default: 'deny', allow: [] } },
    ];

    for (const input of invalidInputs) {
      expectToolPolicyError(() => judgeToolPolicy(input), 'invalid_input');
    }
  });

  it('rejects malformed arrays, whitespace names, and undefined values', () => {
    const invalidInputs: unknown[] = [
      {
        tool: 'tool',
        policy: { default: 'deny', allow: 'tool', deny: [] },
      },
      {
        tool: 'tool',
        policy: { default: 'deny', allow: [1], deny: [] },
      },
      {
        tool: 'tool',
        policy: { default: 'deny', allow: ['tool name'], deny: [] },
      },
      {
        tool: 'tool',
        policy: {
          default: 'deny',
          allow: [],
          deny: [],
          requiresApproval: undefined,
        },
      },
      {
        tool: undefined,
        policy: { default: 'deny', allow: [], deny: [] },
      },
    ];

    for (const input of invalidInputs) {
      expectToolPolicyError(() => judgeToolPolicy(input), 'invalid_input');
    }
  });

  it('rejects unknown top-level and policy keys', () => {
    expectToolPolicyError(
      () =>
        judgeToolPolicy({
          tool: 'tool',
          policy: { default: 'deny', allow: [], deny: [] },
          extra: true,
        }),
      'invalid_input',
    );
    expectToolPolicyError(
      () =>
        judgeToolPolicy({
          tool: 'tool',
          policy: {
            default: 'deny',
            allow: [],
            deny: [],
            extra: true,
          },
        }),
      'invalid_input',
    );
  });

  it('rejects non-object inputs', () => {
    for (const input of [null, [], 'tool', 1, undefined]) {
      expectToolPolicyError(() => judgeToolPolicy(input), 'invalid_input');
    }
  });

  it('throws the documented ToolPolicyError shape for invalid input', () => {
    expectToolPolicyError(
      () =>
        judgeToolPolicy({
          tool: '',
          policy: { default: 'deny', allow: [], deny: [] },
        }),
      'invalid_input',
    );
  });

  it('is deterministic and returns a fresh exact verdict object', () => {
    const input = {
      tool: 'search',
      policy: { default: 'allow', allow: [], deny: [] },
    };
    const first = judgeToolPolicy(input);
    const second = judgeToolPolicy(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.keys(first)).toEqual(['outcome', 'source']);
  });

  it('does not mutate the caller input', () => {
    const input = {
      tool: 'mcp__srv__write',
      policy: {
        default: 'deny',
        allow: ['mcp__srv__search'],
        deny: [],
        requiresApproval: ['mcp__srv__write'],
      },
    };
    const before = structuredClone(input);

    judgeToolPolicy(input);

    expect(input).toEqual(before);
  });

  it('lets a requiresApproval rule beat an allow default', () => {
    expect(
      judgeToolPolicy({
        tool: 'mcp__srv__write',
        policy: {
          default: 'allow',
          allow: [],
          deny: [],
          requiresApproval: ['mcp__srv__write'],
        },
      }),
    ).toEqual({ outcome: 'requires_approval', source: 'rule' });
  });
});
