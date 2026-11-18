import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultContextBudget } from "@serika/assistant";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@serika/assistant/testing";
import { ContextPanel } from "./context.js";

it("shows the budget as fields, keeps the record fold closed and adds no warning popups", async () => {
  const html = renderToStaticMarkup(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, }));
  assert.doesNotMatch(html, /<details[^>]*open|role="dialog"/);
  const source = await readFile(new URL("./context.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /context-technical|高级：预算与压缩详情/);
  assert.match(source, /<dl className="session-facts context-budget">/);
  assert.match(source, /<dt>输入上限<\/dt>/);
  assert.match(source, /<details><summary>压缩记录与本次准备<\/summary>/);
});
