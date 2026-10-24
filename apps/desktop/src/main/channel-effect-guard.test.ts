import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChannelEffectGuard } from "./channel-effect-guard.js";

it("resource ownership survives restart as unknown, admits no competing effect, and preserves an explicit release report", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-effect-guard-"));
  try {
    const path = join(root, "resources", "workspace.json");
    const guard = new ChannelEffectGuard(path, "workspace"); await guard.load();
    assert.equal(await guard.claim("A", "run-A"), true);
    assert.equal(await guard.claim("B", "run-B"), false);
    assert.equal(await guard.claim("A", "run-A"), true);
    const reopened = new ChannelEffectGuard(path, "workspace"); await reopened.load();
    assert.equal(reopened.snapshot()?.unknown, true);
    assert.equal(await reopened.claim("B", "run-B"), false);
    await reopened.release("B", "run-B", "foreign report");
    assert.equal(reopened.snapshot()?.threadId, "A");
    await reopened.release("A", "run-A", "已检查文件和进程；接受剩余不确定性");
    assert.equal(await reopened.claim("B", "run-B"), true);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.review.threadId, "A"); assert.match(saved.review.note, /已检查/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
