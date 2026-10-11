import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contextBudgetForMode, DEFAULT_CONTEXT_BUDGET_CONFIG } from "@aisdk-agent/example-cli/dist/context-budget.js";
import { ContextModeSelector, ContextPanel } from "./context.js";

it("shows only two profile choices, no implicit legacy upgrade, and disables mode changes while busy", () => {
  const render = (budget = contextBudgetForMode("daily"), disabled = false) => renderToStaticMarkup(createElement(ContextModeSelector, { budget, disabled, onSelect: () => {} }));
  const daily = render();
  assert.match(daily, /aria-label="上下文模式"/); assert.match(daily, /aria-pressed="true">日常 · 256K/);
  assert.match(daily, /aria-pressed="false">长任务 · 400K/); assert.match(daily, /下一次发送生效/);
  const busy = render(contextBudgetForMode("daily"), true);
  assert.match(busy, /aria-pressed="false" disabled="">长任务 · 400K/);
  const legacy = render(DEFAULT_CONTEXT_BUDGET_CONFIG);
  assert.match(legacy, /旧配置.*未切换/); assert.doesNotMatch(legacy, /aria-pressed="true"/);
  assert.match(legacy, /选择模式不会自动开启/);
});

it("keeps advanced context details closed and does not add warning popups", () => {
  const html = renderToStaticMarkup(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, hasCompaction: true }));
  assert.match(html, /<details class="context-technical"><summary>高级：预算与压缩详情/);
  assert.doesNotMatch(html, /<details[^>]*open|role="dialog"/);
});
