export type HandoffErrorCode = 'invalid_input';

export interface HandoffPacket {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: string;
  readonly destination?: string;
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly openItems?: readonly string[];
  readonly evidenceReferences?: readonly string[];
}

export interface HandoffInput {
  schemaVersion: 1;
  id: string;
  source: string;
  destination?: string;
  goal: string;
  constraints?: readonly string[];
  openItems?: readonly string[];
  evidenceReferences?: readonly string[];
}
