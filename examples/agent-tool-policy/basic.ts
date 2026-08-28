import { judgeToolPolicy } from '@j1nn0/agent-tool-policy';

const policy = {
  default: 'deny',
  allow: ['mcp__srv__search'],
  deny: ['Bash'],
  requiresApproval: ['mcp__srv__write'],
} as const;

console.log(
  'search:',
  judgeToolPolicy({ tool: 'mcp__srv__search', policy }),
);
console.log(
  'write:',
  judgeToolPolicy({ tool: 'mcp__srv__write', policy }),
);
console.log('shell:', judgeToolPolicy({ tool: 'shell', policy }));
