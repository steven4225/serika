import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationDraftStore, type ConversationDraftScope } from "./conversation-draft-store.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "serika-drafts-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
it("over 64 KiB explains splitting and preserves the previously saved draft", async () => fixture(async root => {
  const store = new ConversationDraftStore(root);
  await store.saveDraft(scope(root), { text: "保留已有草稿", excludeFromMemory: false });
  await assert.rejects(store.saveDraft(scope(root), { text: "长".repeat(23000), excludeFromMemory: false }), /内容太长，请分段/);
  assert.equal((await store.load(scope(root))).draft.text, "保留已有草稿");
}));
function scope(root: string): ConversationDraftScope {
  return { workspaceRoot: join(root, "workspace"), directory: join(root, "transcripts"), threadId: "personal" };
}
const pending = { id: "steer-1", runId: "run-1", text: "保留原文，再追加两步" };

describe("conversation drafts", () => {
  it("persists seven creation fields, per-task instructions and exact composer target without overwriting ordinary drafts", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile"));
    const creation = { goal: "整理资料", constraints: "保留来源", artifacts: "notes/report.md", human: "事实准确", commands: "node check.mjs", testCwd: "project", template: "document" };
    await Promise.all([
      store.saveDraft(scope(root), { text: "ordinary chat", excludeFromMemory: true }),
      store.saveTaskDraft(scope(root), { kind: "creation", value: creation }),
      store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-1", text: "只改结论" }),
      store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-2", text: "保留旧章节" }),
      store.saveTaskDraft(scope(root), { kind: "composer", taskId: "task-2" }),
    ]);
    const restored = await new ConversationDraftStore(join(root, "profile")).load(scope(root));
    assert.deepEqual(restored.taskDrafts, { creation, instructions: { "task-1": "只改结论", "task-2": "保留旧章节" }, composerTaskId: "task-2" });
    assert.equal(restored.draft.text, "ordinary chat");
    assert.equal((await store.load({ ...scope(root), threadId: "another" })).taskDrafts, undefined);
    await store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-2", text: "newer draft" });
    await store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-2", text: "", expectedText: "保留旧章节" });
    assert.equal((await store.load(scope(root))).taskDrafts?.instructions["task-2"], "newer draft", "late accepted request does not delete new text");
  }));

  it("keeps task Steer text and target separate from ordinary chat across uncertain and not-applied receipts", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile"));
    await store.saveDraft(scope(root), { text: pending.text, excludeFromMemory: false });
    await store.saveUncertainSteer(scope(root), { ...pending, taskId: "task-1" });
    await store.acknowledgeSteer(scope(root), pending.id);
    let restored = await store.load(scope(root));
    assert.equal(restored.taskDrafts?.instructions["task-1"], pending.text);
    assert.equal(restored.taskDrafts?.composerTaskId, "task-1");
    await store.saveUncertainSteer(scope(root), { ...pending, taskId: "task-1" });
    await store.acknowledgeSteer(scope(root), pending.id, { clearMatchingDraft: true });
    restored = await store.load(scope(root));
    assert.equal(restored.taskDrafts?.instructions["task-1"], undefined);
    assert.equal(restored.draft.text, pending.text, "task acknowledgement must not clear an unrelated chat draft even if text matches");
  }));

  it("failed task clearing leaves disk intact and explicit retry removes only the requested fields", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile"));
    const creation = { goal: "draft", constraints: "", artifacts: "a.md", human: "", commands: "", testCwd: ".", template: null };
    await store.saveTaskDraft(scope(root), { kind: "creation", value: creation });
    await store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-1", text: "old" });
    await store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "task-2", text: "keep" });
    const valid = await readFile(store.path, "utf8");
    await writeFile(store.path, "broken");
    const clear = { kind: "instruction" as const, taskId: "task-1", text: "" };
    await assert.rejects(store.saveTaskDraft(scope(root), clear), /refusing to reset/);
    assert.equal(await readFile(store.path, "utf8"), "broken");
    await writeFile(store.path, valid);
    await store.saveTaskDraft(scope(root), clear);
    await store.saveTaskDraft(scope(root), { kind: "creation", value: null });
    assert.deepEqual((await store.load(scope(root))).taskDrafts?.instructions, { "task-2": "keep" });
    assert.equal((await store.load(scope(root))).taskDrafts?.creation, null);
    await assert.rejects(store.saveTaskDraft(scope(root), { kind: "instruction", taskId: "__proto__", text: "bad" }), /Invalid/);
  }));
  it("restores both draft and request identity across new store instances without replaying anything", async () => fixture(async root => {
    const userData = join(root, "user-data");
    const store = new ConversationDraftStore(userData);
    assert.deepEqual(await store.load(scope(root)), { draft: { text: "", excludeFromMemory: false }, uncertainSteer: null });
    await assert.rejects(stat(store.path), { code: "ENOENT" });
    await store.saveDraft(scope(root), { text: pending.text, excludeFromMemory: true });
    await store.saveUncertainSteer(scope(root), pending);
    const restored = await new ConversationDraftStore(userData).load(scope(root));
    assert.deepEqual(restored, { draft: { text: pending.text, excludeFromMemory: true }, uncertainSteer: pending });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(userData), ["conversation-drafts.json"]);
    const text = await readFile(store.path, "utf8");
    assert.equal(text.includes("approval"), false);
    assert.equal(text.includes("permission"), false);
  }));

  it("isolates workspace, transcript directory, Thread and userData without using user-controlled paths", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "user-data"));
    await store.saveDraft(scope(root), { text: "private", excludeFromMemory: false });
    for (const other of [
      { ...scope(root), workspaceRoot: join(root, "other-workspace") },
      { ...scope(root), workspaceRoot: null },
      { ...scope(root), directory: join(root, "other-transcripts") },
      { ...scope(root), threadId: "../../another" },
    ]) assert.equal((await store.load(other)).draft.text, "");
    assert.equal((await new ConversationDraftStore(join(root, "other-user-data")).load(scope(root))).draft.text, "");
    assert.equal((await store.load({ ...scope(root), directory: join(root, "transcripts", "..", "transcripts") })).draft.text, "private");
    await assert.rejects(store.load({ ...scope(root), directory: "relative" }), /identity/);
    assert.throws(() => new ConversationDraftStore("relative"), /absolute/);
  }));

  it("serializes field updates from two store instances and guards uncertain replacement and stale clears", async () => fixture(async root => {
    const userData = join(root, "user-data");
    const a = new ConversationDraftStore(userData), b = new ConversationDraftStore(userData);
    await Promise.all([a.saveDraft(scope(root), { text: "draft", excludeFromMemory: true }), b.saveUncertainSteer(scope(root), pending)]);
    assert.deepEqual(await a.load(scope(root)), { draft: { text: "draft", excludeFromMemory: true }, uncertainSteer: pending });
    await b.saveUncertainSteer(scope(root), pending);
    for (const changed of [{ ...pending, id: "another" }, { ...pending, text: "different" }, { ...pending, runId: "other-run" }]) {
      await assert.rejects(a.saveUncertainSteer(scope(root), changed), /reconciled/);
      assert.deepEqual((await b.load(scope(root))).uncertainSteer, pending);
    }
    assert.equal(await b.clearUncertainSteer(scope(root), "old-id"), false);
    assert.equal(await a.clearUncertainSteer(scope(root), pending.id), true);
    assert.equal((await b.load(scope(root))).draft.text, "draft");
    assert.equal((await b.load(scope(root))).uncertainSteer, null);
  }));

  it("atomically acknowledges only a matching draft, and preserves a newer draft or not-applied text", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "user-data"));
    await store.saveDraft(scope(root), { text: pending.text, excludeFromMemory: true });
    await store.saveUncertainSteer(scope(root), pending);
    assert.equal(await store.acknowledgeSteer(scope(root), "wrong", { clearMatchingDraft: true }), false);
    assert.equal((await store.load(scope(root))).draft.text, pending.text);
    await store.acknowledgeSteer(scope(root), pending.id, { clearMatchingDraft: true });
    assert.deepEqual(await store.load(scope(root)), { draft: { text: "", excludeFromMemory: false }, uncertainSteer: null });
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")).conversations, {});
    await store.saveDraft(scope(root), { text: "new draft", excludeFromMemory: true });
    await store.saveUncertainSteer(scope(root), pending);
    await store.acknowledgeSteer(scope(root), pending.id, { clearMatchingDraft: true });
    assert.deepEqual((await store.load(scope(root))).draft, { text: "new draft", excludeFromMemory: true });
    await store.saveDraft(scope(root), { text: pending.text, excludeFromMemory: true });
    await store.saveUncertainSteer(scope(root), pending);
    await store.acknowledgeSteer(scope(root), pending.id);
    assert.equal((await store.load(scope(root))).draft.text, pending.text);
    await store.saveDraft(scope(root), { text: `  ${pending.text}\n`, excludeFromMemory: true });
    await store.saveUncertainSteer(scope(root), pending);
    await store.acknowledgeSteer(scope(root), pending.id, { clearMatchingDraft: true });
    assert.equal((await store.load(scope(root))).draft.text, "", "request trimming does not leave the already accepted draft for duplicate sending");
  }));

  it("refuses corrupt, oversized or identity-mismatched data without overwriting it", async () => fixture(async root => {
    const userData = join(root, "user-data");
    await mkdir(userData);
    const store = new ConversationDraftStore(userData);
    const broken = ["{", JSON.stringify({ version: 2, conversations: {} }), JSON.stringify({ version: 1, conversations: { wrong: { scope: scope(root), draft: { text: "x", excludeFromMemory: false }, uncertainSteer: null } } }), "x".repeat(2 * 1024 * 1024 + 1)];
    for (const text of broken) {
      await writeFile(store.path, text);
      await assert.rejects(store.load(scope(root)), /refusing to reset/);
      await assert.rejects(store.saveDraft(scope(root), { text: "new", excludeFromMemory: false }), /refusing to reset/);
      assert.equal(await readFile(store.path, "utf8"), text);
    }
    // A previous rejected write does not poison the main-process serialization queue.
    await writeFile(store.path, JSON.stringify({ version: 1, conversations: {} }));
    await store.saveDraft(scope(root), { text: "recovered", excludeFromMemory: false });
    assert.equal((await store.load(scope(root))).draft.text, "recovered");
  }));

  it("bounds text and record count without deleting old drafts, and returns write errors honestly", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "user-data"));
    await assert.rejects(store.saveDraft(scope(root), { text: "界".repeat(22_000), excludeFromMemory: false }), /内容太长，请分段/);
    await assert.rejects(store.saveUncertainSteer(scope(root), { ...pending, text: "界".repeat(1400) }), /4 KiB/);
    for (let i = 0; i < 100; i++) await store.saveDraft({ ...scope(root), threadId: `thread-${i}` }, { text: `draft-${i}`, excludeFromMemory: false });
    const before = await readFile(store.path, "utf8");
    await assert.rejects(store.saveDraft(scope(root), { text: "overflow", excludeFromMemory: false }), /full/);
    assert.equal(await readFile(store.path, "utf8"), before);
    assert.equal((await store.load({ ...scope(root), threadId: "thread-0" })).draft.text, "draft-0");
    await store.saveDraft({ ...scope(root), threadId: "thread-0" }, { text: "", excludeFromMemory: false });
    await store.saveDraft(scope(root), { text: "fits now", excludeFromMemory: false });
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    await assert.rejects(new ConversationDraftStore(blocked).saveDraft(scope(root), { text: "not saved", excludeFromMemory: false }), /refusing to reset/);
  }));
});

it("task draft mode survives reopen; binding a saved task clears creation intent atomically and rejects stale goals", async () => fixture(async root => {
  const store = new ConversationDraftStore(root), identity = scope(root);
  await store.saveDraft(identity, { text: "new task", excludeFromMemory: false, createTask: true });
  assert.equal((await new ConversationDraftStore(root).load(identity)).draft.createTask, true);
  await assert.rejects(store.saveTaskDraft(identity, { kind: "created", taskId: "task-1", expectedGoal: "old task" }), /changed/);
  assert.equal((await store.load(identity)).taskDrafts?.composerTaskId, undefined);
  await store.saveTaskDraft(identity, { kind: "created", taskId: "task-1", expectedGoal: "new task" });
  const saved = await new ConversationDraftStore(root).load(identity);
  assert.deepEqual(saved.draft, { text: "", excludeFromMemory: false });
  assert.equal(saved.taskDrafts?.composerTaskId, "task-1");
}));
