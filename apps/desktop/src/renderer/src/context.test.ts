import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultContextBudget } from "@serika/assistant";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@serika/assistant/testing";
import { ContextPanel } from "./context.js";

it("keeps advanced context details closed and does not add warning popups", () => {
  const html = renderToStaticMarkup(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, }));
  assert.match(html, /<details class="context-technical"><summary>高级：预算与压缩详情/);
  assert.doesNotMatch(html, /<details[^>]*open|role="dialog"/);
});
