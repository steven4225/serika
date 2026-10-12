import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentThreads, recentThreads } from "./recent-threads.js";
import type { ThreadSummary } from "../../shared/ui-contract.js";
import { visibleThreads, threadTitle } from "./thread-list-data.js";

function thread(threadId: string, savedAt?: string): ThreadSummary {
  return { threadId, transcriptDirectory: "/registered/workspace", title: threadId, messageCount: 2, savedAt };
}

it("bounds recent conversations to five registered items, keeps current first and sorts real save times", () => {
  const input = [thread("current"), ...Array.from({ length: 7 }, (_, index) => thread(`old-${index}`, `2026-10-0${index + 1}T00:00:00Z`)), thread("invalid", "bad")];
  const copy = input.slice();
  assert.deepEqual(recentThreads(input, "current").map(row => row.threadId), ["current", "old-6", "old-5", "old-4", "old-3"]);
  assert.deepEqual(input, copy, "presentation must not mutate the registry list");
});

it("keeps history reachable and distinguishes loading/error from an empty list", () => {
  const props = { threads: [thread("current")], currentId: "current", busy: false, onSelect: () => {}, onAll: () => {} };
  const error = renderToStaticMarkup(createElement(RecentThreads, { ...props, loading: false, error: "broken registry" }));
  assert.match(error, /读取失败，旧对话未删除/);
  assert.match(error, /aria-label="查看全部对话／重新读取"/);
  const loading = renderToStaticMarkup(createElement(RecentThreads, { ...props, loading: true, error: null }));
  assert.match(loading, /正在读取/);
  const busy = renderToStaticMarkup(createElement(RecentThreads, { ...props, loading: false, error: null, busy: true }));
  assert.match(busy, /aria-current="true" disabled=""/);
  assert.match(busy, /处理结束后可切换对话/);
});

it("hides only positively verified unused histories, preserving current, drafts, errors and activity", () => {
  const empty = (id: string): ThreadSummary => ({ ...thread(id), title: "新对话", messageCount: 0, emptyVerified: true });
  const rows = [empty("current"), empty("unused"), empty("draft"), { ...empty("error"), error: "坏文件" },
    { ...empty("task"), emptyVerified: false, taskCount: 1 }, { ...empty("receipt"), emptyVerified: false, runCount: 1 },
    { ...thread("not-inspected"), messageCount: 0 }];
  const drafts = new Map([["draft", "尚未发送的项目计划"]]);
  const result = visibleThreads(rows, "current", drafts);
  assert.equal(result.some(row => row.threadId === "unused"), false);
  for (const id of ["current", "draft", "error", "task", "receipt", "not-inspected"]) assert.ok(result.some(row => row.threadId === id));
  assert.equal(visibleThreads(rows, "current", drafts, true).length, rows.length);
  assert.equal(threadTitle(empty("draft"), drafts.get("draft")), "尚未发送的项目计划");
  assert.equal(threadTitle({ ...thread("6f1c2a90-7b34-41d2-9abc-0d11e22f3344"), threadId: "6f1c2a90-7b34-41d2-9abc-0d11e22f3344" }), "当前对话");
  assert.equal(rows.length, 7, "filtering neither deletes nor mutates registered entries");
});
