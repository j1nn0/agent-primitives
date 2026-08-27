import type { HandoffPacket } from '@j1nn0/agent-handoff';
import type { HandoffState } from './state.js';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatArray(label: string, items: readonly string[] | undefined): string[] {
  if (items === undefined || items.length === 0) {
    return [`${label}: none.`];
  }
  return [`${label}:`, ...items.map((item) => `- ${item}`)];
}

export function formatHandoffPacket(packet: HandoffPacket): string {
  const lines: string[] = [];
  lines.push(`Packet: ${packet.id}`);
  lines.push(`  Source: ${packet.source}`);
  lines.push(`  Destination: ${packet.destination ?? 'none'}`);
  lines.push(`  Goal: ${packet.goal}`);
  lines.push(...formatArray('  Constraints', packet.constraints));
  lines.push(...formatArray('  Open items', packet.openItems));
  lines.push(...formatArray('  Evidence references', packet.evidenceReferences));
  return lines.join('\n');
}

export function formatHandoffState(state: HandoffState): string {
  const count = state.packets.length;
  const lines: string[] = [
    `Agent Handoff: ${count} ${pluralize(count, 'packet')} in the current session.`,
  ];

  if (count === 0) {
    lines.push('Packets: none.');
  } else {
    lines.push('Packets:');
    for (const packet of state.packets) {
      const destination = packet.destination === undefined ? '' : ` -> ${packet.destination}`;
      lines.push(`- ${packet.id}: ${packet.source}${destination} | goal: ${packet.goal}`);
    }
  }

  lines.push(
    'Policy: explicit caller-declared packets only; no automatic generation, no successor selection, no completion judgment.',
  );
  lines.push(
    'Privacy: all packet fields are caller-controlled and may carry sensitive content; scrub before transmission. No automatic redaction.',
  );

  return lines.join('\n');
}
