import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hashCanonicalJson } from "@serika/core";
import { acquireFlock } from "./flock.js";
import { assertExperimentalDataPaths } from "./experimental-data.js";
import { LegacyMemoryReader, MemoryStoreError, MEMORY_FILE_MAX_BYTES, MEMORY_MAX_ENTRIES, type MemoryEntry, type MemoryAddInput, type MemoryUpdateInput, type MemoryWriteOptions, type MemoryReviseInput, type MemoryRestoreInput, type MemoryStoreAction, type MemoryRecord, type MemoryTemporalQuery, type MemoryFailure, type TemporalWorkspaceMemoryStore } from "./memory-store.js";
import { memoryLibrarySchema, memoryLibraryView, memoryLibraryDocuments, memoryLibraryActionSchema, memoryDocumentChunks, emptyMemoryLibrary, type MemoryLibraryAction } from "./memory-library.js";
import { memoryImportEntriesSchema, memoryImportConfirmSchema, memoryImportReceiptSchema, MEMORY_IMPORT_MAX_RECEIPTS, type MemoryImportEntry, type MemoryImportPreview, type MemoryImportConfirm, type MemoryImportReceipt } from "./memory-import.js";
import type { CandidatePage, CandidatePreview, CandidateResolution, CandidateBatchResult, ConsolidationCursor, ConsolidationReceipt, MemoryResult } from "./memory-candidates.js";

const string = z.string().min(1);
const time = z.iso.datetime({ offset: true });
export const v6SourceSchema = z.union([
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("conversation"), threadId: string, messageId: string, quote: string.refine(value => Buffer.byteLength(value) <= 2048), sentAt: time.nullable(),
    proposal: z.object({ messageId: string, quote: string.refine(value => Buffer.byteLength(value) <= 2048) }).strict().optional() }).strict(),
]);
const scope = z.union([z.object({ kind: z.literal("workspace") }).strict(), z.object({ kind: z.literal("thread"), threadId: string }).strict()]);
const identity = z.object({ subject: string, attribute: string, value: string }).strict();
const body = string.refine(text => text.trim().length > 0 && Buffer.byteLength(text) <= 2048, "Memory text exceeds 2048 bytes or is blank");
const entrySchema = z.object({ id: string, revision: z.number().int().positive(), text: body, uncertain: z.boolean().default(false), category: z.enum(["preference", "note", "document"]),
  identity: identity.optional(), scope, pinned: z.boolean(), state: z.enum(["active", "disabled", "superseded", "retracted"]),
  createdAt: time, updatedAt: time, sources: z.array(v6SourceSchema).min(1),
  replaces: z.array(string), supersededBy: string.nullable(), withdrawal: v6SourceSchema.nullable() }).strict();
const segment = z.object({ throughMessageId: string, prefixHash: string }).strict();
const progress = z.object({ threadId: string, throughMessageId: string.nullable(), prefixHash: string.nullable(),
  pending: z.array(z.object({ messageId: string, prefixHash: string }).strict()).default([]),
  retry: z.object({ ...segment.shape, failures: z.number().int().min(1).max(3) }).strict().nullable() }).strict();
const documentSchema = z.object({ version: z.literal(6), lastWrittenAt: time.nullable(), entries: z.array(entrySchema).max(512),
  progress: z.array(progress), suppressed: z.array(z.object({ threadId: string, messageId: string, memoryHash: string }).strict()),
  library: memoryLibrarySchema, importReceipts: z.array(memoryImportReceiptSchema).max(MEMORY_IMPORT_MAX_RECEIPTS) }).strict();
export const validateV6MemoryDocument = (value: unknown): V6Document => documentSchema.parse(value);
export type V6Source = z.infer<typeof v6SourceSchema>;
export type V6Entry = z.infer<typeof entrySchema>;
export type V6Document = z.infer<typeof documentSchema>;
export type V6Change = { operation: "add" | "replace"; text: string; uncertain?: boolean; category: V6Entry["category"]; identity?: V6Entry["identity"]; source: V6Source; scope: V6Entry["scope"]; id?: string; expectedRevision?: number }
  | { operation: "retract" | "undo"; id: string; expectedRevision: number; source: V6Source };
