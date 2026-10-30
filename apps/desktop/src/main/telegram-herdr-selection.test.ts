import assert from "node:assert/strict";
import { it } from "node:test";
import type { PendingHerdrSelection, SelectHerdrTargetInput } from "@serika/assistant";
import { TelegramHerdrSelection } from "./telegram-herdr-selection.js";

it("Telegram choice tokens reject changed owner, Run, candidate identity and expiry without invoking a choice", async () => {
  const selection: PendingHerdrSelection = { selectionId: "selection", toolCallId: "call", candidates: [{
    candidateId: "candidate", title: "Pi", status: "idle",
    target: { authorizedDirectory: "/workspace", session: "offline", paneId: "p1", terminalId: "t1" },
  }] };
  const initial = { runId: "run", owner: { threadId: "thread", userId: 42, chatId: 42 }, selection };
  let context = structuredClone(initial), now = 0;
  const sent: { key: string; text: string }[] = [], chosen: SelectHerdrTargetInput[] = [];
  const channel = new TelegramHerdrSelection({ current: () => context, now: () => now,
    choose: input => { chosen.push(input); return { accepted: true }; },
    send: async (key, _chatId, text) => { sent.push({ key, text }); return "submitted"; },
  });
  const fresh = async () => {
    context = structuredClone(initial);
    await channel.publish(selection.selectionId, true);
    return sent.at(-1)!.key.split(":").at(-1)!;
  };
  for (const change of [
    () => { context.owner.userId++; },
    () => { context.owner.threadId = "other-thread"; },
    () => { context.runId = "other-run"; },
    () => { context.selection.candidates[0]!.target.terminalId = "replacement"; },
    () => { now += 5 * 60_000; },
  ]) {
    const code = await fresh();
    assert.equal(channel.deliveryIsLive(sent.at(-1)!.key, 42), true);
    change();
    assert.equal(channel.deliveryIsLive(sent.at(-1)!.key, 42), false);
    assert.match(channel.resolve(`选择 ${code} 1`)!, /已过期|已处理/);
    assert.deepEqual(chosen, []);
  }
  const code = await fresh();
  assert.match(channel.resolve(`选择 ${code} 2`)!, /不在当前候选/);
  assert.match(channel.resolve(`选择 ${code} 1`)!, /已提交本轮目标选择/);
  assert.deepEqual(chosen, [{ selectionId: "selection", candidateId: "candidate" }]);
  assert.match(channel.resolve(`选择 ${code} 1`)!, /已过期|已处理/);
  const cancelCode = await fresh();
  assert.match(channel.resolve(`取消选择 ${cancelCode}`)!, /已取消/);
  assert.deepEqual(chosen.at(-1), { selectionId: "selection", candidateId: null });
});
