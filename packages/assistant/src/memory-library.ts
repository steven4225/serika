import { z } from "zod";
import type { MemoryEntry } from "./memory-store.js";

const id = z.string().min(1).max(256);
const label = (max: number) => z.string().trim().min(1).max(max).refine(text => !/[\x00-\x1f]/.test(text));
const scope = z.discriminatedUnion("kind", [z.object({ kind: z.literal("workspace") }).strict(), z.object({ kind: z.literal("thread"), threadId: id }).strict()]);
export const memoryLibrarySchema = z.object({
  revision: z.number().int().nonnegative(),
  folders: z.array(z.object({ id, name: label(80) }).strict()).max(64),
  documents: z.array(z.object({ id, title: label(160), folderId: id.nullable(), entryIds: z.array(id).min(1).max(64), scope }).strict()).max(512),
}).strict();
export type MemoryLibrary = z.infer<typeof memoryLibrarySchema>;
const base = { expectedRevision: z.number().int().nonnegative() };
const text = z.string().min(1).refine(text => text.trim().length > 0 && !text.includes("\0") && Buffer.byteLength(text) <= 64 * 1024, "文档需为非空文本，最多 64 KiB");
export const memoryLibraryActionSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("create-folder"), id: z.uuid(), name: label(80) }).strict(),
  z.object({ ...base, operation: z.literal("rename-folder"), id, name: label(80) }).strict(),
  z.object({ ...base, operation: z.literal("remove-folder"), id }).strict(),
  z.object({ ...base, operation: z.literal("organize-document"), id, title: label(160), folderId: id.nullable() }).strict(),
  z.object({ ...base, operation: z.literal("save-document"), id, title: label(160), folderId: id.nullable(), text,
    entries: z.array(z.object({ id, revision: z.number().int().positive() }).strict()).max(64) }).strict(),
]);
export type MemoryLibraryAction = z.infer<typeof memoryLibraryActionSchema>;
export interface MemoryLibrarySummary {
  id: string; title: string; folderId: string | null; preview: string; updatedAt: string | null;
  active: boolean; missing: boolean; scope: MemoryLibrary["documents"][number]["scope"];
}
export interface MemoryLibraryView {
  revision: number; folders: MemoryLibrary["folders"]; documents: MemoryLibrarySummary[];
}
export interface MemoryLibraryDocument extends MemoryLibrarySummary {
  libraryRevision: number; text: string; entries: { id: string; revision: number }[];
}
export const emptyMemoryLibrary = (): MemoryLibrary => ({ revision: 0, folders: [], documents: [] });
export const legacyDocumentId = (entryId: string) => `memory:${entryId}`;
const active = (entry: MemoryEntry, now: Date) => entry.enabled && entry.status !== "disabled" && entry.temporalState !== "retracted" && entry.temporalState !== "not_applicable" && (!entry.expiresAt || Date.parse(entry.expiresAt) > now.getTime());

/** One document is a view of current assertions, never another copy of their text. */
export function memoryLibraryDocuments(library: MemoryLibrary, entries: MemoryEntry[], threadId: string, now = new Date()): MemoryLibraryDocument[] {
  const visible = entries.filter(entry => entry.scope?.kind !== "thread" || entry.scope.threadId === threadId);
  const byId = new Map(visible.map(entry => [entry.id, entry]));
  const owned = new Set(library.documents.flatMap(document => document.entryIds));
  const documents = library.documents.filter(document => document.scope.kind !== "thread" || document.scope.threadId === threadId).map(document => {
    const parts = document.entryIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const text = parts.map(part => part.text).join("");
    return { id: document.id, libraryRevision: library.revision, title: document.title, folderId: document.folderId, scope: document.scope,
      text, preview: Array.from(text).slice(0, 120).join(""), active: parts.some(part => active(part, now)), missing: parts.length !== document.entryIds.length,
      updatedAt: parts.map(part => part.updatedAt ?? part.createdAt ?? null).filter((stamp): stamp is string => stamp !== null).sort().at(-1) ?? null,
      entries: parts.map(part => ({ id: part.id, revision: part.revision ?? 1 })) };
  });
  for (const entry of visible) {
    if (owned.has(entry.id)) continue;
    const title = entry.text.split(/\r?\n/).find(line => line.trim())?.replace(/^#{1,6}\s+/, "").trim() ?? "未命名记忆";
    documents.push({ id: legacyDocumentId(entry.id), libraryRevision: library.revision, title: Array.from(title).slice(0, 60).join(""), folderId: null,
      scope: entry.scope ?? { kind: "workspace" }, text: entry.text, preview: Array.from(entry.text).slice(0, 120).join(""),
      updatedAt: entry.updatedAt ?? entry.createdAt ?? null, active: active(entry, now), missing: false,
      entries: [{ id: entry.id, revision: entry.revision ?? 1 }] });
  }
  return documents;
}
export function memoryLibraryView(library: MemoryLibrary, entries: MemoryEntry[], threadId: string): MemoryLibraryView {
  return { revision: library.revision, folders: library.folders, documents: memoryLibraryDocuments(library, entries, threadId).map(({ text: _text, entries: _entries, libraryRevision: _revision, ...summary }) => summary) };
}

/** Preserve document order and Unicode. Internal chunks remain bounded Memory assertions. */
export function memoryDocumentChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 2048) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.some(chunk => !chunk.trim())) throw new Error("文档包含过长的连续空白，请整理后再保存");
  return chunks;
}
