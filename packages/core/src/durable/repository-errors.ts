export type DurableRepositoryErrorCode =
  | "RUN_NOT_FOUND"
  | "THREAD_VERSION_CONFLICT"
  | "THREAD_BUSY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RUN_ALREADY_EXISTS"
  | "INVALID_CREATE_RUN"
  | "CONSTRAINT_VIOLATION"
  | "TRANSACTION_CONFLICT"
  | "LOCK_NOT_AVAILABLE"
  | "DATABASE_ERROR";

export class DurableRepositoryError extends Error {
  readonly code: DurableRepositoryErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: DurableRepositoryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DurableRepositoryError";
    this.code = code;
    this.cause = options?.cause;
  }
}
