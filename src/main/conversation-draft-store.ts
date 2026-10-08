import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ConversationDraftScope, ConversationDraft, ConversationDraftState, UncertainSteer } from "../shared/conversation-drafts.js";
export type { ConversationDraftScope, ConversationDraft, ConversationDraftState, UncertainSteer } from "../shared/conversation-drafts.js";
interface StoredConversation extends ConversationDraftState { scope: ConversationDraftScope }
interface DraftRegistry { version: 1; conversations: Record<string, StoredConversation> }

const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_STEER_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATIONS = 100;
const queues = new Map<string, Promise<unknown>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value: unknown, bytes: number, nonempty = false): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= bytes && (!nonempty || value.trim().length > 0);
}
function validScope(value: unknown): value is ConversationDraftScope {
  return isObject(value) && (value.workspaceRoot === null || (boundedString(value.workspaceRoot, 4096, true) && isAbsolute(value.workspaceRoot)))
    && boundedString(value.directory, 4096, true) && isAbsolute(value.directory) && boundedString(value.threadId, 256, true);
}
function validDraft(value: unknown): value is ConversationDraft {
  return isObject(value) && boundedString(value.text, MAX_DRAFT_BYTES) && typeof value.excludeFromMemory === "boolean";
}
function validSteer(value: unknown): value is UncertainSteer {
  return isObject(value) && boundedString(value.id, 256, true) && boundedString(value.runId, 256, true) && boundedString(value.text, MAX_STEER_BYTES, true)
    && (value.taskId === undefined || boundedString(value.taskId, 256, true));
}
function normalizeScope(scope: ConversationDraftScope): ConversationDraftScope {
  if (!validScope(scope)) throw new Error("Invalid conversation draft identity");
  return { workspaceRoot: scope.workspaceRoot === null ? null : resolve(scope.workspaceRoot), directory: resolve(scope.directory), threadId: scope.threadId };
}
function scopeKey(scope: ConversationDraftScope): string {
  return createHash("sha256").update(JSON.stringify([scope.workspaceRoot, scope.directory, scope.threadId])).digest("hex");
}
function emptyState(): ConversationDraftState { return { draft: { text: "", excludeFromMemory: false }, uncertainSteer: null }; }

/** Local UI intent only: contains no approval, authorization, or instructions to replay a Run. */
export class ConversationDraftStore {
  readonly path: string;
  constructor(userData: string) {
    if (!isAbsolute(userData)) throw new Error("Conversation draft userData must be an absolute path");
    this.path = join(resolve(userData), "conversation-drafts.json");
  }

  /** Orderly quit waits for writes already admitted by the main-process IPC handlers. */
  async flush(): Promise<void> {
    while (queues.has(this.path)) await queues.get(this.path);
  }

  async load(scope: ConversationDraftScope): Promise<ConversationDraftState> {
    const normalized = normalizeScope(scope);
    return this.#serialized(async () => {
      const stored = (await this.#read()).conversations[scopeKey(normalized)];
      return stored ? { draft: { ...stored.draft }, uncertainSteer: stored.uncertainSteer ? { ...stored.uncertainSteer } : null } : emptyState();
    });
  }

  async saveDraft(scope: ConversationDraftScope, draft: ConversationDraft): Promise<void> {
    if (!validDraft(draft)) throw new Error("Invalid conversation draft or draft exceeds 64 KiB");
    const captured = { text: draft.text, excludeFromMemory: draft.excludeFromMemory };
    await this.#update(scope, state => { state.draft = captured; });
  }

  async saveUncertainSteer(scope: ConversationDraftScope, steer: UncertainSteer): Promise<void> {
    if (!validSteer(steer)) throw new Error("Invalid uncertain Steer request or text exceeds 4 KiB");
    const captured = { id: steer.id, runId: steer.runId, text: steer.text, ...(steer.taskId === undefined ? {} : { taskId: steer.taskId }) };
    await this.#update(scope, state => {
      if (state.uncertainSteer && (state.uncertainSteer.id !== captured.id || state.uncertainSteer.runId !== captured.runId
        || state.uncertainSteer.text !== captured.text || state.uncertainSteer.taskId !== captured.taskId)) {
        throw new Error("An uncertain Steer request must be reconciled before another request is saved");
      }
      state.uncertainSteer = captured;
    });
  }

  async clearUncertainSteer(scope: ConversationDraftScope, expectedId: string): Promise<boolean> {
    return this.acknowledgeSteer(scope, expectedId);
  }

  /** Acknowledgement is not task completion; clear only the draft which supplied this request. */
  async acknowledgeSteer(scope: ConversationDraftScope, expectedId: string, options: { clearMatchingDraft?: boolean } = {}): Promise<boolean> {
    if (!boundedString(expectedId, 256, true)) throw new Error("Invalid uncertain Steer request id");
    let cleared = false;
    await this.#update(scope, state => {
      if (state.uncertainSteer?.id === expectedId) {
        if (options.clearMatchingDraft && state.draft.text.trim() === state.uncertainSteer.text.trim()) state.draft = { text: "", excludeFromMemory: false };
        state.uncertainSteer = null;
        cleared = true;
      }
    });
    return cleared;
  }

  async #update(scope: ConversationDraftScope, update: (state: StoredConversation) => void): Promise<void> {
    const normalized = normalizeScope(scope);
    await this.#serialized(async () => {
      const registry = await this.#read();
      const key = scopeKey(normalized);
      const state = registry.conversations[key] ?? { scope: normalized, ...emptyState() };
      update(state);
      // Empty drafts do not consume the bounded registry indefinitely.
      if (state.draft.text === "" && !state.draft.excludeFromMemory && state.uncertainSteer === null) delete registry.conversations[key];
      else registry.conversations[key] = state;
      if (Object.keys(registry.conversations).length > MAX_CONVERSATIONS) throw new Error("Conversation draft storage is full (100 conversations); existing drafts were not removed");
      await this.#write(registry);
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    // Electron's single-instance main owns writes. Also serialize separate store instances in that process.
    const previous = queues.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queues.set(this.path, next);
    try { return await next; } finally { if (queues.get(this.path) === next) queues.delete(this.path); }
  }

  async #read(): Promise<DraftRegistry> {
    try {
      if ((await stat(this.path)).size > MAX_FILE_BYTES) throw new Error("Draft file exceeds 2 MiB");
      const text = await readFile(this.path, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Draft file exceeds 2 MiB");
      const registry: unknown = JSON.parse(text);
      if (!isObject(registry) || registry.version !== 1 || !isObject(registry.conversations) || Object.keys(registry.conversations).length > MAX_CONVERSATIONS) throw new Error("Invalid draft registry");
      for (const [key, value] of Object.entries(registry.conversations)) {
        if (!isObject(value) || !validScope(value.scope) || !validDraft(value.draft) || (value.uncertainSteer !== null && !validSteer(value.uncertainSteer))
          || key !== scopeKey(normalizeScope(value.scope))) throw new Error("Invalid stored conversation draft");
      }
      return registry as unknown as DraftRegistry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, conversations: {} };
      throw new Error(`Cannot read conversation drafts ${this.path}; refusing to reset saved input`, { cause: error });
    }
  }

  async #write(registry: DraftRegistry): Promise<void> {
    const text = `${JSON.stringify(registry)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Conversation draft storage exceeds 2 MiB; existing drafts were not removed");
    await mkdir(resolve(this.path, ".."), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
      await rename(temporaryPath, this.path);
      const directory = await open(resolve(this.path, ".."), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
