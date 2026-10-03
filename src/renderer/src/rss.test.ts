import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "node:test";
import { RssPanel } from "./rss.js";

it("RSS panel hides when task/workspace unavailable and discloses authorization/delivery limits", () => {
  assert.equal(renderToStaticMarkup(createElement(RssPanel, { enabled: false, busy: false })), "");
  const html = renderToStaticMarkup(createElement(RssPanel, { enabled: true, busy: true }));
  assert.match(html, /启用后台服务/);
  assert.match(html, /不会自动写入记忆/);
  assert.match(html, /已排期 ≠ 已执行 ≠ 已收到通知/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /服务已注册/);
});
