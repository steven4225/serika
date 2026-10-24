import { validateV7MemoryDocument } from "./memory-v7-store.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { V7MemoryStore } from "./memory-v7-store.js";
import type { MemoryResult } from "./memory-types.js";
import { legacyDocumentId, memoryDocumentChunks, type MemoryLibraryAction } from "./memory-library.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-library-")); roots.push(root);
  return { root, file: join(root, ".runloom/memory.json"), store: new V7MemoryStore(join(root, ".runloom/memory.json"), "project-a") };
}
function value<T>(result: MemoryResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
const code = (result: { ok: boolean; error?: { code: string } }) => result.error?.code;
const newDoc = (expectedRevision: number, overrides: Partial<Extract<MemoryLibraryAction, { operation: "save-document" }>> = {}): Extract<MemoryLibraryAction, { operation: "save-document" }> => ({ operation: "save-document", expectedRevision, id: randomUUID(), title: "角色设定", folderId: null, text: "# 角色\n\n温暖但直接。", entries: [], ...overrides });

it("reads legacy memory as unfiled documents without creating files or guessing folders", async () => {
  const { store, file } = await fixture();
  assert.deepEqual(value(await store.getLibrary()), { revision: 0, folders: [], documents: [] });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const added = await store.add({ scope: { kind: "user" }, text: "# 爱好\n跑步" }); assert.ok(added.ok);
  const before = await readFile(file, "utf8");
  const view = value(await store.getLibrary());
  assert.equal(view.documents[0]?.title, "爱好"); assert.equal(view.documents[0]?.folderId, null);
  const doc = value(await store.readLibraryDocument(legacyDocumentId(added.entry.id)));
  assert.equal(doc.text, "# 爱好\n跑步"); assert.equal(doc.libraryRevision, 0);
  assert.equal(await readFile(file, "utf8"), before); assert.equal(JSON.parse(before).version, 7);
});

it("persists folder names, titles and exact Unicode document bodies through import, edit and reopen", async () => {
  const { store, root, file } = await fixture();
  const folderId = randomUUID();
  const folder = value(await store.changeLibrary({ operation: "create-folder", expectedRevision: 0, id: folderId, name: "Serika 的角色设定" }));
  const text = "# Character\r\n\r\n" + "温暖直接。👩🏽‍💻\n".repeat(300);
  assert.equal(memoryDocumentChunks(text).join(""), text);
  const action = newDoc(folder.revision, { folderId, text });
  value(await store.changeLibrary(action));
  let reopened = new V7MemoryStore(join(root, ".runloom/memory.json"), "project-a");
  const document = value(await reopened.readLibraryDocument(action.id));
  assert.equal(document.text, text); assert.equal(document.title, action.title); assert.equal(document.folderId, folderId); assert.ok(document.entries.length > 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 7, "old writers must reject rather than erase library metadata");
  const editedText = "改短后的角色说明。";
  const edited = value(await reopened.changeLibrary({ ...action, text: editedText, expectedRevision: document.libraryRevision, entries: document.entries }));
  reopened = new V7MemoryStore(join(root, ".runloom/memory.json"), "project-a");
  const saved = value(await reopened.readLibraryDocument(action.id));
  assert.equal(saved.text, editedText); assert.equal(saved.entries[0]?.revision, 1);
  const history = await reopened.get(saved.entries[0]!.id); assert.ok(history.ok);
  assert.equal(history.entry.source?.kind, "manual"); const oldParts = await reopened.list(); assert.ok(oldParts.ok);
  assert.ok(oldParts.entries.some(entry => entry.v7?.state === "superseded" && entry.text === memoryDocumentChunks(text)[0]));
  assert.equal(edited.folders[0]?.name, "Serika 的角色设定");
  const list = await reopened.list(); assert.ok(list.ok);
  assert.ok(list.entries.filter(entry => entry.id !== saved.entries[0]!.id).every(entry => !entry.enabled), "surplus chunks remain historical and disabled");
  value(await reopened.changeLibrary({ operation: "rename-folder", id: folderId, name: "Character", expectedRevision: saved.libraryRevision }));
  assert.equal(value(await reopened.getLibrary()).folders[0]?.name, "Character");
});

it("rejects stale folder and body revisions atomically; ordinary writes preserve document ownership", async () => {
  const { store, file } = await fixture();
  const action = newDoc(0); value(await store.changeLibrary(action));
  const document = value(await store.readLibraryDocument(action.id));
  assert.ok((await store.update(document.entries[0]!.id, { text: "后台更正后的内容", expectedRevision: 1 })).ok);
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ ...action, entries: document.entries, text: "旧草稿", expectedRevision: document.libraryRevision })), "MEMORY_REVISION_CONFLICT");
  assert.equal(await readFile(file, "utf8"), before);
  const latest = value(await store.readLibraryDocument(action.id)); assert.equal(latest.text, "后台更正后的内容");
  assert.equal(latest.title, "角色设定");
  assert.ok((await store.add({ scope: { kind: "user" }, text: "后来自动记住的另一件事" })).ok);
  const view = value(await store.getLibrary()); assert.equal(view.documents.length, 2); assert.equal(view.documents[1]?.folderId, null);
  assert.equal(view.documents[0]?.id, action.id);
  value(await store.changeLibrary({ operation: "create-folder", id: randomUUID(), name: "学习", expectedRevision: view.revision }));
  const snapshot = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ operation: "organize-document", id: action.id, title: "旧标题", folderId: null, expectedRevision: view.revision })), "MEMORY_REVISION_CONFLICT");
  assert.equal(await readFile(file, "utf8"), snapshot);
});


