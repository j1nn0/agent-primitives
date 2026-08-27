import { createHandoff } from '@j1nn0/agent-handoff';
import type { HandoffInput, HandoffPacket } from '@j1nn0/agent-handoff';

const input: HandoffInput = {
  schemaVersion: 1,
  id: 'pr-42-review-handoff',
  source: 'engineer',
  destination: 'reviewer',
  goal: 'Review pull request 42 before merge.',
  constraints: ['Check the diff.', 'Run the relevant tests.', 'Confirm CI is green.'],
  openItems: ['Confirm the deployment note.'],
  evidenceReferences: ['tests-run-123', 'lint-pass-456'],
};

const packet: HandoffPacket = createHandoff(input);
console.log(packet);

for (const constraint of packet.constraints ?? []) {
  console.log('constraint:', constraint);
}
for (const openItem of packet.openItems ?? []) {
  console.log('open item:', openItem);
}
for (const evidenceReference of packet.evidenceReferences ?? []) {
  console.log('evidence reference:', evidenceReference);
}
