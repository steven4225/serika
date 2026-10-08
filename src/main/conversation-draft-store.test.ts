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
function scope(root: string): ConversationDraftScope {
  return { workspaceRoot: join(root, "workspace"), directory: join(root, "transcripts"), threadId: "personal" };
}
const pending = { id: "steer-1", runId: "run-1", text: "保留原文，再追加两步", taskId: "task-1" };

describe("conversation drafts", () => {
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
    await assert.rejects(store.saveDraft(scope(root), { text: "界".repeat(22_000), excludeFromMemory: false }), /64 KiB/);
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
