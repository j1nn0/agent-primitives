import {
  createAgentState,
  restoreAgentState,
  summarizeAgentState,
} from '@j1nn0/agent-state';

const state = createAgentState({
  objective: 'Ship the migration safely.',
});

state.addWorkItem({
  id: 'schema',
  content: 'Update the database schema.',
});
state.addWorkItem({
  id: 'cutover',
  content: 'Run the production cutover.',
});
state.addWorkItem({
  id: 'rollback',
  content: 'Document the rollback path.',
});

state.setWorkItemStatus('schema', 'in_progress');
state.setWorkItemStatus('cutover', 'done');
state.setWorkItemStatus('rollback', 'blocked');
state.addDecision({
  id: 'database',
  content: 'Use the primary database for writes.',
});

const snapshot = state.snapshot();
const summary = summarizeAgentState(snapshot);
const restored = restoreAgentState(JSON.parse(JSON.stringify(snapshot)));

console.log('snapshot:', snapshot);
console.log('summary:', summary);
console.log('restored:', restored.snapshot());
