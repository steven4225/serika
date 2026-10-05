import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentThreads, recentThreads } from "./recent-threads.js";
import type { ThreadSummary } from "../../shared/ui-contract.js";

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
