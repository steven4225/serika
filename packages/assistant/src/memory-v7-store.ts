import { constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hashCanonicalJson } from "@serika/core";
import { acquireFlock } from "./flock.js";
import { assertExperimentalDataPaths } from "./experimental-data.js";
import { MemoryStoreError, memoryScopeSchema, sameMemoryScope, visibleMemoryScope, type MemoryScope, MEMORY_FILE_MAX_BYTES, MEMORY_MAX_ENTRIES, type MemoryEntry, type MemoryAddInput, type MemoryUpdateInput, type MemoryWriteOptions, type MemoryFailure, type ScopedMemoryStore, type MemoryResult } from "./memory-types.js";
import { memoryLibrarySchema, memoryLibraryView, memoryLibraryDocuments, memoryLibraryActionSchema, memoryDocumentChunks, emptyMemoryLibrary, type MemoryLibraryAction } from "./memory-library.js";
import { memoryImportEntriesSchema, memoryImportConfirmSchema, memoryImportReceiptSchema, MEMORY_IMPORT_MAX_RECEIPTS, type MemoryImportEntry, type MemoryImportPreview, type MemoryImportConfirm, type MemoryImportReceipt } from "./memory-import.js";

const string = z.string().min(1);
const time = z.iso.datetime({ offset: true });
export const v7SourceSchema = z.union([
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("conversation"), threadId: string, messageId: string, quote: z.string().refine(value => Buffer.byteLength(value) <= 2048), sentAt: time.nullable(),
    proposal: z.object({ messageId: string, quote: string.refine(value => Buffer.byteLength(value) <= 2048) }).strict().optional() }).strict(),
]);
const scope = memoryScopeSchema;
const identity = z.object({ subject: string, attribute: string, value: string }).strict();
const body = string.refine(text => text.trim().length > 0 && Buffer.byteLength(text) <= 2048, "Memory text exceeds 2048 bytes or is blank");
const entrySchema = z.object({ id: string, revision: z.number().int().positive(), text: body, uncertain: z.boolean().default(false), category: z.enum(["preference", "note", "document"]),
  identity: identity.optional(), scope, pinned: z.boolean(), state: z.enum(["active", "disabled", "superseded", "retracted"]),
  createdAt: time, updatedAt: time, sources: z.array(v7SourceSchema).min(1),
  privacyExcluded: z.boolean().optional(), replaces: z.array(string), supersededBy: string.nullable(), withdrawal: v7SourceSchema.nullable() }).strict();
const segment = z.object({ throughMessageId: string, prefixHash: string }).strict();
const progress = z.object({ threadId: string, projectId: string.nullable(), throughMessageId: string.nullable(), prefixHash: string.nullable(),
  pending: z.array(z.object({ messageId: string, prefixHash: string, offset: z.number().int().nonnegative().optional() }).strict()).default([]),
  retry: z.object({ ...segment.shape, failures: z.number().int().min(1).max(3) }).strict().nullable() }).strict();
const documentSchema = z.object({ version: z.literal(7), lastWrittenAt: time.nullable(), entries: z.array(entrySchema).max(512),
  excludedSources: z.array(z.object({ threadId: string, messageId: string }).strict()).default([]),
  progress: z.array(progress), suppressed: z.array(z.object({ threadId: string, messageId: string, scope, identity: identity.pick({ subject: true, attribute: true }) }).strict()),
  library: memoryLibrarySchema, importReceipts: z.array(memoryImportReceiptSchema).max(MEMORY_IMPORT_MAX_RECEIPTS) }).strict();
export const validateV7MemoryDocument = (value: unknown): V7Document => documentSchema.parse(value);
export type V7Source = z.infer<typeof v7SourceSchema>;
export type V7Entry = z.infer<typeof entrySchema>;
export type V7Document = z.infer<typeof documentSchema>;
export type V7Change = { operation: "add" | "replace"; text: string; uncertain?: boolean; category: V7Entry["category"]; scope: MemoryScope; identity?: V7Entry["identity"]; source: V7Source; id?: string; expectedRevision?: number }
  | { operation: "retract" | "undo"; id: string; expectedRevision: number; source: V7Source };