it("excludes disabled documents from active counts and rejects forged ownership", async () => {
  const { store, file } = await fixture();
  const own = await store.add({ scope: { kind: "user" }, text: "工作区记录" }); assert.ok(own.ok);
  assert.ok((await store.add({ scope: { kind: "user" }, text: "已停用", enabled: false })).ok);
  const view = value(await store.getLibrary());
  assert.equal(view.documents.length, 2); assert.equal(view.documents.filter(document => document.active).length, 1);
  const action = newDoc(0, { id: legacyDocumentId(own.entry.id), title: "工作区文档", entries: [] });
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary(action)), "INVALID_INPUT");
  assert.equal(code(await store.changeLibrary({ ...newDoc(0), scope: { kind: "workspace" } } as MemoryLibraryAction)), "INVALID_INPUT");
  assert.equal(await readFile(file, "utf8"), before);
});

it("rejects nonempty folder removal, missing content and oversized input without partial writes", async () => {
  const { store, file } = await fixture();
  const folderId = randomUUID(); value(await store.changeLibrary({ operation: "create-folder", id: folderId, name: "项目", expectedRevision: 0 }));
  const action = newDoc(1, { folderId }); value(await store.changeLibrary(action));
  const before = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ operation: "remove-folder", id: folderId, expectedRevision: 2 })), "INVALID_INPUT");
  assert.equal(code(await store.changeLibrary(newDoc(2, { text: "x".repeat(65537) }))), "INVALID_INPUT");
  assert.equal(code(await store.changeLibrary(newDoc(2, { text: "a" + " ".repeat(5000) + "b" }))), "INVALID_INPUT");
  assert.equal(await readFile(file, "utf8"), before);
  const doc = value(await store.readLibraryDocument(action.id)); assert.ok((await store.delete(doc.entries[0]!.id)).ok);
  assert.equal(value(await store.readLibraryDocument(action.id)).missing, true);
  const afterDelete = await readFile(file, "utf8");
  assert.equal(code(await store.changeLibrary({ ...action, expectedRevision: 2, entries: [] })), "MEMORY_ENTRY_NOT_FOUND");
  assert.equal(await readFile(file, "utf8"), afterDelete);
  assert.ok((await store.readV7()).ok);
});