export interface V6Commit { expectedProgress?: V6Document["progress"][number] | null; progress?: V6Document["progress"][number]; now?: Date; automatic?: boolean; reextract?: boolean; sourceOrder?: readonly string[]; initial?: { pinned: boolean; disabled: boolean } }
const empty = (): V6Document => ({ version: 6, lastWrittenAt: null, entries: [], progress: [], suppressed: [], library: emptyMemoryLibrary(), importReceipts: [] });
function fail(code: ConstructorParameters<typeof MemoryStoreError>[0], message: string): never { throw new MemoryStoreError(code, message); }
const migration = (): never => fail("MEMORY_MIGRATION_REQUIRED", "需要迁移（第 7 步）");
const removed = (): never => fail("MEMORY_OPERATION_REMOVED", "旧候选、审核与双时态写入口已停用");
const importSnapshot = (document: V6Document) => createHash("sha256").update(JSON.stringify(document)).digest("hex");
const memoryHash = (entry: Pick<V6Entry, "text" | "identity">) => hashCanonicalJson({ text: entry.text });
export function v6Projection(entry: V6Entry): MemoryEntry {
  return { id: entry.id, revision: entry.revision, text: entry.text, uncertain: entry.uncertain, kind: entry.category === "preference" ? "preference" : "note",
    enabled: entry.state === "active", status: entry.state === "active" ? "active" : "disabled", scope: entry.scope, pinned: entry.pinned,
    source: entry.sources[0]!, createdAt: entry.createdAt, updatedAt: entry.updatedAt, expiresAt: null, v6: structuredClone(entry) };
}
export function v6Conflicts(entries: readonly V6Entry[]): string[][] {
  const groups = new Map<string, V6Entry[]>();
  for (const entry of entries.filter(entry => entry.state === "active" && entry.identity)) {
    const key = hashCanonicalJson([entry.scope, entry.identity!.subject, entry.identity!.attribute]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].filter(group => new Set(group.map(entry => entry.identity!.value)).size > 1).map(group => group.map(entry => entry.id));
}

/** The only Memory writer. LegacyMemoryReader is used exclusively for old-format reads. */
export class V6MemoryStore {
  readonly #root: string;
  readonly #legacy: LegacyMemoryReader;
  readonly #boundary: ((phase: "before-rename" | "after-rename") => void | Promise<void>) | undefined;
  constructor(workspace: string, boundary?: (phase: "before-rename" | "after-rename") => void | Promise<void>) {
    this.#root = resolve(workspace); this.#legacy = new LegacyMemoryReader(workspace); this.#boundary = boundary;
  }
  async #result<T>(signal: AbortSignal, body: () => Promise<T>): Promise<{ ok: true; value: T } | MemoryFailure> {
    try { signal.throwIfAborted(); return { ok: true, value: await body() }; }
    catch (error) {
      if (error instanceof MemoryStoreError) return { ok: false, error: { code: error.code, message: error.message } };
      signal.throwIfAborted();
      return { ok: false, error: { code: error instanceof z.ZodError ? "INVALID_INPUT" : "WRITE_FAILED", message: error instanceof z.ZodError ? "Invalid v6 Memory data" : "Memory operation failed" } };
    }
  }
  async #read(): Promise<V6Document | null> {
    for (const path of [this.#root, join(this.#root, ".runloom"), join(this.#root, ".runloom/memory.json")]) {
      try { if ((await lstat(path)).isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
    }
    const handle = await open(join(this.#root, ".runloom/memory.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let parsed: unknown;
    try {
      if ((await handle.stat()).size > MEMORY_FILE_MAX_BYTES) fail("MEMORY_LIMIT_EXCEEDED", "Memory exceeds 16 MiB");
      const buffer = Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > MEMORY_FILE_MAX_BYTES) fail("MEMORY_LIMIT_EXCEEDED", "Memory exceeds 16 MiB");
      try { parsed = JSON.parse(buffer.subarray(0, size).toString("utf8")); } catch { fail("MEMORY_FILE_INVALID", "Invalid Memory JSON"); }
    } finally { await handle.close(); }
    if ((parsed as { version?: unknown })?.version !== 6) { const read = await this.#legacy.list(); if (!read.ok) fail(read.error.code, read.error.message); return null; }
    const checked = documentSchema.safeParse(parsed);
    if (!checked.success) fail("MEMORY_FILE_INVALID", "Invalid v6 Memory file");
    const document = checked.data;
    if (new Set(document.entries.map(entry => entry.id)).size !== document.entries.length || new Set(document.progress.map(item => item.threadId)).size !== document.progress.length) fail("MEMORY_FILE_INVALID", "Duplicate Memory identity");
    return document;
  }
  async #mutate<T>(signal: AbortSignal, body: (document: V6Document, stamp: string) => T, now?: Date): Promise<T> {
    assertExperimentalDataPaths([this.#root]);
    if (await this.#read() === null) migration();
    signal.throwIfAborted();
    const directory = join(this.#root, ".runloom"); await mkdir(directory, { recursive: true });
    const lock = await acquireFlock(join(directory, "memory.json.lock"), signal);
    let renamed = false;
    const temporary = join(directory, `.memory.json.runloom-${randomUUID()}.tmp`);
    try {
      const document = await this.#read() ?? migration(); signal.throwIfAborted();
      const stamp = (now ?? new Date()).toISOString();
      if (document.lastWrittenAt && stamp < document.lastWrittenAt) fail("MEMORY_CLOCK_ROLLBACK", "Memory clock moved backwards");
      const before = JSON.stringify(document), value = body(document, stamp);
      if (before === JSON.stringify(document)) return value;
      document.lastWrittenAt = stamp;
      documentSchema.parse(document);
      const serialized = JSON.stringify(document) + "\n";
      if (Buffer.byteLength(serialized) > MEMORY_FILE_MAX_BYTES) fail("MEMORY_LIMIT_EXCEEDED", "Memory exceeds 16 MiB; 未保存，请勿声称已记住");
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await this.#boundary?.("before-rename"); signal.throwIfAborted();
      await rename(temporary, join(directory, "memory.json")); renamed = true;
      await this.#boundary?.("after-rename");
      const folder = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await folder.sync(); } finally { await folder.close(); }
      return value;
    } catch (error) {
      if (renamed) fail("MEMORY_COMMIT_UNCERTAIN", "Memory commit acknowledgement is unknown; read before deciding, never resend automatically");
      throw error;
    } finally {
      try { await rm(temporary, { force: true }); }
      catch (error) { if (renamed) fail("MEMORY_COMMIT_UNCERTAIN", "Memory cleanup acknowledgement is unknown"); throw error; }
      finally { try { await lock.release(); } catch (error) { if (renamed) fail("MEMORY_COMMIT_UNCERTAIN", "Memory lock acknowledgement is unknown"); throw error; } }
    }
  }
  readV6(signal = new AbortController().signal) { return this.#result(signal, async () => await this.#read() ?? migration()); }
  async list(signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const result = await this.#result(signal, () => this.#read());
    if (!result.ok) return result;
    return result.value === null ? this.#legacy.list(signal, options) : { ok: true as const, entries: result.value.entries.map(v6Projection) };
  }
  async get(id: string, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const listed = await this.list(signal, options); if (!listed.ok) return listed;
    const entry = listed.entries.find(entry => entry.id === id && (entry.scope?.kind !== "thread" || !options?.boundThreadId || entry.scope.threadId === options.boundThreadId));
    return entry ? { ok: true as const, entry } : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "Memory not found" } };
  }
  writeV6(changes: V6Change[], signal = new AbortController().signal, options: V6Commit = {}) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      if (options.progress && JSON.stringify(document.progress.find(item => item.threadId === options.progress!.threadId) ?? null) !== JSON.stringify(options.expectedProgress ?? null)) fail("MEMORY_CURSOR_MISMATCH", "Extraction progress changed");
      const written: MemoryEntry[] = [];
      for (const raw of changes) {
        const source = v6SourceSchema.parse(raw.source);
        if ((raw.operation === "add" || raw.operation === "replace") && document.suppressed.some(item => source.kind === "conversation" && item.threadId === source.threadId && item.messageId === source.messageId && item.memoryHash === memoryHash(raw))) continue;
        let target = raw.operation === "add" ? undefined : document.entries.find(entry => entry.id === raw.id);
        if (raw.operation !== "add" && (!target || target.revision !== raw.expectedRevision)) fail("MEMORY_REVISION_CONFLICT", "Memory target changed or is missing");
        if (target?.scope.kind === "thread" && source.kind === "conversation" && target.scope.threadId !== source.threadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
        const order = options.sourceOrder;
        const position = source.kind === "conversation" ? order?.indexOf(source.messageId) ?? -1 : -1;
        const newer = (entry: V6Entry) => source.kind === "conversation" && position >= 0 && entry.sources.some(item => item.kind === "conversation" && item.threadId === source.threadId && (order?.indexOf(item.messageId) ?? -1) > position);
        if (options.automatic && target && (newer(target) || options.reextract) && raw.operation !== "replace") continue;
        if (raw.operation === "add" || raw.operation === "replace") {
          if (target && target.state !== "active") fail("MEMORY_DISABLED", "Replace requires an active target");
          if (target && JSON.stringify(target.scope) !== JSON.stringify(raw.scope)) fail("MEMORY_SOURCE_INVALID", "Replacement cannot change scope");
          const later = options.automatic ? document.entries.find(entry => entry.state === "active" && newer(entry) && (entry.id === target?.id || raw.identity && entry.identity && JSON.stringify(entry.scope) === JSON.stringify(raw.scope) && entry.identity.subject === raw.identity.subject && entry.identity.attribute === raw.identity.attribute)) : undefined;
          if (later || options.reextract) target = undefined;

          const entry: V6Entry = entrySchema.parse({ id: randomUUID(), revision: 1, text: raw.text, uncertain: raw.uncertain ?? false, category: raw.category, ...(raw.identity ? { identity: raw.identity } : {}),
            scope: raw.scope, pinned: options.initial?.pinned ?? target?.pinned ?? false, state: options.initial?.disabled ? "disabled" : "active", createdAt: stamp, updatedAt: stamp, sources: [source], replaces: target ? [target.id] : [], supersededBy: later?.id ?? null, withdrawal: null });
          if (later) entry.state = "superseded";
          if (document.entries.length >= MEMORY_MAX_ENTRIES) fail("MEMORY_LIMIT_EXCEEDED", "Memory 已满，未保存；请勿声称已记住");
          if (target) { target.state = "superseded"; target.supersededBy = entry.id; target.revision++; target.updatedAt = stamp; }
          if (target?.category === "document") {
            for (const documentRef of document.library.documents) documentRef.entryIds = documentRef.entryIds.map(id => id === target!.id ? entry.id : id);
            document.library.revision++;
          }
          document.entries.push(entry); written.push(v6Projection(entry));
        } else if (raw.operation === "retract") {
          if (target!.state !== "active" && target!.state !== "disabled") fail("MEMORY_DISABLED", "Withdrawal requires a current target");
          target!.state = "retracted"; target!.withdrawal = source; target!.revision++; target!.updatedAt = stamp; written.push(v6Projection(target!));
        } else {
          if (target!.state === "active" && target!.replaces.length) {
            for (const id of target!.replaces) {
              const old = document.entries.find(entry => entry.id === id);
              if (!old || old.supersededBy !== target!.id || old.state !== "superseded") fail("MEMORY_REVISION_CONFLICT", "Undo target changed");
              old.state = "active"; old.supersededBy = null; old.sources.push(source); old.revision++; old.updatedAt = stamp; written.push(v6Projection(old));
            }
            target!.state = "retracted"; target!.withdrawal = source;
          } else if (target!.state === "retracted" && target!.supersededBy === null && target!.replaces.every(id => document.entries.some(entry => entry.id === id && entry.state === "superseded" && entry.supersededBy === target!.id))) { target!.state = "active"; target!.withdrawal = null; target!.sources.push(source); }
          else fail("MEMORY_REVISION_CONFLICT", "Memory cannot be undone in its current state");
          target!.revision++; target!.updatedAt = stamp; written.push(v6Projection(target!));
        }
      }
      const reserveBytes = Math.max(2048, ...written.map(entry => Buffer.byteLength(JSON.stringify(entry.v6))));
      if (options.automatic && written.length && (document.entries.length >= MEMORY_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(document)) + reserveBytes > MEMORY_FILE_MAX_BYTES)) fail("MEMORY_LIMIT_EXCEEDED", "自动沉淀已停止，为显式写入保留至少一条同等大小记忆的余量");
      if (options.progress) document.progress = [...document.progress.filter(item => item.threadId !== options.progress!.threadId), options.progress];
      return written;
    }, options.now));
  }
  async add(input: MemoryAddInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    if (input.expiresAt || input.validTime || input.recallTerms?.length || input.factIdentity) return { ok: false as const, error: { code: "MEMORY_OPERATION_REMOVED" as const, message: "v6 不再写入旧时态与 identity 格式；请使用新记忆写入口" } };
    const source = input.source?.kind === "conversation" ? { ...input.source, sentAt: null } : { kind: "manual" as const };
    const result = await this.writeV6([{ operation: "add", text: input.text, category: input.kind === "preference" ? "preference" : "note", scope: input.scope ?? { kind: "workspace" }, source }], signal, { ...(options?.now ? { now: options.now } : {}), initial: { pinned: input.pinned ?? false, disabled: input.enabled === false || input.status === "disabled" } });
    return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
  }
  async update(id: string, input: MemoryUpdateInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV6(signal); if (!writable.ok) return writable;
    if (input.text !== undefined) {
      const current = await this.get(id, signal, options); if (!current.ok) return current;
      const result = await this.writeV6([{ operation: "replace", id, expectedRevision: input.expectedRevision, text: input.text,
        category: current.entry.v6?.category ?? "note", scope: current.entry.scope ?? { kind: "workspace" }, source: { kind: "manual" } }], signal, { ...(options?.now ? { now: options.now } : {}), initial: { pinned: input.pinned ?? current.entry.pinned ?? false, disabled: input.enabled === false || input.status === "disabled" } });
      return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
    }
    const result = await this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const entry = document.entries.find(entry => entry.id === id);
      if (!entry || entry.revision !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "Memory changed");
      if (entry.scope.kind === "thread" && entry.scope.threadId !== options?.boundThreadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
      if (input.pinned !== undefined) entry.pinned = input.pinned;
      if (input.status === "disabled" || input.enabled === false) { if (entry.state !== "active" && entry.state !== "disabled") fail("MEMORY_DISABLED", "Only current memory can be disabled"); entry.state = "disabled"; }
      entry.revision++; entry.updatedAt = stamp; return v6Projection(entry);
    }, options?.now));
    return result.ok ? { ok: true as const, entry: result.value } : result;
  }
  async deleteMemory(input: { id: string; expectedRevision: number }, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const result = await this.#result(signal, () => this.#mutate(signal, document => {
      const entry = document.entries.find(entry => entry.id === input.id);
      if (!entry || entry.revision !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "Memory changed");
      if (entry.scope.kind === "thread" && entry.scope.threadId !== options?.boundThreadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
      for (const source of entry.sources) if (source.kind === "conversation") document.suppressed.push({ threadId: source.threadId, messageId: source.messageId, memoryHash: memoryHash(entry) });
      document.entries = document.entries.filter(item => item.id !== entry.id); return input.id;
    }, options?.now));
    return result.ok ? { ok: true as const, id: result.value } : result;
  }
  async delete(id: string, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV6(signal); if (!writable.ok) return writable;
    const current = await this.get(id, signal, options);
    return current.ok ? this.deleteMemory({ id, expectedRevision: current.entry.revision! }, signal, options) : current;
  }
  async readReferenceMaterial(signal: AbortSignal, now: Date) {
    const document = await this.#result(signal, () => this.#read()); if (!document.ok) return document;
    return document.value ? { ok: true as const, value: { entries: document.value.entries.map(v6Projection), library: document.value.library } } : this.#legacy.readReferenceMaterial(signal, now);
  }
  async getLibrary(threadId: string, signal = new AbortController().signal) {
    const material = await this.readReferenceMaterial(signal, new Date());
    return material.ok ? { ok: true as const, value: memoryLibraryView(material.value.library, material.value.entries, threadId) } : material;
  }
  async readLibraryDocument(id: string, threadId: string, signal = new AbortController().signal) {
    const material = await this.readReferenceMaterial(signal, new Date()); if (!material.ok) return material;
    const found = memoryLibraryDocuments(material.value.library, material.value.entries, threadId).find(item => item.id === id);
    return found ? { ok: true as const, value: { ...found, libraryRevision: material.value.library.revision } } : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Document not found" } };
  }
  changeLibrary(input: MemoryLibraryAction, threadId: string, signal = new AbortController().signal) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const action = memoryLibraryActionSchema.parse(input), library = document.library;
      if (action.expectedRevision !== library.revision) fail("MEMORY_REVISION_CONFLICT", "Library changed");
      if (action.operation === "create-folder") library.folders.push({ id: action.id, name: action.name });
      else if (action.operation === "rename-folder") { const folder = library.folders.find(item => item.id === action.id); if (!folder) fail("MEMORY_ENTRY_NOT_FOUND", "Folder missing"); folder.name = action.name; }
      else if (action.operation === "remove-folder") { if (library.documents.some(item => item.folderId === action.id)) fail("INVALID_INPUT", "Folder is not empty"); library.folders = library.folders.filter(item => item.id !== action.id); for (const item of library.documents) if (item.folderId === action.id) item.folderId = null; }
      else {
        if (action.folderId !== null && !library.folders.some(item => item.id === action.folderId)) fail("MEMORY_ENTRY_NOT_FOUND", "Folder missing");
        let item = library.documents.find(item => item.id === action.id);
        if (item?.scope.kind === "thread" && item.scope.threadId !== threadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
        if (action.operation === "save-document") {
          if (item?.entryIds.some(id => !document.entries.some(entry => entry.id === id))) fail("MEMORY_ENTRY_NOT_FOUND", "Document body missing");
          for (const ref of action.entries) { const entry = document.entries.find(entry => entry.id === ref.id); if (!entry) fail("MEMORY_ENTRY_NOT_FOUND", "Document body missing"); if (entry.revision !== ref.revision || entry.scope.kind === "thread" && entry.scope.threadId !== threadId) fail("MEMORY_REVISION_CONFLICT", "Document body changed"); }
          if (!item && action.id.startsWith("memory:")) {
            const old = document.entries.find(entry => `memory:${entry.id}` === action.id);
            if (!old || old.scope.kind === "thread" && old.scope.threadId !== threadId || action.entries.length !== 1 || action.entries[0]?.id !== old.id) fail("INVALID_INPUT", "Document ownership is invalid");
            item = { id: action.id, title: action.title, folderId: action.folderId, entryIds: [old.id], scope: old.scope }; library.documents.push(item);
          }
          if (!item && (action.entries.length || !z.uuid().safeParse(action.id).success)) fail("INVALID_INPUT", "New document cannot claim existing entries");
          if (item && JSON.stringify(item.entryIds) !== JSON.stringify(action.entries.map(entry => entry.id))) fail("MEMORY_REVISION_CONFLICT", "Document references changed");
          let chunks: string[]; try { chunks = memoryDocumentChunks(action.text); } catch { fail("INVALID_INPUT", "文档包含过长的连续空白，请整理后再保存"); }
          const ids = chunks.map(text => { const entry: V6Entry = { id: randomUUID(), revision: 1, text, uncertain: false, category: "document", scope: item?.scope ?? { kind: "workspace" }, pinned: false, state: "active", createdAt: stamp, updatedAt: stamp, sources: [{ kind: "manual" }], replaces: [], supersededBy: null, withdrawal: null }; document.entries.push(entry); return entry.id; });
          for (const ref of action.entries) { const old = document.entries.find(entry => entry.id === ref.id)!; old.state = "superseded"; old.supersededBy = ids[0]!; old.revision++; old.updatedAt = stamp; }
          if (!item) { item = { id: action.id, title: action.title, folderId: action.folderId, entryIds: ids, scope: { kind: "workspace" } }; library.documents.push(item); } else item.entryIds = ids;
        }
        if (!item) fail("MEMORY_ENTRY_NOT_FOUND", "Document missing");
        if (item.scope.kind === "thread" && item.scope.threadId !== threadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
        item.title = action.title; item.folderId = action.folderId;
      }
      library.revision++; return memoryLibraryView(library, document.entries.map(v6Projection), threadId);
    }));
  }
  async inspectMemory(id: string, signal = new AbortController().signal, options?: MemoryWriteOptions): Promise<MemoryResult<MemoryRecord>> {
    const document = await this.#result(signal, () => this.#read()); if (!document.ok) return document;
    if (!document.value) return this.#legacy.inspectMemory(id, signal, options);
    return this.#result(signal, async () => {
      const entry = document.value!.entries.find(item => item.id === id); if (!entry) fail("MEMORY_ENTRY_NOT_FOUND", "Memory missing");
      if (entry.scope.kind === "thread" && entry.scope.threadId !== options?.boundThreadId) fail("MEMORY_SOURCE_INVALID", "Foreign Thread");
      const kind = entry.category === "preference" ? "preference" as const : "note" as const;
      return { id, revision: entry.revision, scope: entry.scope, pinned: entry.pinned, status: entry.state === "active" ? "active" as const : "disabled" as const, expiresAt: null, createdAt: entry.createdAt, updatedAt: entry.updatedAt, historyCoverage: "complete" as const,
        assertions: [{ assertionId: id, text: entry.text, kind, recallTerms: [], state: entry.state === "retracted" ? "retracted" as const : "asserted" as const, sources: entry.sources, validTime: { from: null, to: null, basis: "unknown" as const }, systemTime: { from: null, to: null } }], versions: [] };
    });
  }
  async queryMemory(id: string, query: MemoryTemporalQuery = {}, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const record = await this.inspectMemory(id, signal, options);
    return record.ok ? { ok: true as const, value: { id, revision: record.value.revision, historyCoverage: record.value.historyCoverage, assertions: record.value.assertions, validTimeUncertain: true, systemTimeUncertain: true } } : record;
  }
  async reviseMemory(input: MemoryReviseInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV6(signal); if (!writable.ok) return writable;
    const bound = await this.get(input.id, signal, options); if (!bound.ok) return bound;
    if (input.operation === "change" || input.validTime !== undefined || input.recallTerms !== undefined) return { ok: false as const, error: { code: "MEMORY_OPERATION_REMOVED" as const, message: "v6 不支持双时态写入；请编辑正文中的条件" } };
    if (input.operation !== "retract") return this.update(input.id, { expectedRevision: input.expectedRevision, text: input.text! }, signal, options);
    const result = await this.writeV6([{ operation: "retract", id: input.id, expectedRevision: input.expectedRevision, source: { kind: "manual" } }], signal);
    return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
  }
  async restoreMemory(input: MemoryRestoreInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV6(signal); if (!writable.ok) return writable;
    const bound = await this.get(input.id, signal, options); if (!bound.ok) return bound;
    if (input.targetAssertionId !== input.id || input.status === "disabled" || input.expiresAt) return { ok: false as const, error: { code: "MEMORY_OPERATION_REMOVED" as const, message: "v6 只支持撤销当前取代或撤回" } };
    const result = await this.writeV6([{ operation: "undo", id: input.id, expectedRevision: input.expectedRevision, source: { kind: "manual" } }], signal);
    return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
  }
  async previewMemoryMutation(input: MemoryStoreAction, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const current = await this.get(input.id, signal, options); if (!current.ok) return current;
    if (current.entry.revision !== input.expectedRevision) return { ok: false as const, error: { code: "MEMORY_REVISION_CONFLICT" as const, message: "Memory changed" } };
    if (input.operation === "change" || "validTime" in input || "recallTerms" in input || input.operation === "restore" && (input.targetAssertionId !== input.id || input.status === "disabled" || input.expiresAt)) return { ok: false as const, error: { code: "MEMORY_OPERATION_REMOVED" as const, message: "v6 只支持编辑、撤回与撤销；不支持历史时间选择" } };
    const record = await this.inspectMemory(input.id, signal, options); if (!record.ok) return record;
    const proposed = input.operation === "correct" ? { ...record.value.assertions[0]!, text: input.text!, sources: [{ kind: "manual" as const }] } : null;
    return { ok: true as const, value: { current: current.entry, proposedAssertion: proposed } };
  }
  async inspectMemoryMaintenance(signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const listed = await this.list(signal, options);
    return listed.ok ? { ok: true as const, value: { stored: listed.entries.length, pending: 0, expired: 0, disabled: listed.entries.filter(entry => !entry.enabled).length, duplicateSuggestions: 0 } } : listed;
  }
  previewImport(input: MemoryImportEntry[], signal = new AbortController().signal): Promise<MemoryResult<MemoryImportPreview>> {
    return this.#result(signal, async () => {
      const entries = memoryImportEntriesSchema.parse(input), document = await this.#read() ?? migration();
      return { snapshot: importSnapshot(document), stored: document.entries.length, available: MEMORY_MAX_ENTRIES - document.entries.length,
        entries: entries.map(entry => ({ ...entry, existingId: document.entries.find(item => item.state === "active" && item.scope.kind === "workspace" && item.text === entry.text && item.category === (entry.kind === "preference" ? "preference" : "note"))?.id ?? null })) };
    });
  }
  confirmImport(input: MemoryImportConfirm, threadId: string, signal = new AbortController().signal): Promise<MemoryResult<MemoryImportReceipt>> {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const parsed = memoryImportConfirmSchema.parse(input);
      const requestHash = createHash("sha256").update(JSON.stringify({ threadId, entries: parsed.entries, snapshot: parsed.snapshot })).digest("hex");
      const old = document.importReceipts.find(item => item.operationId === parsed.operationId);
      if (old) { if (old.requestHash !== requestHash || old.threadId !== threadId) fail("MEMORY_REVISION_CONFLICT", "Import content or Thread changed"); return old; }
      if (parsed.snapshot !== importSnapshot(document)) fail("MEMORY_REVISION_CONFLICT", "Memory changed after preview");
      if (document.importReceipts.length >= MEMORY_IMPORT_MAX_RECEIPTS) fail("MEMORY_LIMIT_EXCEEDED", "Import receipt capacity reached");
      const items: MemoryImportReceipt["items"] = [];
      for (const entry of parsed.entries) {
        const category = entry.kind === "preference" ? "preference" : "note";
        const existing = document.entries.find(item => item.state === "active" && item.scope.kind === "workspace" && item.text === entry.text && item.category === category);
        if (existing) { items.push({ id: existing.id, status: "existing" }); continue; }
        if (document.entries.length >= MEMORY_MAX_ENTRIES) fail("MEMORY_LIMIT_EXCEEDED", "Memory capacity reached; no import saved");
        const id = randomUUID();
        document.entries.push({ id, revision: 1, text: entry.text, uncertain: false, category, scope: { kind: "workspace" }, pinned: false, state: "active", createdAt: stamp, updatedAt: stamp, sources: [{ kind: "manual" }], replaces: [], supersededBy: null, withdrawal: null });
        items.push({ id, status: "saved" });
      }
      const receipt = { operationId: parsed.operationId, requestHash, threadId, items, committedAt: stamp };
      document.importReceipts.push(receipt); return receipt;
    }));
  }
  importReceipt(operationId: string, threadId: string, signal = new AbortController().signal): Promise<MemoryResult<MemoryImportReceipt | null>> {
    return this.#result(signal, async () => { const document = await this.#read(); if (document) return document.importReceipts.find(item => item.operationId === operationId && item.threadId === threadId) ?? null; const legacy = await this.#legacy.importReceipt(operationId, threadId, signal); if (!legacy.ok) fail("MEMORY_FILE_INVALID", legacy.error.message); return legacy.value; });
  }
  async checkCandidateCapacity(signal = new AbortController().signal) { return this.#result(signal, async () => { await this.#read() ?? migration(); return { pendingCount: 0, canStart: false }; }); }
  async listCandidates(_input?: unknown, _signal?: AbortSignal, _options?: MemoryWriteOptions): Promise<MemoryResult<CandidatePage>> { return { ok: true as const, value: { candidates: [], nextOffset: null, truncated: false } }; }
  async getCandidate(_id: string, signal = new AbortController().signal, _options?: MemoryWriteOptions): Promise<MemoryResult<CandidatePreview>> { return this.#result(signal, async () => removed()); }
  async resolveCandidate(_input: unknown, signal = new AbortController().signal, _options?: MemoryWriteOptions): Promise<MemoryResult<CandidateResolution>> { return this.#result(signal, async () => { await this.#read() ?? migration(); return removed(); }); }
  async commitCandidateBatch(_input: unknown, signal = new AbortController().signal, _options?: MemoryWriteOptions): Promise<MemoryResult<CandidateBatchResult>> { return this.#result(signal, async () => { await this.#read() ?? migration(); return removed(); }); }
  async getConsolidationCursor(_threadId: string, _signal?: AbortSignal): Promise<MemoryResult<ConsolidationCursor | null>> { return { ok: true as const, value: null }; }
  async getConsolidationReceipt(_threadId: string, _signal?: AbortSignal): Promise<MemoryResult<ConsolidationReceipt | null>> { return { ok: true as const, value: null }; }
}
export function createMemoryStore(workspace: string): TemporalWorkspaceMemoryStore { return new V6MemoryStore(workspace); }
