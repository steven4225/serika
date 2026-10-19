import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopLayout } from "./ui-kit/layout.js";
import { ZCodeMessage, ZCodeMessageContent } from "./ui-kit/message.js";

it("daily Electron and preview share the reference layout without an opt-in or query-string fallback", () => {
  assert.equal(desktopLayout(""), "zcode");
  assert.equal(desktopLayout("?ui=zcode"), "zcode");
  assert.equal(desktopLayout("?ui=other&workspace=zcode"), "zcode");
  assert.equal(desktopLayout("?ui=classic"), "zcode");
});

it("ported message containers preserve children as text rather than unsafe HTML", () => {
  const markup = renderToStaticMarkup(createElement(ZCodeMessage, { from: "user" }, createElement(ZCodeMessageContent, {}, "<img src=x onerror=alert(1)>")));
  assert.match(markup, /is-user ml-auto justify-end/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img/);
});