for (const boundary of ["before-rename", "after-rename"] as const) it(`document body and folder metadata share the ${boundary} failure boundary`, async () => {
  const { store, root, file } = await fixture(); assert.ok((await store.add({ scope: { kind: "user" }, text: "原始记忆" })).ok);
  const before = await readFile(file, "utf8");
  const writer = new V7MemoryStore(join(root, ".runloom/memory.json"), "project-a", async phase => { if (phase === boundary) throw new Error("injected boundary failure"); });
  const action = newDoc(0);
  const result = await writer.changeLibrary(action); assert.equal(result.ok, false);
  const bytes = await readFile(file, "utf8");
  if (boundary === "before-rename") { assert.equal(bytes, before); assert.equal(value(await store.getLibrary()).documents.length, 1); }
  else { assert.equal(code(result), "MEMORY_COMMIT_UNCERTAIN"); const saved = value(await store.readLibraryDocument(action.id)); assert.equal(saved.text, action.text); assert.equal(saved.title, action.title); assert.equal(saved.libraryRevision, 1); }
});

it("v7 background writes preserve folders and document titles while old candidate writes stay disabled", async () => {
  const { store } = await fixture(); const action = newDoc(0); value(await store.changeLibrary(action));
  assert.ok((await store.writeV7([{ operation: "add", text: "新的项目笔记", scope: { kind: "project", projectId: "project-a" }, category: "note", source: { kind: "manual" } }], undefined, { automatic: true })).ok);
  const view = value(await store.getLibrary()); assert.equal(view.documents[0]!.title, action.title);
});

it("projects v7 unfiled source text and uncertainty without changing the saved body", async () => {
  const { store, file } = await fixture();
  const text = "# 原话标题\n我想保留，也不想保留。";
  const written = await store.writeV7([{ operation: "add", text, scope: { kind: "user" }, category: "preference", uncertain: true, source: { kind: "manual" } }]);
  assert.ok(written.ok);
  const before = await readFile(file, "utf8"), view = value(await store.getLibrary());
  assert.equal(view.documents.length, 1); assert.equal(view.documents[0]!.folderId, null);
  assert.equal(view.documents[0]!.title, "原话标题"); assert.equal(view.documents[0]!.uncertain, true);
  const document = value(await store.readLibraryDocument(view.documents[0]!.id));
  assert.equal(document.text, text); assert.equal(document.uncertain, true);
  assert.equal(await readFile(file, "utf8"), before);
});

it("keeps project document titles and bodies out of other projects; user memory edits preserve scope", async () => {
  const { store, file } = await fixture(), action = newDoc(0);
  value(await store.changeLibrary(action));
  const preference = await store.add({ text: "偏好简洁回答", scope: { kind: "user" }, kind: "preference" }); assert.ok(preference.ok);
  for (const projectId of ["project-b", null]) {
    const other = new V7MemoryStore(file, projectId), view = value(await other.getLibrary());
    assert.equal(view.documents.some(document => document.id === action.id || document.title === action.title), false);
    assert.equal((await other.readLibraryDocument(action.id)).ok, false);
    assert.equal((await other.changeLibrary({ ...action, expectedRevision: view.revision })).ok, false);
    assert.ok(view.documents.some(document => document.id === legacyDocumentId(preference.entry.id)));
  }
  const none = new V7MemoryStore(file, null), revision = value(await none.getLibrary()).revision;
  assert.equal(code(await none.changeLibrary(newDoc(revision))), "MEMORY_PROJECT_REQUIRED");
  const implicit = value(await none.readLibraryDocument(legacyDocumentId(preference.entry.id)));
  value(await none.changeLibrary(newDoc(implicit.libraryRevision, { id: implicit.id, title: implicit.title, entries: implicit.entries, text: "偏好先给结论" })));
  const edited = value(await store.readLibraryDocument(implicit.id)); assert.deepEqual(edited.scope, { kind: "user" }); assert.equal(edited.text, "偏好先给结论");
});
