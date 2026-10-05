import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopLayout } from "./zcode/layout.js";
import { ZCodeSidebar } from "./zcode/sidebar.js";
import { ZCodeMessage, ZCodeMessageContent } from "./zcode/message.js";

it("opts into the new presentation explicitly; original daily entry stays unchanged", () => {
  assert.equal(desktopLayout(""), "classic");
  assert.equal(desktopLayout("?ui=zcode"), "zcode");
  assert.equal(desktopLayout("?ui=other&workspace=zcode"), "classic");
});

it("renders registered history and preserves busy/error distinctions and all feature entries", () => {
  const props = { threads: [{ threadId: "a", title: "<script>history</script>", transcriptDirectory: "/isolated", messageCount: 2 }], currentId: "a",
    drafts: new Map<string, string>(), workspaceRoot: "/isolated/Runloom", loading: false, error: null, busy: true, selected: null,
    pendingMemory: "2+", unknownRuns: 1, onNew: () => {}, onSelect: () => {}, onOpen: () => {}, onConversation: () => {} };
  const markup = renderToStaticMarkup(createElement(ZCodeSidebar, props));
  assert.match(markup, /<strong>Serika<\/strong>/);
  assert.match(markup, /class="serika-mark"/);
  assert.match(markup, /serika-icon\.png/);
  assert.match(markup, /&lt;script&gt;history&lt;\/script&gt;/);
  assert.match(markup, /aria-current="true" disabled=""/);
  for (const entry of ["记忆", "执行记录", "工作任务", "番茄钟", "模块能力", "上下文与压缩", "工作区、订阅与设置"]) assert.ok(markup.includes(entry));
  assert.match(markup, /处理结束后可切换对话/);
  const failed = renderToStaticMarkup(createElement(ZCodeSidebar, { ...props, busy: false, error: "bad history" }));
  assert.match(failed, /读取失败，旧记录未删除/);
  assert.doesNotMatch(failed, /还没有已登记的对话/);
});

it("ported message containers preserve children as text rather than unsafe HTML", () => {
  const markup = renderToStaticMarkup(createElement(ZCodeMessage, { from: "user" }, createElement(ZCodeMessageContent, {}, "<img src=x onerror=alert(1)>")));
  assert.match(markup, /zcode-message is-user/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img/);
});