export interface V7Commit { expectedProgress?: V7Document["progress"][number] | null; progress?: V7Document["progress"][number]; now?: Date; automatic?: boolean; reextract?: boolean; sourceOrder?: readonly string[]; initial?: { pinned: boolean; disabled: boolean } }
const empty = (): V7Document => ({ version: 7, lastWrittenAt: null, entries: [], excludedSources: [], progress: [], suppressed: [], library: emptyMemoryLibrary(), importReceipts: [] });
function fail(code: ConstructorParameters<typeof MemoryStoreError>[0], message: string): never { throw new MemoryStoreError(code, message); }
const migration = (file: string): never => {
  const nodeExecutable = process.versions.electron
    ? z.object({ nodeExecutable: z.string() }).parse(JSON.parse(readFileSync(new URL("./node-runtime.json", import.meta.url), "utf8"))).nodeExecutable : process.execPath;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [nodeExecutable, fileURLToPath(new URL("../scripts/memory-upgrade.mjs", import.meta.url)), "--memory", file, "--project", "/Users/a1-6/Code/agents/serika-v2"].map(quote).join(" ");
  return fail("MEMORY_MIGRATION_REQUIRED", `Memory 需要显式升级到 v7。先预览：${command} --dry-run；确认后升级：${command} --upgrade`);
};
const importSnapshot = (document: V7Document) => createHash("sha256").update(JSON.stringify(document)).digest("hex");
export function v7Projection(entry: V7Entry): MemoryEntry {
  return { id: entry.id, revision: entry.revision, text: entry.text, uncertain: entry.uncertain, kind: entry.category === "preference" ? "preference" : "note",
    enabled: entry.state === "active", status: entry.state === "active" ? "active" : "disabled", scope: entry.scope, pinned: entry.pinned,
    source: entry.sources[0]!, createdAt: entry.createdAt, updatedAt: entry.updatedAt, expiresAt: null, v7: structuredClone(entry) };
}
export function v7Conflicts(entries: readonly V7Entry[]): string[][] {
  const groups = new Map<string, V7Entry[]>();
  for (const entry of entries.filter(entry => entry.state === "active" && entry.identity)) {
    const key = hashCanonicalJson([entry.scope, entry.identity!.subject, entry.identity!.attribute]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].filter(group => new Set(group.map(entry => entry.identity!.value)).size > 1).map(group => group.map(entry => entry.id));
}

/** Atomic v7 Memory storage. Older files require the explicit one-time migration. */
export class V7MemoryStore {
  readonly #file: string;
  readonly #projectId: string | null;
  readonly #boundary: ((phase: "before-rename" | "after-rename") => void | Promise<void>) | undefined;
  constructor(filePath: string, projectId: string | null = null, boundary?: (phase: "before-rename" | "after-rename") => void | Promise<void>) {
    this.#file = resolve(filePath); this.#projectId = string.nullable().parse(projectId); this.#boundary = boundary;
  }
  async #result<T>(signal: AbortSignal, body: () => Promise<T>): Promise<{ ok: true; value: T } | MemoryFailure> {
    try { signal.throwIfAborted(); return { ok: true, value: await body() }; }
    catch (error) {
      if (error instanceof MemoryStoreError) return { ok: false, error: { code: error.code, message: error.message } };
      signal.throwIfAborted();
      return { ok: false, error: { code: error instanceof z.ZodError ? "INVALID_INPUT" : "WRITE_FAILED", message: error instanceof z.ZodError ? "Invalid v7 Memory data" : "Memory operation failed" } };
    }
  }
  async #read(): Promise<V7Document> {
    for (const path of [dirname(dirname(this.#file)), dirname(this.#file), this.#file]) {
      try { if ((await lstat(path)).isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
    }
    const handle = await open(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let parsed: unknown;
    try {
      if ((await handle.stat()).size > MEMORY_FILE_MAX_BYTES) fail("MEMORY_LIMIT_EXCEEDED", "Memory exceeds 16 MiB");
      const buffer = Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > MEMORY_FILE_MAX_BYTES) fail("MEMORY_LIMIT_EXCEEDED", "Memory exceeds 16 MiB");
      try { parsed = JSON.parse(buffer.subarray(0, size).toString("utf8")); } catch { fail("MEMORY_FILE_INVALID", "Invalid Memory JSON"); }
    } finally { await handle.close(); }
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 7) migration(this.#file);
    const checked = documentSchema.safeParse(parsed);
    if (!checked.success) fail("MEMORY_FILE_INVALID", "Invalid v7 Memory file");
    const document = checked.data;
    if (new Set(document.entries.map(entry => entry.id)).size !== document.entries.length || new Set(document.progress.map(item => JSON.stringify([item.threadId, item.projectId]))).size !== document.progress.length) fail("MEMORY_FILE_INVALID", "Duplicate Memory identity");
    return document;
  }
  async #mutate<T>(signal: AbortSignal, body: (document: V7Document, stamp: string) => T, now?: Date): Promise<T> {
    assertExperimentalDataPaths([this.#file]);
    await this.#read();
    signal.throwIfAborted();
    const directory = dirname(this.#file); await mkdir(directory, { recursive: true });
    const lock = await acquireFlock(`${this.#file}.lock`, signal);
    let renamed = false;
    const temporary = join(directory, `.memory.json.runloom-${randomUUID()}.tmp`);
    try {
      const document = await this.#read(); signal.throwIfAborted();
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
  #visible(entry: V7Entry): boolean { return visibleMemoryScope(entry.scope, this.#projectId); }
  #scoped(document: V7Document): V7Document {
    const entries = document.entries.filter(entry => this.#visible(entry));
    const byId = new Map(document.entries.map(entry => [entry.id, entry]));
    const documents = document.library.documents.filter(item => visibleMemoryScope(item.scope, this.#projectId) && item.entryIds.every(id => !byId.has(id) || sameMemoryScope(byId.get(id)!.scope, item.scope)));
    const folders = document.library.folders.filter(folder => documents.some(item => item.folderId === folder.id) || !document.library.documents.some(item => item.folderId === folder.id));
    return { ...document, entries, progress: document.progress.filter(item => item.projectId === this.#projectId),
      suppressed: document.suppressed.filter(item => visibleMemoryScope(item.scope, this.#projectId)),
      importReceipts: document.importReceipts.filter(item => item.projectId === this.#projectId), library: { ...document.library, documents, folders } };
  }
  readV7(signal = new AbortController().signal) { return this.#result(signal, async () => this.#scoped(await this.#read())); }
  async list(signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const result = await this.#result(signal, () => this.#read());
    if (!result.ok) return result;
    return { ok: true as const, entries: result.value.entries.filter(entry => this.#visible(entry)).map(v7Projection) };
  }
  async get(id: string, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const listed = await this.list(signal, options); if (!listed.ok) return listed;
    const entry = listed.entries.find(entry => entry.id === id);
    return entry ? { ok: true as const, entry } : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "Memory not found" } };
  }
  writeV7(changes: V7Change[], signal = new AbortController().signal, options: V7Commit = {}) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      if (options.progress && options.progress.projectId !== this.#projectId) fail("MEMORY_SCOPE_INVALID", "Extraction progress belongs to another project");
      if (options.progress && JSON.stringify(document.progress.find(item => item.threadId === options.progress!.threadId && item.projectId === this.#projectId) ?? null) !== JSON.stringify(options.expectedProgress ?? null)) fail("MEMORY_CURSOR_MISMATCH", "Extraction progress changed");
      const written: MemoryEntry[] = [];
      for (const raw of changes) {
        if (raw.operation === "add" || raw.operation === "replace") {
          const requestedScope = memoryScopeSchema.parse(raw.scope);
          if (raw.operation === "add" && raw.category === "document" && requestedScope.kind !== "project") fail("MEMORY_PROJECT_REQUIRED", "新项目文档需要项目作用域");
          if (!visibleMemoryScope(requestedScope, this.#projectId)) fail("MEMORY_SCOPE_INVALID", "Memory belongs to another project");
        }
        const source = v7SourceSchema.parse(raw.source);
        if (source.kind === "conversation" && !source.quote.trim()) fail("MEMORY_SOURCE_INVALID", "Conversation source quote is empty");
        if (source.kind === "conversation" && document.excludedSources.some(item => item.threadId === source.threadId && (item.messageId === source.messageId || item.messageId === source.proposal?.messageId))) fail("MEMORY_SOURCE_INVALID", "Excluded source");
        if ((raw.operation === "add" || raw.operation === "replace") && document.suppressed.some(item => source.kind === "conversation" && item.threadId === source.threadId && item.messageId === source.messageId &&
          (sameMemoryScope(item.scope, raw.scope) && raw.identity && item.identity.subject === raw.identity.subject && item.identity.attribute === raw.identity.attribute))) continue;
        let target = raw.operation === "add" ? undefined : document.entries.find(entry => entry.id === raw.id && this.#visible(entry));
        if (raw.operation !== "add" && (!target || target.revision !== raw.expectedRevision)) fail("MEMORY_REVISION_CONFLICT", "Memory target changed or is missing");
        if (raw.operation === "replace" && target && !sameMemoryScope(target.scope, raw.scope)) fail("MEMORY_SCOPE_INVALID", "Replacement cannot change scope");
        if (target?.privacyExcluded) fail("MEMORY_SOURCE_INVALID", "Excluded source cannot be restored or rewritten");
        const order = options.sourceOrder;
        const position = source.kind === "conversation" ? order?.indexOf(source.messageId) ?? -1 : -1;
        const newer = (entry: V7Entry) => source.kind === "conversation" && position >= 0 && entry.sources.some(item => item.kind === "conversation" && item.threadId === source.threadId && (order?.indexOf(item.messageId) ?? -1) > position);
        if (options.automatic && target && (newer(target) || options.reextract) && raw.operation !== "replace") continue;
        if (raw.operation === "add" || raw.operation === "replace") {
          if (target && target.state !== "active") fail("MEMORY_DISABLED", "Replace requires an active target");
          const later = options.automatic ? document.entries.find(entry => entry.state === "active" && sameMemoryScope(entry.scope, raw.scope) && newer(entry) && (entry.id === target?.id || raw.identity && entry.identity && entry.identity.subject === raw.identity.subject && entry.identity.attribute === raw.identity.attribute)) : undefined;
          if (later || options.reextract) target = undefined;

          const entry: V7Entry = entrySchema.parse({ id: randomUUID(), revision: 1, text: raw.text, uncertain: raw.uncertain ?? false, category: raw.category, ...(raw.identity ? { identity: raw.identity } : {}),
            scope: raw.scope, pinned: options.initial?.pinned ?? target?.pinned ?? false, state: options.initial?.disabled ? "disabled" : "active", createdAt: stamp, updatedAt: stamp, sources: [source], replaces: target ? [target.id] : [], supersededBy: later?.id ?? null, withdrawal: null });
          if (later) entry.state = "superseded";
          if (document.entries.length >= MEMORY_MAX_ENTRIES) fail("MEMORY_LIMIT_EXCEEDED", "Memory 已满，未保存；请勿声称已记住");
          if (target) { target.state = "superseded"; target.supersededBy = entry.id; target.revision++; target.updatedAt = stamp; }
          if (target?.category === "document") {
            for (const documentRef of document.library.documents) documentRef.entryIds = documentRef.entryIds.map(id => id === target!.id ? entry.id : id);
            document.library.revision++;
          }
          document.entries.push(entry); written.push(v7Projection(entry));
        } else if (raw.operation === "retract") {
          if (target!.state !== "active" && target!.state !== "disabled") fail("MEMORY_DISABLED", "Withdrawal requires a current target");
          target!.state = "retracted"; target!.withdrawal = source; target!.revision++; target!.updatedAt = stamp; written.push(v7Projection(target!));
        } else {
          if (target!.state === "active" && target!.replaces.length) {
            for (const id of target!.replaces) {
              const old = document.entries.find(entry => entry.id === id);
              if (!old || !sameMemoryScope(old.scope, target!.scope) || old.privacyExcluded || old.supersededBy !== target!.id || old.state !== "superseded") fail("MEMORY_REVISION_CONFLICT", "Undo target changed");
              old.state = "active"; old.supersededBy = null; old.sources.push(source); old.revision++; old.updatedAt = stamp; written.push(v7Projection(old));
            }
            target!.state = "retracted"; target!.withdrawal = source;
          } else if (target!.state === "retracted" && target!.supersededBy === null && target!.replaces.every(id => document.entries.some(entry => entry.id === id && sameMemoryScope(entry.scope, target!.scope) && entry.state === "superseded" && entry.supersededBy === target!.id))) { target!.state = "active"; target!.withdrawal = null; target!.sources.push(source); }
          else fail("MEMORY_REVISION_CONFLICT", "Memory cannot be undone in its current state");
          target!.revision++; target!.updatedAt = stamp; written.push(v7Projection(target!));
        }
      }
      const reserveBytes = Math.max(2048, ...written.map(entry => Buffer.byteLength(JSON.stringify(entry.v7))));
      if (options.automatic && written.length && (document.entries.length >= MEMORY_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(document)) + reserveBytes > MEMORY_FILE_MAX_BYTES)) fail("MEMORY_LIMIT_EXCEEDED", "自动沉淀已停止，为显式写入保留至少一条同等大小记忆的余量");
      if (options.progress) document.progress = [...document.progress.filter(item => item.threadId !== options.progress!.threadId || item.projectId !== this.#projectId), options.progress];
      return written;
    }, options.now));
  }
  mergeV7(input: { members: Array<{ id: string; revision: number }>; text: string }, signal = new AbortController().signal) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const request = z.object({ members: z.array(z.object({ id: string, revision: z.number().int().positive() }).strict()).min(2), text: body }).strict().parse(input);
      if (new Set(request.members.map(member => member.id)).size !== request.members.length) fail("INVALID_INPUT", "Merge members must be distinct");
      const members = request.members.map(member => {
        const entry = document.entries.find(entry => entry.id === member.id && this.#visible(entry));
        if (!entry || entry.revision !== member.revision || entry.state !== "active" || entry.privacyExcluded) fail("MEMORY_REVISION_CONFLICT", "Merge member changed or is not current");
        return entry;
      });
      const first = members[0]!;
      if (first.category === "document" || !first.identity || members.some(entry => !sameMemoryScope(entry.scope, first.scope) || entry.category !== first.category || hashCanonicalJson(entry.identity ?? null) !== hashCanonicalJson(first.identity!)) ||
        document.library.documents.some(document => document.entryIds.some(id => request.members.some(member => member.id === id)))) fail("MEMORY_SOURCE_INVALID", "Merge requires the same literal fact and category");
      const clauses = (text: string) => text.split(/[。！？；;，,\n]/u).map(clause => clause.trim()).filter(Boolean);
      const originals = new Set(members.flatMap(entry => clauses(entry.text))), merged = new Set(clauses(request.text));
      if (originals.size !== merged.size || [...originals].some(clause => !merged.has(clause))) fail("MEMORY_SOURCE_INVALID", "Merge must preserve every original literal clause without adding facts");
      if (Buffer.byteLength(request.text) >= members.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)) fail("INVALID_INPUT", "Merge must reduce the current text");
      if (document.entries.length >= MEMORY_MAX_ENTRIES) fail("MEMORY_LIMIT_EXCEEDED", "Memory 已满，合并未保存");
      const sources = [...new Map(members.flatMap(entry => entry.sources).map(source => [JSON.stringify(source), source])).values()];
      const entry: V7Entry = { id: randomUUID(), revision: 1, text: request.text, uncertain: members.some(entry => entry.uncertain), category: first.category,
        identity: first.identity, scope: first.scope, pinned: members.some(entry => entry.pinned), state: "active", createdAt: stamp, updatedAt: stamp,
        sources, replaces: members.map(entry => entry.id), supersededBy: null, withdrawal: null };
      for (const member of members) { member.state = "superseded"; member.supersededBy = entry.id; member.revision++; member.updatedAt = stamp; }
      document.entries.push(entry);
      return v7Projection(entry);
    }));
  }
  excludeSources(threadId: string, messageIds: string[], signal = new AbortController().signal) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const additions = messageIds.filter(messageId => !document.excludedSources.some(item => item.threadId === threadId && item.messageId === messageId));
      if (!additions.length) return null;
      document.excludedSources.push(...additions.map(messageId => ({ threadId, messageId })));
      const excluded = new Set(messageIds);
      const matches = (source: V7Source) => source.kind === "conversation" && source.threadId === threadId &&
        (excluded.has(source.messageId) || !!source.proposal && excluded.has(source.proposal.messageId));
      for (const entry of document.entries) {
        if (!entry.sources.some(matches) && !(entry.withdrawal && matches(entry.withdrawal))) continue;
        if (entry.privacyExcluded) continue;
        entry.state = "retracted"; entry.privacyExcluded = true; entry.text = "[Excluded source]";
        delete entry.identity; entry.uncertain = false;
        entry.sources = entry.sources.map(source => source.kind === "conversation" ? { ...source, quote: "", proposal: undefined } : source);
        entry.withdrawal = null; entry.revision++; entry.updatedAt = stamp;
      }
      // Projected exclusions change extraction input, so old prefix-CAS progress must be rebuilt.
      document.progress = document.progress.filter(item => item.threadId !== threadId);
      return null;
    }));
  }
  async add(input: MemoryAddInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const source = input.source?.kind === "conversation" ? { ...input.source, sentAt: null } : { kind: "manual" as const };
    const result = await this.writeV7([{ operation: "add", text: input.text, scope: input.scope, category: input.kind === "preference" ? "preference" : "note", source }], signal, { ...(options?.now ? { now: options.now } : {}), initial: { pinned: input.pinned ?? false, disabled: input.enabled === false || input.status === "disabled" } });
    return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
  }
  async update(id: string, input: MemoryUpdateInput, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV7(signal); if (!writable.ok) return writable;
    if (input.text !== undefined) {
      const current = await this.get(id, signal, options); if (!current.ok) return current;
      const result = await this.writeV7([{ operation: "replace", id, expectedRevision: input.expectedRevision, text: input.text,
        scope: current.entry.scope!, category: current.entry.v7?.category ?? "note", ...(current.entry.v7?.identity ? { identity: { ...current.entry.v7.identity, value: input.text } } : {}), source: { kind: "manual" } }], signal, { ...(options?.now ? { now: options.now } : {}), initial: { pinned: input.pinned ?? current.entry.pinned ?? false, disabled: input.enabled === false || input.status === "disabled" } });
      return result.ok ? { ok: true as const, entry: result.value[0]! } : result;
    }
    const result = await this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const entry = document.entries.find(entry => entry.id === id && this.#visible(entry));
      if (!entry || entry.revision !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "Memory changed");
      if (input.pinned !== undefined) entry.pinned = input.pinned;
      if (input.status === "disabled" || input.enabled === false) { if (entry.state !== "active" && entry.state !== "disabled") fail("MEMORY_DISABLED", "Only current memory can be disabled"); entry.state = "disabled"; }
      entry.revision++; entry.updatedAt = stamp; return v7Projection(entry);
    }, options?.now));
    return result.ok ? { ok: true as const, entry: result.value } : result;
  }
  async deleteMemory(input: { id: string; expectedRevision: number }, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const result = await this.#result(signal, () => this.#mutate(signal, document => {
      const entry = document.entries.find(entry => entry.id === input.id && this.#visible(entry));
      if (!entry || entry.revision !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "Memory changed");
      if (!entry.privacyExcluded && !entry.identity && entry.sources.some(source => source.kind === "conversation")) fail("MEMORY_SOURCE_INVALID", "Conversation memory needs an identity before deletion");
      for (const source of entry.sources) if (source.kind === "conversation" && entry.identity) document.suppressed.push({ threadId: source.threadId, messageId: source.messageId, scope: entry.scope, identity: { subject: entry.identity.subject, attribute: entry.identity.attribute } });
      document.entries = document.entries.filter(item => item.id !== entry.id); return input.id;
    }, options?.now));
    return result.ok ? { ok: true as const, id: result.value } : result;
  }
  async delete(id: string, signal = new AbortController().signal, options?: MemoryWriteOptions) {
    const writable = await this.readV7(signal); if (!writable.ok) return writable;
    const current = await this.get(id, signal, options);
    return current.ok ? this.deleteMemory({ id, expectedRevision: current.entry.revision! }, signal, options) : current;
  }
  async readReferenceMaterial(signal: AbortSignal, now: Date) {
    const document = await this.readV7(signal); if (!document.ok) return document;
    return { ok: true as const, value: { entries: document.value.entries.map(v7Projection), library: document.value.library } };
  }
  async getLibrary(signal = new AbortController().signal) {
    const material = await this.readReferenceMaterial(signal, new Date());
    return material.ok ? { ok: true as const, value: memoryLibraryView(material.value.library, material.value.entries) } : material;
  }
  async readLibraryDocument(id: string, signal = new AbortController().signal) {
    const material = await this.readReferenceMaterial(signal, new Date()); if (!material.ok) return material;
    const found = memoryLibraryDocuments(material.value.library, material.value.entries).find(item => item.id === id);
    return found ? { ok: true as const, value: { ...found, libraryRevision: material.value.library.revision } } : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Document not found" } };
  }
  changeLibrary(input: MemoryLibraryAction, signal = new AbortController().signal) {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const action = memoryLibraryActionSchema.parse(input), library = document.library;
      const visibleLibrary = this.#scoped(document).library;
      if (action.expectedRevision !== library.revision) fail("MEMORY_REVISION_CONFLICT", "Library changed");
      if (action.operation === "create-folder") library.folders.push({ id: action.id, name: action.name });
      else if (action.operation === "rename-folder") { const folder = visibleLibrary.folders.find(item => item.id === action.id); if (!folder) fail("MEMORY_ENTRY_NOT_FOUND", "Folder missing"); folder.name = action.name; }
      else if (action.operation === "remove-folder") { if (library.documents.some(item => item.folderId === action.id)) fail("INVALID_INPUT", "Folder is not empty"); library.folders = library.folders.filter(item => item.id !== action.id); for (const item of library.documents) if (item.folderId === action.id) item.folderId = null; }
      else {
        if (action.folderId !== null && !visibleLibrary.folders.some(item => item.id === action.folderId)) fail("MEMORY_ENTRY_NOT_FOUND", "Folder missing");
        let item = library.documents.find(item => item.id === action.id);
        if (item && !visibleLibrary.documents.some(visible => visible.id === item!.id)) fail("MEMORY_ENTRY_NOT_FOUND", "Document missing");
        if (action.operation === "save-document") {
          if (item?.entryIds.some(id => !document.entries.some(entry => entry.id === id))) fail("MEMORY_ENTRY_NOT_FOUND", "Document body missing");
          for (const ref of action.entries) { const entry = document.entries.find(entry => entry.id === ref.id && this.#visible(entry)); if (!entry) fail("MEMORY_ENTRY_NOT_FOUND", "Document body missing"); if (entry.revision !== ref.revision) fail("MEMORY_REVISION_CONFLICT", "Document body changed"); }
          if (!item && action.id.startsWith("memory:")) {
            const old = document.entries.find(entry => `memory:${entry.id}` === action.id && this.#visible(entry));
            if (!old || action.entries.length !== 1 || action.entries[0]?.id !== old.id) fail("INVALID_INPUT", "Document ownership is invalid");
            item = { id: action.id, title: action.title, folderId: action.folderId, entryIds: [old.id], scope: old.scope }; library.documents.push(item);
          }
          if (!item && (action.entries.length || !z.uuid().safeParse(action.id).success)) fail("INVALID_INPUT", "New document cannot claim existing entries");
          if (item && JSON.stringify(item.entryIds) !== JSON.stringify(action.entries.map(entry => entry.id))) fail("MEMORY_REVISION_CONFLICT", "Document references changed");
          const documentScope = item?.scope ?? (this.#projectId === null ? null : { kind: "project" as const, projectId: this.#projectId });
          if (documentScope === null) fail("MEMORY_PROJECT_REQUIRED", "新项目文档需要先选择项目");
          if (action.entries.some(ref => !sameMemoryScope(document.entries.find(entry => entry.id === ref.id)!.scope, documentScope))) fail("MEMORY_SCOPE_INVALID", "Document body belongs to another scope");
          let chunks: string[]; try { chunks = memoryDocumentChunks(action.text); } catch { fail("INVALID_INPUT", "文档包含过长的连续空白，请整理后再保存"); }
          const ids = chunks.map(text => { const entry: V7Entry = { id: randomUUID(), revision: 1, text, uncertain: false, category: "document", scope: documentScope, pinned: false, state: "active", createdAt: stamp, updatedAt: stamp, sources: [{ kind: "manual" }], replaces: [], supersededBy: null, withdrawal: null }; document.entries.push(entry); return entry.id; });
          for (const ref of action.entries) { const old = document.entries.find(entry => entry.id === ref.id)!; old.state = "superseded"; old.supersededBy = ids[0]!; old.revision++; old.updatedAt = stamp; }
          if (!item) { item = { id: action.id, title: action.title, folderId: action.folderId, entryIds: ids, scope: documentScope }; library.documents.push(item); } else item.entryIds = ids;
        }
        if (!item) fail("MEMORY_ENTRY_NOT_FOUND", "Document missing");
        item.title = action.title; item.folderId = action.folderId;
      }
      library.revision++; const scoped = this.#scoped(document); return memoryLibraryView(scoped.library, scoped.entries.map(v7Projection));
    }));
  }
  previewImport(input: MemoryImportEntry[], signal = new AbortController().signal): Promise<MemoryResult<MemoryImportPreview>> {
    return this.#result(signal, async () => {
      const entries = memoryImportEntriesSchema.parse(input), document = await this.#read();
      if (entries.some(entry => !visibleMemoryScope(entry.scope, this.#projectId))) fail("MEMORY_SCOPE_INVALID", "Import belongs to another project");
      return { snapshot: importSnapshot(document), stored: this.#scoped(document).entries.length, available: MEMORY_MAX_ENTRIES - document.entries.length,
        entries: entries.map(entry => ({ ...entry, existingId: document.entries.find(item => item.state === "active" && sameMemoryScope(item.scope, entry.scope) && item.text === entry.text && item.category === (entry.kind === "preference" ? "preference" : "note"))?.id ?? null })) };
    });
  }
  confirmImport(input: MemoryImportConfirm, threadId: string, signal = new AbortController().signal): Promise<MemoryResult<MemoryImportReceipt>> {
    return this.#result(signal, () => this.#mutate(signal, (document, stamp) => {
      const parsed = memoryImportConfirmSchema.parse(input);
      if (parsed.entries.some(entry => !visibleMemoryScope(entry.scope, this.#projectId))) fail("MEMORY_SCOPE_INVALID", "Import belongs to another project");
      const requestHash = createHash("sha256").update(JSON.stringify({ threadId, projectId: this.#projectId, entries: parsed.entries, snapshot: parsed.snapshot })).digest("hex");
      const old = document.importReceipts.find(item => item.operationId === parsed.operationId);
      if (old) { if (old.requestHash !== requestHash || old.threadId !== threadId || old.projectId !== this.#projectId) fail("MEMORY_REVISION_CONFLICT", "Import content or Thread changed"); return old; }
      if (parsed.snapshot !== importSnapshot(document)) fail("MEMORY_REVISION_CONFLICT", "Memory changed after preview");
      if (document.importReceipts.length >= MEMORY_IMPORT_MAX_RECEIPTS) fail("MEMORY_LIMIT_EXCEEDED", "Import receipt capacity reached");
      const items: MemoryImportReceipt["items"] = [];
      for (const entry of parsed.entries) {
        const category = entry.kind === "preference" ? "preference" : "note";
        const existing = document.entries.find(item => item.state === "active" && sameMemoryScope(item.scope, entry.scope) && item.text === entry.text && item.category === category);
        if (existing) { items.push({ id: existing.id, status: "existing" }); continue; }
        if (document.entries.length >= MEMORY_MAX_ENTRIES) fail("MEMORY_LIMIT_EXCEEDED", "Memory capacity reached; no import saved");
        const id = randomUUID();
        document.entries.push({ id, revision: 1, text: entry.text, uncertain: false, category, scope: entry.scope, pinned: false, state: "active", createdAt: stamp, updatedAt: stamp, sources: [{ kind: "manual" }], replaces: [], supersededBy: null, withdrawal: null });
        items.push({ id, status: "saved" });
      }
      const receipt = { operationId: parsed.operationId, requestHash, threadId, projectId: this.#projectId, items, committedAt: stamp };
      document.importReceipts.push(receipt); return receipt;
    }));
  }
  importReceipt(operationId: string, threadId: string, signal = new AbortController().signal): Promise<MemoryResult<MemoryImportReceipt | null>> {
    return this.#result(signal, async () => (await this.#read()).importReceipts.find(item => item.operationId === operationId && item.threadId === threadId && item.projectId === this.#projectId) ?? null);
  }
}
export function createMemoryStore(filePath: string, projectId: string | null = null): ScopedMemoryStore { return new V7MemoryStore(filePath, projectId); }
