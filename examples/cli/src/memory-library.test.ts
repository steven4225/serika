import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { WorkspaceMemoryStoreImpl, validateMemoryDocument } from "./memory-store.js";
import type { MemoryResult } from "./memory-candidates.js";
import { legacyDocumentId, memoryDocumentChunks, type MemoryLibraryAction } from "./memory-library.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-library-")); roots.push(root);
  return { root, file: join(root, ".runloom/memory.json"), store: new WorkspaceMemoryStoreImpl(root) };
}
function value<T>(result: MemoryResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const code = (result: { ok: boolean; error?: { code: string } }) => result.error?.code;
const newDoc = (expectedRevision: number, overrides: Partial<Extract<MemoryLibraryAction, { operation: "save-document" }>> = {}): Extract<MemoryLibraryAction, { operation: "save-document" }> => ({ operation: "save-document", expectedRevision, id: randomUUID(), title: "角色设定", folderId: null, text: "# 角色\n\n温暖但直接。", entries: [], ...overrides });

it("reads legacy memory as unfiled documents without creating files or guessing folders", async () => {
  const { store, file } = await fixture();
  assert.deepEqual(value(await store.getLibrary("a")), { revision: 0, folders: [], documents: [] });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const added = await store.add({ text: "# 爱好\n跑步" }); assert.ok(added.ok);
  const before = await readFile(file, "utf8");
  const view = value(await store.getLibrary("a"));
  assert.equal(view.documents[0]?.title, "爱好"); assert.equal(view.documents[0]?.folderId, null);
  const doc = value(await store.readLibraryDocument(legacyDocumentId(added.entry.id), "a"));
  assert.equal(doc.text, "# 爱好\n跑步"); assert.equal(doc.libraryRevision, 0);
  assert.equal(await readFile(file, "utf8"), before); assert.equal(JSON.parse(before).version, 4);
});

it("persists folder names, titles and exact Unicode document bodies through import, edit and reopen", async () => {
  const { store, root, file } = await fixture();
  const folderId = randomUUID();
  const folder = value(await store.changeLibrary({ operation: "create-folder", expectedRevision: 0, id: folderId, name: "Serika 的角色设定" }, "a"));
  const text = "# Character\r\n\r\n" + "温暖直接。👩🏽‍💻\n".repeat(300);
  assert.equal(memoryDocumentChunks(text).join(""), text);
  const action = newDoc(folder.revision, { folderId, text });
  value(await store.changeLibrary(action, "a"));
  let reopened = new WorkspaceMemoryStoreImpl(root);
  const document = value(await reopened.readLibraryDocument(action.id, "a"));
  assert.equal(document.text, text); assert.equal(document.title, action.title); assert.equal(document.folderId, folderId); assert.ok(document.entries.length > 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 5, "old writers must reject rather than erase library metadata");
  const editedText = "改短后的角色说明。";
  const edited = value(await reopened.changeLibrary({ ...action, text: editedText, expectedRevision: document.libraryRevision, entries: document.entries }, "a"));
  reopened = new WorkspaceMemoryStoreImpl(root);
  const saved = value(await reopened.readLibraryDocument(action.id, "a"));
  assert.equal(saved.text, editedText); assert.equal(saved.entries[0]?.revision, 2);
  const history = await reopened.get(saved.entries[0]!.id); assert.ok(history.ok);
  assert.equal(history.entry.source?.kind, "manual"); assert.equal(history.entry.history?.[0]?.text, memoryDocumentChunks(text)[0]);
  assert.equal(edited.folders[0]?.name, "Serika 的角色设定");
  const list = await reopened.list(); assert.ok(list.ok);
  assert.ok(list.entries.slice(1).every(entry => !entry.enabled), "surplus chunks remain historical and disabled");
  value(await reopened.changeLibrary({ operation: "rename-folder", id: folderId, name: "Character", expectedRevision: saved.libraryRevision }, "a"));
  assert.equal(value(await reopened.getLibrary("a")).folders[0]?.name, "Character");
});

it("rejects stale folder and body revisions atomically; ordinary writes preserve document ownership", async () => {
  const { store, file } = await fixture();
  const action = newDoc(0); value(await store.changeLibrary(action, "a"));
  const document = value(await store.readLibraryDocument(action.id, "a"));
  assert.ok((await store.update(document.entries[0]!.id, { text: "后台更正后的内容", expectedRevision: 1 })).ok);
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ ...action, entries: document.entries, text: "旧草稿", expectedRevision: document.libraryRevision }, "a")), "MEMORY_REVISION_CONFLICT");
  assert.equal(await readFile(file, "utf8"), before);
  const latest = value(await store.readLibraryDocument(action.id, "a")); assert.equal(latest.text, "后台更正后的内容");
  assert.equal(latest.title, "角色设定");
  assert.ok((await store.add({ text: "后来自动记住的另一件事" })).ok);
  const view = value(await store.getLibrary("a")); assert.equal(view.documents.length, 2); assert.equal(view.documents[1]?.folderId, null);
  assert.equal(view.documents[0]?.id, action.id);
  value(await store.changeLibrary({ operation: "create-folder", id: randomUUID(), name: "学习", expectedRevision: view.revision }, "a"));
  const snapshot = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ operation: "organize-document", id: action.id, title: "旧标题", folderId: null, expectedRevision: view.revision }, "a")), "MEMORY_REVISION_CONFLICT");
  assert.equal(await readFile(file, "utf8"), snapshot);
});

