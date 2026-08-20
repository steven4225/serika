export type DurableErrorCode =
  | "INVALID_SNAPSHOT"
  | "INVALID_COMMAND"
  | "RUN_NOT_ACTIVE"
  | "ACTION_NOT_READY"
  | "ATTEMPT_NOT_ACTIVE"
  | "APPROVAL_ALREADY_RESOLVED"
  | "APPROVAL_EXPIRED"
  | "RECONCILIATION_ALREADY_RESOLVED";

export class DurableDomainError extends Error {
  readonly code: DurableErrorCode;

  constructor(code: DurableErrorCode, message: string) {
    super(message);
    this.name = "DurableDomainError";
    this.code = code;
  }
}
