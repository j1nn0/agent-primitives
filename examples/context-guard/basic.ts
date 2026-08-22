import {
  createContextGuard,
  createLiteralVerifier,
  verifyContext,
} from '@j1nn0/agent-context-guard';

const guard = createContextGuard();
guard.add({
  id: 'goal',
  kind: 'goal',
  content: 'Ship the migration safely.',
});
guard.add({
  id: 'constraint',
  kind: 'constraint',
  content: 'Do not expose credentials.',
  critical: true,
});

const snapshot = guard.snapshot();
const compactedContext = 'The goal remains: Ship the migration safely.';
const report = await verifyContext({
  snapshot,
  context: compactedContext,
  verifier: createLiteralVerifier(),
});

console.log('ok:', report.ok);
console.log('preserved:', report.preserved);
console.log('changed:', report.changed);
console.log('lost:', report.lost);
console.log('unknown:', report.unknown);
console.log('criticalFailures:', report.criticalFailures);
