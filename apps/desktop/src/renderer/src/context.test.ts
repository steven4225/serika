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

it("separates preset intent from effective budget and labels unknown capacity unverified", () => {
  const requestedBudget = contextBudgetForMode("long-task");
  const budget = { ...requestedBudget, contextWindowTokens: 128_000, inputBudgetTokens: 91_136 };
  const html = renderToStaticMarkup(createElement(ContextModeSelector, { budget, requestedBudget,
    modelCapacity: { provider: "test", modelId: "unknown", contextWindowTokens: 128_000, source: "unverified_fallback" }, disabled: false, onSelect() {} }));
  assert.match(html, /容量未核实/);
  assert.match(html, /输入预算[^<]*91,136/);
  assert.match(html, /档位目标[^<]*400,000/);
  assert.match(html, /不证明供应商支持/);
  assert.doesNotMatch(html, /实际窗口/);
});

it("keeps advanced context details closed and does not add warning popups", () => {
  const html = renderToStaticMarkup(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, hasCompaction: true }));
  assert.match(html, /<details class="context-technical"><summary>高级：预算与压缩详情/);
  assert.doesNotMatch(html, /<details[^>]*open|role="dialog"/);
});

it("mode panel leads with the actual custom window rather than a claimed 1M window", () => {
  const budget = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096, safetyMarginTokens: 1024 };
  const html = renderToStaticMarkup(createElement(ContextModeSelector, { budget, disabled: false, onSelect() {} }));
  assert.match(html, /实际窗口[^<]*32,768/);
  assert.match(html, /输入预算[^<]*27,648/);
  assert.doesNotMatch(html, /这两档按 DeepSeek 1M 窗口配置/);
});
