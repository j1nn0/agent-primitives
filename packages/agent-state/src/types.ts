export type WorkItemStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export type AgentStateErrorCode =
  | 'invalid_input'
  | 'duplicate_item_id'
  | 'unknown_item_id';

export interface WorkItemInput {
  id: string;
  content: string;
  status?: WorkItemStatus;
}

export interface WorkItem {
  readonly id: string;
  readonly content: string;
  readonly status: WorkItemStatus;
}

export interface DecisionInput {
  id: string;
  content: string;
}

export interface Decision {
  readonly id: string;
  readonly content: string;
}

export interface AgentStateInput {
  objective?: string;
  workItems?: WorkItemInput[];
  decisions?: DecisionInput[];
}

export interface AgentStateSnapshot {
  readonly schemaVersion: 1;
  readonly objective?: string;
  readonly workItems: readonly WorkItem[];
  readonly decisions: readonly Decision[];
}

export interface AgentStateSummary {
  readonly open: number;
  readonly in_progress: number;
  readonly blocked: number;
  readonly done: number;
  readonly total: number;
}

export interface AgentState {
  addWorkItem(item: WorkItemInput): WorkItem;
  setWorkItemStatus(id: string, status: WorkItemStatus): WorkItem;
  getWorkItem(id: string): WorkItem | undefined;
  listWorkItems(): readonly WorkItem[];
  removeWorkItem(id: string): boolean;
  addDecision(decision: DecisionInput): Decision;
  listDecisions(): readonly Decision[];
  snapshot(): AgentStateSnapshot;
}
