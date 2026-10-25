import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SerikaMessage, SerikaMessageContent } from "./ui-kit/message.js";

it("ported message containers preserve children as text rather than unsafe HTML", () => {
  const markup = renderToStaticMarkup(createElement(SerikaMessage, { from: "user" }, createElement(SerikaMessageContent, {}, "<img src=x onerror=alert(1)>")));
  assert.match(markup, /is-user ml-auto justify-end/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img/);
});
