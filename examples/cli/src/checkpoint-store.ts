import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { acquireFlock } from "./flock.js";
import {
  CHECKPOINT_INJECTION_MAX_BYTES,
  checkpointContextMessageBytes,
} from "./checkpoint-context.js";
import { abortReason, throwIfAborted, validateWorkspacePath } from "./workspace-path.js";

export { CHECKPOINT_INJECTION_MAX_BYTES };

export const CHECKPOINT_FILE_NAME = ".runloom/checkpoint.json";
export const CHECKPOINT_LOCK_FILE_NAME = ".runloom/checkpoint.json.lock";
export const CHECKPOINT_SNAPSHOT_MAX_BYTES = 12 * 1024;
export const CHECKPOINT_FILE_MAX_BYTES = 128 * 1024;
export const CHECKPOINT_HISTORY_MAX_ENTRIES = 8;
export const CHECKPOINT_PREPARE_RESULT_MAX_BYTES = 24 * 1024;
export const CHECKPOINT_LIMITS = {
  goalBytes: 512,
  phaseBytes: 256,
  summaryBytes: 2_048,
  listItemBytes: 256,
  listMaxItems: 12,
  artifactMaxEntries: 6,
  artifactLabelBytes: 128,
  artifactPathBytes: 384,
  artifactNoteBytes: 128,
} as const;

export type CheckpointStatus = "active" | "paused" | "completed";

export interface CheckpointArtifact {
  label: string;
  path: string;
  note?: string;
}

export interface CheckpointDraft {
  status: CheckpointStatus;
  goal: string;
  currentPhase?: string;
  summary: string;
  completed: string[];
  inProgress: string[];
  nextActions: string[];
  blockers: string[];
  artifacts: CheckpointArtifact[];
}

export interface CheckpointGitPin {
  head: string;
  branch: string | null;
  dirty: boolean;
  observedAt: string;
}

export interface CheckpointRealityPins {
  git: CheckpointGitPin;
}

export interface CheckpointSnapshot extends CheckpointDraft {
  id: string;
  version: number;
  source: { threadId: string };
  createdAt: string;
  updatedAt: string;
  realityPins?: CheckpointRealityPins;
}

export interface CheckpointDocumentV1 {
  schemaVersion: 1;
  current: CheckpointSnapshot | null;
  /** Previous versions, newest first. */
  history: CheckpointSnapshot[];
}

export const checkpointStoreErrorCodes = [
  "CHECKPOINT_INVALID_INPUT",
  "CHECKPOINT_FILE_INVALID",
  "CHECKPOINT_VERSION_UNSUPPORTED",
  "CHECKPOINT_VERSION_NOT_FOUND",
  "CHECKPOINT_VERSION_CONFLICT",
  "CHECKPOINT_TOO_LARGE",
  "CHECKPOINT_SYMLINK_NOT_ALLOWED",
  "CHECKPOINT_READ_FAILED",
  "CHECKPOINT_WRITE_FAILED",
] as const;

export type CheckpointStoreErrorCode = (typeof checkpointStoreErrorCodes)[number];

export interface CheckpointFailure {
  ok: false;
  error: { code: CheckpointStoreErrorCode; message: string };
}

export type CheckpointCurrentResult =
  | { ok: true; current: CheckpointSnapshot | null }
  | CheckpointFailure;
export type CheckpointVersionResult =
  | { ok: true; checkpoint: CheckpointSnapshot }
  | CheckpointFailure;
export type CheckpointSaveResult = CheckpointVersionResult;

export interface CheckpointSaveInput {
  expectedVersion: number | null;
  draft: CheckpointDraft;
  /** Supplied by the application, never by model input. */
  sourceThreadId: string;
  /** Supplied by the application, never by model input. Invalid or oversized pins are omitted. */
  realityPins?: CheckpointRealityPins;
}

export interface WorkspaceCheckpointStore {
  getCurrent(signal?: AbortSignal): Promise<CheckpointCurrentResult>;
  getVersion(version: number, signal?: AbortSignal): Promise<CheckpointVersionResult>;
  saveNextVersion(
    input: CheckpointSaveInput,
    signal?: AbortSignal,
  ): Promise<CheckpointSaveResult>;
}