it("keeps Thread scope, excludes expired documents from active counts and rejects forged ownership", async () => {
  const { store, file } = await fixture();
  const own = await store.add({ text: "私有记录", scope: { kind: "thread", threadId: "a" } }, undefined, { boundThreadId: "a" }); assert.ok(own.ok);
  assert.ok((await store.add({ text: "已到期", expiresAt: "2020-01-01T00:00:00Z" })).ok);
  const view = value(await store.getLibrary("b")); assert.equal(view.documents.length, 1); assert.equal(view.documents[0]?.active, false);
  const action = newDoc(0, { id: legacyDocumentId(own.entry.id), title: "私有文档", entries: [] });
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary(action, "b")), "INVALID_INPUT");
  assert.equal(code(await store.readLibraryDocument(action.id, "b")), "MEMORY_ENTRY_NOT_FOUND");
  assert.equal(code(await store.changeLibrary({ ...newDoc(0), scope: { kind: "workspace" } } as MemoryLibraryAction, "a")), "INVALID_INPUT");
  assert.equal(await readFile(file, "utf8"), before);
  const doc = value(await store.readLibraryDocument(action.id, "a"));
  value(await store.changeLibrary({ ...action, expectedRevision: 0, entries: doc.entries, text: "显式编辑私有正文" }, "a"));
  assert.equal(value(await store.getLibrary("b")).documents.length, 1);
  const changed = value(await store.readLibraryDocument(action.id, "a")); assert.deepEqual(changed.scope, { kind: "thread", threadId: "a" });
});

it("rejects nonempty folder removal, missing content and oversized input without partial writes", async () => {
  const { store, file } = await fixture();
  const folderId = randomUUID(); value(await store.changeLibrary({ operation: "create-folder", id: folderId, name: "项目", expectedRevision: 0 }, "a"));
  const action = newDoc(1, { folderId }); value(await store.changeLibrary(action, "a"));
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ operation: "remove-folder", id: folderId, expectedRevision: 2 }, "a")), "INVALID_INPUT");
  assert.equal(code(await store.changeLibrary(newDoc(2, { text: "x".repeat(65537) }), "a")), "INVALID_INPUT");
  assert.equal(code(await store.changeLibrary(newDoc(2, { text: "a" + " ".repeat(5000) + "b" }), "a")), "INVALID_INPUT");
  assert.equal(await readFile(file, "utf8"), before);
  const doc = value(await store.readLibraryDocument(action.id, "a")); assert.ok((await store.delete(doc.entries[0]!.id)).ok);
  assert.equal(value(await store.readLibraryDocument(action.id, "a")).missing, true);
  const afterDelete = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ ...action, expectedRevision: 2, entries: [] }, "a")), "MEMORY_ENTRY_NOT_FOUND");
  assert.equal(await readFile(file, "utf8"), afterDelete);
  assert.doesNotThrow(() => validateMemoryDocument(JSON.parse(afterDelete)));
});

for (const boundary of ["before-rename", "after-rename"] as const) it(`document body and folder metadata share the ${boundary} failure boundary`, async () => {
  const { store, root, file } = await fixture(); assert.ok((await store.add({ text: "原始记忆" })).ok);
  const before = await readFile(file, "utf8");
  const writer = new WorkspaceMemoryStoreImpl(root, async phase => { if (phase === boundary) throw new Error("injected boundary failure"); });
  const action = newDoc(0);
  const result = await writer.changeLibrary(action, "a"); assert.equal(result.ok, false);
  const bytes = await readFile(file, "utf8");
  if (boundary === "before-rename") { assert.equal(bytes, before); assert.equal(value(await store.getLibrary("a")).documents.length, 1); }
  else { assert.equal(code(result), "MEMORY_COMMIT_UNCERTAIN"); const saved = value(await store.readLibraryDocument(action.id, "a")); assert.equal(saved.text, action.text); assert.equal(saved.title, action.title); assert.equal(saved.libraryRevision, 1); }
});

it("automatic consolidation retains v5 folders and document titles while new facts remain unfiled", async () => {
  const { store, file } = await fixture();
  const folderId = randomUUID(); value(await store.changeLibrary({ operation: "create-folder", id: folderId, name: "我的文件夹", expectedRevision: 0 }, "a"));
  const document = newDoc(1, { folderId }); value(await store.changeLibrary(document, "a"));
  const now = new Date(Date.now() + 10), prefixHash = "a".repeat(64);
  const result = await store.commitCandidateBatch({
    incremental: true, outcomes: [{ messageId: "user-auto", status: "extracted" }],
    sourcePrefix: { throughMessageId: "user-auto", prefixHash }, batchId: "auto-library", originThreadId: "a", expectedCursor: null,
    nextCursor: { threadId: "a", throughMessageId: "user-auto", prefixHash, lastBatchId: "auto-library", updatedAt: now.toISOString() },
    candidates: [{ change: { operation: "add", text: "新增的明确长期偏好", kind: "preference", scope: { kind: "workspace" }, expiresAt: null }, source: { kind: "conversation", threadId: "a", messageId: "user-auto", quote: "新增的明确长期偏好" }, reason: "explicit lasting preference" }],
    autoAcceptIndexes: [0],
  }, undefined, { boundThreadId: "a", now }); assert.ok(result.ok, JSON.stringify(result));
  const view = value(await store.getLibrary("a")); assert.equal(view.folders[0]?.name, "我的文件夹");
  assert.equal(view.documents.find(item => item.id === document.id)?.title, document.title);
  assert.equal(view.documents.find(item => item.id !== document.id)?.folderId, null);
  const stored = JSON.parse(await readFile(file, "utf8")); assert.equal(stored.version, 5);
  assert.equal(stored.candidates[0].status, "accepted"); assert.equal(stored.consolidationCursors[0].throughMessageId, "user-auto");
});
