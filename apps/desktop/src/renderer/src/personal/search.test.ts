import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "../../../shared/ui-contract.js";
import { SearchOverlay } from "./search-overlay.js";
import {
  deferredSearchHint,
  messageSearchHits,
  nextSearchFilter,
  SEARCH_FILTERS,
  searchKeyAction,
} from "./search.js";

const thread = (patch: Partial<ThreadSummary> & Pick<ThreadSummary, "threadId" | "title">): ThreadSummary => ({
  transcriptDirectory: "/fixture/transcripts",
  messageCount: 2,
  ...patch,
});

it("search filters cycle with Tab and stay inside the known set", () => {
  assert.deepEqual(SEARCH_FILTERS, ["message", "file", "link", "image", "all"]);
  assert.equal(nextSearchFilter("message", 1), "file");
  assert.equal(nextSearchFilter("image", 1), "all");
  assert.equal(nextSearchFilter("all", 1), "message");
  assert.equal(nextSearchFilter("message", -1), "all");
  assert.equal(searchKeyAction({ key: "Tab", shiftKey: true, filter: "file", index: 0, count: 1 }).type === "cycle"
    ? (searchKeyAction({ key: "Tab", shiftKey: true, filter: "file", index: 0, count: 1 }) as { filter: string }).filter
    : "", "message");
});

it("arrow keys move a message row and Enter selects it; empty filters do not throw", () => {
  assert.deepEqual(searchKeyAction({ key: "ArrowDown", shiftKey: false, filter: "message", index: -1, count: 2 }), { type: "move", index: 0 });
  assert.deepEqual(searchKeyAction({ key: "ArrowDown", shiftKey: false, filter: "message", index: 1, count: 2 }), { type: "move", index: 0 });
  assert.deepEqual(searchKeyAction({ key: "ArrowUp", shiftKey: false, filter: "message", index: 0, count: 2 }), { type: "move", index: 1 });
  assert.deepEqual(searchKeyAction({ key: "Enter", shiftKey: false, filter: "message", index: 1, count: 2 }), { type: "select", index: 1 });
  assert.equal(searchKeyAction({ key: "Enter", shiftKey: false, filter: "file", index: -1, count: 0 }).type, "ignore");
  assert.deepEqual(searchKeyAction({ key: "ArrowDown", shiftKey: false, filter: "link", index: -1, count: 0 }), { type: "move", index: -1 });
  assert.equal(searchKeyAction({ key: "Escape", shiftKey: false, filter: "image", index: -1, count: 0 }).type, "close");
  assert.equal(deferredSearchHint("file"), "文件还不能在这里搜索，这次不会报错。可以改搜消息。");
  assert.equal(deferredSearchHint("link"), "链接还不能在这里搜索，这次不会报错。可以改搜消息。");
  assert.equal(deferredSearchHint("image"), "图片还不能在这里搜索，这次不会报错。可以改搜消息。");
});

it("message search uses human titles and drops identifier-only previews", () => {
  const hits = messageSearchHits([
    thread({ threadId: "thread_9f3ac0d1e2", title: "周末想把搜索做成聚光灯", preview: "按消息找回以前聊过的话 thread_9f3ac0d1e2", matchesQuery: true }),
    thread({ threadId: "other", title: "无关对话", preview: "不该出现", matchesQuery: false }),
    thread({ threadId: "mem_abcdef12", title: "mem_abcdef12", preview: "mem_abcdef12", matchesQuery: true }),
  ], "搜索", new Map([["draft-only", "搜索草稿里的喝水提醒"]]));
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.title, "周末想把搜索做成聚光灯");
  assert.equal(hits[0]?.preview, "按消息找回以前聊过的话");
  assert.equal(hits[1]?.title, "当前对话");
  assert.equal(hits[1]?.preview, "打开这段对话");
  assert.equal(messageSearchHits([thread({ threadId: "a", title: "空", matchesQuery: true })], "  ", new Map()).length, 0);
});

it("the empty overlay shows shortcut hints and does not render engineering ids", () => {
  const html = renderToStaticMarkup(createElement(SearchOverlay, { drafts: new Map(), onClose: () => {}, onOpenThread: () => {} }));
  assert.match(html, /按 Tab 切换筛选，按 ↑↓ 导航，/);
  assert.match(html, /按 ↩ 选择，按 ESC 关闭/);
  for (const label of ["消息", "文件", "链接", "图片", "全部"]) assert.match(html, new RegExp(label));
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /thread_|mem_|task_|runloom-/);
});
