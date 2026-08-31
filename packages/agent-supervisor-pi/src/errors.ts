export type SupervisorContractErrorCode =
  | 'invalid_json_value'
  | 'invalid_id'
  | 'invalid_observation'
  | 'invalid_intervention'
  | 'invalid_descriptor'
  | 'duplicate_feature'
  | 'invalid_fact'
  | 'invalid_state'
  | 'invalid_dispatch';

export class SupervisorContractError extends Error {
  readonly code: SupervisorContractErrorCode;

  constructor(code: SupervisorContractErrorCode, message: string) {
    super(message);
    this.name = 'SupervisorContractError';
    this.code = code;
  }
}
