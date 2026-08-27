import { HandoffError } from './errors.js';
import { validateHandoffInput } from './validation.js';
import type { HandoffInput, HandoffPacket } from './types.js';

function invalidInput(): never {
  throw new HandoffError('invalid_input', 'Invalid handoff input.');
}

function freshPacket(input: HandoffInput): HandoffPacket {
  return {
    schemaVersion: input.schemaVersion,
    id: input.id,
    source: input.source,
    ...(input.destination === undefined ? {} : { destination: input.destination }),
    goal: input.goal,
    ...(input.constraints === undefined ? {} : { constraints: [...input.constraints] }),
    ...(input.openItems === undefined ? {} : { openItems: [...input.openItems] }),
    ...(input.evidenceReferences === undefined
      ? {}
      : { evidenceReferences: [...input.evidenceReferences] }),
  };
}

export function createHandoff(input: unknown): HandoffPacket {
  try {
    const validated = validateHandoffInput(input);
    return freshPacket(validated);
  } catch (error) {
    if (error instanceof HandoffError) {
      throw error;
    }
    return invalidInput();
  }
}