export class CheckpointStoreError extends Error {
  readonly code: CheckpointStoreErrorCode;

  constructor(code: CheckpointStoreErrorCode, message: string) {
    super(message);
    this.name = "CheckpointStoreError";
    this.code = code;
  }
}

const neverAborted = new AbortController().signal;
const EMPTY_DOCUMENT: CheckpointDocumentV1 = {
  schemaVersion: 1,
  current: null,
  history: [],
};

function fail(code: CheckpointStoreErrorCode, message: string): CheckpointFailure {
  return { ok: false, error: { code, message } };
}

function raise(code: CheckpointStoreErrorCode, message: string): never {
  throw new CheckpointStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  code: CheckpointStoreErrorCode = "CHECKPOINT_INVALID_INPUT",
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    raise(code, `${field} contains unsupported fields`);
  }
}

function validateText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    raise("CHECKPOINT_INVALID_INPUT", `${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    raise("CHECKPOINT_TOO_LARGE", `${field} exceeds the ${maxBytes}-byte limit`);
  }
  return value;
}

function validateTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) raise("CHECKPOINT_INVALID_INPUT", `${field} must be an array`);
  return value.map((item, index) =>
    validateText(item, `${field}[${index}]`, CHECKPOINT_LIMITS.listItemBytes),
  );
}

function validateStatus(value: unknown): CheckpointStatus {
  if (value === "active" || value === "paused" || value === "completed") return value;
  raise("CHECKPOINT_INVALID_INPUT", "status must be active, paused, or completed");
}

function validateDraft(value: unknown): CheckpointDraft {
  if (!isRecord(value)) raise("CHECKPOINT_INVALID_INPUT", "draft must be an object");
  assertKeys(
    value,
    ["status", "goal", "currentPhase", "summary", "completed", "inProgress", "nextActions", "blockers", "artifacts"],
    "draft",
  );
  const completed = validateTextList(value.completed, "completed");
  const inProgress = validateTextList(value.inProgress, "inProgress");
  const nextActions = validateTextList(value.nextActions, "nextActions");
  const blockers = validateTextList(value.blockers, "blockers");
  if (completed.length + inProgress.length + nextActions.length + blockers.length > CHECKPOINT_LIMITS.listMaxItems) {
    raise("CHECKPOINT_TOO_LARGE", `Checkpoint lists may contain at most ${CHECKPOINT_LIMITS.listMaxItems} items in total`);
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > CHECKPOINT_LIMITS.artifactMaxEntries) {
    raise("CHECKPOINT_INVALID_INPUT", `artifacts must be an array with at most ${CHECKPOINT_LIMITS.artifactMaxEntries} entries`);
  }
  const artifacts = value.artifacts.map((item, index): CheckpointArtifact => {
    if (!isRecord(item)) raise("CHECKPOINT_INVALID_INPUT", `artifacts[${index}] must be an object`);
    assertKeys(item, ["label", "path", "note"], `artifacts[${index}]`);
    const label = validateText(item.label, `artifacts[${index}].label`, CHECKPOINT_LIMITS.artifactLabelBytes);
    const path = validateText(item.path, `artifacts[${index}].path`, CHECKPOINT_LIMITS.artifactPathBytes);
    const note = item.note === undefined
      ? undefined
      : validateText(item.note, `artifacts[${index}].note`, CHECKPOINT_LIMITS.artifactNoteBytes);
    if (path.includes("\0")) raise("CHECKPOINT_INVALID_INPUT", "Artifact paths must not contain NUL bytes");
    return { label, path, ...(note === undefined ? {} : { note }) };
  });
  const currentPhase = value.currentPhase === undefined
    ? undefined
    : validateText(value.currentPhase, "currentPhase", CHECKPOINT_LIMITS.phaseBytes);
  const draft: CheckpointDraft = {
    status: validateStatus(value.status),
    goal: validateText(value.goal, "goal", CHECKPOINT_LIMITS.goalBytes),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    summary: validateText(value.summary, "summary", CHECKPOINT_LIMITS.summaryBytes),
    completed,
    inProgress,
    nextActions,
    blockers,
    artifacts,
  };
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > CHECKPOINT_SNAPSHOT_MAX_BYTES) {
    raise("CHECKPOINT_TOO_LARGE", `Checkpoint snapshot exceeds the ${CHECKPOINT_SNAPSHOT_MAX_BYTES}-byte limit`);
  }
  return draft;
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    raise("CHECKPOINT_FILE_INVALID", `${field} must be an ISO timestamp`);
  }
  return value;
}

function parseRealityPins(value: unknown): CheckpointRealityPins | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.git)) return undefined;
  const git = value.git;
  if (Object.keys(git).some((key) => !["head", "branch", "dirty", "observedAt"].includes(key))) return undefined;
  if (typeof git.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(git.head)) return undefined;
  if (git.branch !== null &&
    (typeof git.branch !== "string" || git.branch.length === 0 || Buffer.byteLength(git.branch, "utf8") > 256 || /[\x00-\x1f\x7f]/.test(git.branch))) return undefined;
  if (typeof git.dirty !== "boolean") return undefined;
  if (typeof git.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(git.observedAt) ||
    Number.isNaN(Date.parse(git.observedAt)) ||
    new Date(git.observedAt).toISOString() !== git.observedAt) return undefined;
  return { git: {
    head: git.head,
    branch: git.branch,
    dirty: git.dirty,
    observedAt: git.observedAt,
  } };
}

function validateStoredText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    raise("CHECKPOINT_FILE_INVALID", `${field} is invalid or exceeds its size limit`);
  }
  return value;
}

function validateStoredTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) raise("CHECKPOINT_FILE_INVALID", `${field} must be an array`);
  return value.map((item, index) =>
    validateStoredText(item, `${field}[${index}]`, CHECKPOINT_LIMITS.listItemBytes),
  );
}

function validateSnapshot(value: unknown): CheckpointSnapshot {
  if (!isRecord(value)) raise("CHECKPOINT_FILE_INVALID", "Checkpoint snapshot must be an object");
  assertKeys(
    value,
    ["id", "version", "status", "goal", "currentPhase", "summary", "completed", "inProgress", "nextActions", "blockers", "artifacts", "source", "createdAt", "updatedAt", "realityPins"],
    "checkpoint snapshot",
    "CHECKPOINT_FILE_INVALID",
  );
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint id must be non-empty");
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint version must be a positive integer");
  }
  if (!isRecord(value.source)) raise("CHECKPOINT_FILE_INVALID", "Checkpoint source must be an object");
  assertKeys(value.source, ["threadId"], "checkpoint source", "CHECKPOINT_FILE_INVALID");
  if (typeof value.source.threadId !== "string" || value.source.threadId.trim().length === 0) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint source threadId must be non-empty");
  }
  const completed = validateStoredTextList(value.completed, "completed");
  const inProgress = validateStoredTextList(value.inProgress, "inProgress");
  const nextActions = validateStoredTextList(value.nextActions, "nextActions");
  const blockers = validateStoredTextList(value.blockers, "blockers");
  if (completed.length + inProgress.length + nextActions.length + blockers.length > CHECKPOINT_LIMITS.listMaxItems) {
    raise("CHECKPOINT_FILE_INVALID", `Checkpoint lists exceed the ${CHECKPOINT_LIMITS.listMaxItems}-item limit`);
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > CHECKPOINT_LIMITS.artifactMaxEntries) {
    raise("CHECKPOINT_FILE_INVALID", `Checkpoint artifacts exceed the ${CHECKPOINT_LIMITS.artifactMaxEntries}-entry limit`);
  }
  const artifacts = value.artifacts.map((item, index): CheckpointArtifact => {
    if (!isRecord(item)) raise("CHECKPOINT_FILE_INVALID", `artifacts[${index}] must be an object`);
    assertKeys(item, ["label", "path", "note"], `artifacts[${index}]`, "CHECKPOINT_FILE_INVALID");
    const label = validateStoredText(item.label, `artifacts[${index}].label`, CHECKPOINT_LIMITS.artifactLabelBytes);
    const path = validateStoredText(item.path, `artifacts[${index}].path`, CHECKPOINT_LIMITS.artifactPathBytes);
    const note = item.note === undefined
      ? undefined
      : validateStoredText(item.note, `artifacts[${index}].note`, CHECKPOINT_LIMITS.artifactNoteBytes);
    if (path.includes("\0")) raise("CHECKPOINT_FILE_INVALID", "Artifact path contains a NUL byte");
    return { label, path, ...(note === undefined ? {} : { note }) };
  });
  const currentPhase = value.currentPhase === undefined
    ? undefined
    : validateStoredText(value.currentPhase, "currentPhase", CHECKPOINT_LIMITS.phaseBytes);
  const realityPins = value.realityPins === undefined ? undefined : parseRealityPins(value.realityPins);
  if (value.realityPins !== undefined && realityPins === undefined) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint Git reality pin is invalid");
  }
  const snapshot: CheckpointSnapshot = {
    id: value.id,
    version: value.version as number,
    status: (() => {
      if (value.status === "active" || value.status === "paused" || value.status === "completed") return value.status;
      raise("CHECKPOINT_FILE_INVALID", "Checkpoint status is invalid");
    })(),
    goal: validateStoredText(value.goal, "goal", CHECKPOINT_LIMITS.goalBytes),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    summary: validateStoredText(value.summary, "summary", CHECKPOINT_LIMITS.summaryBytes),
    completed,
    inProgress,
    nextActions,
    blockers,
    artifacts,
    source: { threadId: value.source.threadId },
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
    ...(realityPins === undefined ? {} : { realityPins }),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CHECKPOINT_SNAPSHOT_MAX_BYTES) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint snapshot exceeds the size limit");
  }
  if (checkpointContextMessageBytes(snapshot) > CHECKPOINT_INJECTION_MAX_BYTES) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint context message exceeds the injection size limit");
  }
  return snapshot;
}

function validateDocument(value: unknown): CheckpointDocumentV1 {
  if (!isRecord(value)) raise("CHECKPOINT_FILE_INVALID", "Checkpoint file must contain a JSON object");
  assertKeys(value, ["schemaVersion", "current", "history"], "checkpoint file", "CHECKPOINT_FILE_INVALID");
  if (value.schemaVersion !== 1) {
    raise("CHECKPOINT_VERSION_UNSUPPORTED", "Unsupported checkpoint file schema version");
  }
  if (!Array.isArray(value.history) || value.history.length > CHECKPOINT_HISTORY_MAX_ENTRIES) {
    raise("CHECKPOINT_FILE_INVALID", `Checkpoint history must contain at most ${CHECKPOINT_HISTORY_MAX_ENTRIES} entries`);
  }
  const current = value.current === null ? null : validateSnapshot(value.current);
  const history = value.history.map(validateSnapshot);
  if (current === null && history.length > 0) {
    raise("CHECKPOINT_FILE_INVALID", "Checkpoint history cannot exist without a current checkpoint");
  }
  if (current !== null) {
    let expectedVersion = current.version - 1;
    for (const snapshot of history) {
      if (snapshot.id !== current.id || snapshot.createdAt !== current.createdAt || snapshot.version !== expectedVersion) {
        raise("CHECKPOINT_FILE_INVALID", "Checkpoint history is inconsistent with the current version");
      }
      expectedVersion -= 1;
    }
  }
  return { schemaVersion: 1, current, history };
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function errorResult(error: unknown, signal: AbortSignal, writing: boolean): CheckpointFailure {
  if (signal.aborted) throw abortReason(signal);
  if (error instanceof CheckpointStoreError) return fail(error.code, error.message);
  return fail(
    writing ? "CHECKPOINT_WRITE_FAILED" : "CHECKPOINT_READ_FAILED",
    writing ? "Unable to write workspace checkpoint" : "Unable to read workspace checkpoint",
  );
}

export class WorkspaceCheckpointStoreImpl implements WorkspaceCheckpointStore {
  readonly #root: string;
  readonly #file: string;
  readonly #lockFile: string;
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor(
    workspace: string,
    options: { now?: () => Date; generateId?: () => string } = {},
  ) {
    const root = resolve(workspace);
    const validated = validateWorkspacePath(root, CHECKPOINT_FILE_NAME);
    if (!validated.ok) raise("CHECKPOINT_INVALID_INPUT", validated.message);
    this.#root = root;
    this.#file = validated.target;
    this.#lockFile = resolve(root, CHECKPOINT_LOCK_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  async getCurrent(signal: AbortSignal = neverAborted): Promise<CheckpointCurrentResult> {
    try {
      const document = await this.#load(signal);
      return { ok: true, current: document.current };
    } catch (error) {
      return errorResult(error, signal, false);
    }
  }

  async getVersion(version: number, signal: AbortSignal = neverAborted): Promise<CheckpointVersionResult> {
    if (!Number.isSafeInteger(version) || version < 1) {
      return fail("CHECKPOINT_INVALID_INPUT", "version must be a positive integer");
    }
    try {
      const document = await this.#load(signal);
      const checkpoint = [document.current, ...document.history]
        .find((entry) => entry?.version === version);
      return checkpoint === undefined || checkpoint === null
        ? fail("CHECKPOINT_VERSION_NOT_FOUND", `Checkpoint version ${version} is not available`)
        : { ok: true, checkpoint };
    } catch (error) {
      return errorResult(error, signal, false);
    }
  }

  async saveNextVersion(
    input: CheckpointSaveInput,
    signal: AbortSignal = neverAborted,
  ): Promise<CheckpointSaveResult> {
    try {
      if (!isRecord(input) || (input.expectedVersion !== null &&
        (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))) {
        raise("CHECKPOINT_INVALID_INPUT", "expectedVersion must be null or a positive integer");
      }
      if (typeof input.sourceThreadId !== "string" || input.sourceThreadId.trim().length === 0) {
        raise("CHECKPOINT_INVALID_INPUT", "sourceThreadId must be non-empty");
      }
      const draft = validateDraft(input.draft);
      await this.#ensureDirectory(signal);
      const lock = await acquireFlock(this.#lockFile, signal);
      try {
        throwIfAborted(signal);
        const document = await this.#load(signal);
        const currentVersion = document.current?.version ?? null;
        if (currentVersion !== input.expectedVersion) {
          return fail(
            "CHECKPOINT_VERSION_CONFLICT",
            `Current checkpoint version is ${currentVersion ?? "none"}; expected ${input.expectedVersion ?? "none"}`,
          );
        }
        const timestamp = this.#now().toISOString();
        const checkpoint: CheckpointSnapshot = {
          ...draft,
          id: document.current?.id ?? this.#generateId(),
          version: (document.current?.version ?? 0) + 1,
          source: { threadId: input.sourceThreadId },
          createdAt: document.current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > CHECKPOINT_SNAPSHOT_MAX_BYTES) {
          raise("CHECKPOINT_TOO_LARGE", `Checkpoint snapshot exceeds the ${CHECKPOINT_SNAPSHOT_MAX_BYTES}-byte limit`);
        }
        if (checkpointContextMessageBytes(checkpoint) > CHECKPOINT_INJECTION_MAX_BYTES) {
          raise("CHECKPOINT_TOO_LARGE", `Checkpoint context message exceeds the ${CHECKPOINT_INJECTION_MAX_BYTES}-byte injection limit`);
        }
        const pin = input.realityPins === undefined ? undefined : parseRealityPins(input.realityPins);
        if (pin !== undefined) {
          const pinned = { ...checkpoint, realityPins: pin };
          if (Buffer.byteLength(JSON.stringify(pinned), "utf8") <= CHECKPOINT_SNAPSHOT_MAX_BYTES &&
            checkpointContextMessageBytes(pinned) <= CHECKPOINT_INJECTION_MAX_BYTES) {
            checkpoint.realityPins = pin;
          }
        }
        const next: CheckpointDocumentV1 = {
          schemaVersion: 1,
          current: checkpoint,
          history: document.current === null
            ? []
            : [document.current, ...document.history].slice(0, CHECKPOINT_HISTORY_MAX_ENTRIES),
        };
        const serialized = `${JSON.stringify(next)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > CHECKPOINT_FILE_MAX_BYTES) {
          raise("CHECKPOINT_TOO_LARGE", `Checkpoint file exceeds the ${CHECKPOINT_FILE_MAX_BYTES}-byte limit`);
        }
        await this.#write(serialized, signal);
        return { ok: true, checkpoint };
      } finally {
        await lock.release();
      }
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async #load(signal: AbortSignal): Promise<CheckpointDocumentV1> {
    throwIfAborted(signal);
    await this.#inspectRoot(signal);
    const directory = dirname(this.#file);
    let directoryDetails;
    try {
      directoryDetails = await lstat(directory);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (filesystemCode(error) === "ENOENT") return { ...EMPTY_DOCUMENT };
      throw error;
    }
    throwIfAborted(signal);
    if (directoryDetails.isSymbolicLink()) raise("CHECKPOINT_SYMLINK_NOT_ALLOWED", "Checkpoint directory must not be a symlink");
    if (!directoryDetails.isDirectory()) raise("CHECKPOINT_FILE_INVALID", "Checkpoint path is not a directory");

    let fileDetails;
    try {
      fileDetails = await lstat(this.#file);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (filesystemCode(error) === "ENOENT") return { ...EMPTY_DOCUMENT };
      throw error;
    }
    throwIfAborted(signal);
    if (fileDetails.isSymbolicLink()) raise("CHECKPOINT_SYMLINK_NOT_ALLOWED", "Checkpoint file must not be a symlink");
    if (!fileDetails.isFile()) raise("CHECKPOINT_FILE_INVALID", "Checkpoint path is not a regular file");
    if (fileDetails.size > CHECKPOINT_FILE_MAX_BYTES) {
      raise("CHECKPOINT_TOO_LARGE", `Checkpoint file exceeds the ${CHECKPOINT_FILE_MAX_BYTES}-byte limit`);
    }
    const text = await readFile(this.#file, "utf8");
    throwIfAborted(signal);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      raise("CHECKPOINT_FILE_INVALID", "Checkpoint file must contain valid JSON");
    }
    return validateDocument(value);
  }

  async #inspectRoot(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const details = await lstat(this.#root);
    throwIfAborted(signal);
    if (details.isSymbolicLink()) raise("CHECKPOINT_SYMLINK_NOT_ALLOWED", "Workspace root must not be a symlink");
    if (!details.isDirectory()) raise("CHECKPOINT_READ_FAILED", "Workspace is not a directory");
  }

  async #ensureDirectory(signal: AbortSignal): Promise<void> {
    await this.#inspectRoot(signal);
    const directory = dirname(this.#file);
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
    throwIfAborted(signal);
    const details = await lstat(directory);
    if (details.isSymbolicLink()) raise("CHECKPOINT_SYMLINK_NOT_ALLOWED", "Checkpoint directory must not be a symlink");
    if (!details.isDirectory()) raise("CHECKPOINT_FILE_INVALID", "Checkpoint path is not a directory");
  }

  async #write(serialized: string, signal: AbortSignal): Promise<void> {
    await this.#inspectRoot(signal);
    const directory = dirname(this.#file);
    const directoryDetails = await lstat(directory);
    if (directoryDetails.isSymbolicLink()) raise("CHECKPOINT_SYMLINK_NOT_ALLOWED", "Checkpoint directory must not be a symlink");
    if (!directoryDetails.isDirectory()) raise("CHECKPOINT_WRITE_FAILED", "Checkpoint path is not a directory");
    const temporary = join(directory, `.checkpoint.json.runloom-${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      throwIfAborted(signal);
      await handle.writeFile(serialized, "utf8");
      throwIfAborted(signal);
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#file);
      created = false;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (created) await rm(temporary, { force: true }).catch(() => undefined);
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
  }
}

export function createCheckpointStore(
  workspace: string,
  options?: { now?: () => Date; generateId?: () => string },
): WorkspaceCheckpointStore {
  return new WorkspaceCheckpointStoreImpl(workspace, options);
}
