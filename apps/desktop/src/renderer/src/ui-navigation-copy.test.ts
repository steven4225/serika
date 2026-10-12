import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contextBudgetForMode, DEFAULT_CONTEXT_BUDGET_CONFIG } from "@aisdk-agent/example-cli/dist/context-budget.js";
import type { MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { AppInfo } from "../../shared/ui-contract.js";
import { contextOverview } from "../../shared/context-panel.js";
import { ContextModeSelector, ContextPanel } from "./context.js";
import { MemoryConsolidationPanel, consolidationStatusLabel } from "./memory-consolidation.js";
import { MemoryMaintenanceSummary } from "./memory-temporal.js";
import { MemoryPanel } from "./memory.js";
import { memoryAutomationLabel } from "./memory-copy.js";
import { dashboardTabForDetail } from "./personal/layout.js";
import { TodayPanel } from "./personal/today.js";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};
const info = { workspaceRoot: "/workspace", configPath: "/config.json", memory: { enabled: true, autoConsolidate: false, writePolicy: "review", queryRewriteEnabled: false }, workTasks: true } as AppInfo;
const maintenance: MemoryMaintenance = { stored: 0, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0, capacity: { entries: 200, bytes: 1024, assertionsPerEntry: 10 }, consolidation: { enabled: false, state: "off" } };

it("UI regression 1: workspace belongs to settings and never selects Today", async () => {
  assert.equal(dashboardTabForDetail("home"), "设置");
  const app = await source("./App.tsx");
  assert.match(app, /\["modules", "records", "context", "home"\]\.includes\(detailTab\)/);
});

it("UI regression 2: context compression and memory consolidation have distinct status and stop wording", async () => {
  const panel = render(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, hasCompaction: true }));
  const mode = render(createElement(ContextModeSelector, { budget: DEFAULT_CONTEXT_BUDGET_CONFIG, disabled: false, onSelect: noop }));
  const overview = contextOverview({ enabled: false } as Parameters<typeof contextOverview>[0]);
  assert.doesNotMatch(panel + mode + JSON.stringify(overview), /整理/);
  assert.match(mode, /自动压缩/);
  assert.match(consolidationStatusLabel(true, { ...maintenance, consolidation: { enabled: true, state: "running" } }, ""), /记忆/);
  const app = await source("./App.tsx");
  assert.doesNotMatch(app, /"停止整理"/);
  assert.match(app, /"停止记忆整理"/);
});

it("UI regression 3: the memory automation off state uses the same phrase across summaries and pending", async () => {
  const expected = "记忆自动整理：关";
  assert.equal(consolidationStatusLabel(true, maintenance, ""), expected);
  assert.match(render(createElement(MemoryMaintenanceSummary, { value: maintenance })), new RegExp(expected));
  assert.match(render(createElement(MemoryConsolidationPanel, { info, busy: false, refreshToken: 0 })), new RegExp(expected));
  assert.match(render(createElement(MemoryPanel, { memory: info.memory, pendingCount: 1, temporaryThread: false, controllerIdle: true, refreshToken: 0 })), new RegExp(expected));
  for (const file of ["./capabilities.tsx", "./daily-setup-panel.tsx"]) assert.match(await source(file), /memoryAutomationLabel\(/);
});

it("memory automation label distinguishes enabled capability from write policy", () => {
  assert.equal(memoryAutomationLabel({ enabled: true, autoConsolidate: true }), "记忆自动整理：开");
  assert.equal(memoryAutomationLabel({ enabled: false, autoConsolidate: true }), "记忆自动整理：关");
  const review = { ...info, memory: { ...info.memory, autoConsolidate: true } };
  const html = render(createElement(MemoryConsolidationPanel, { info: review, busy: false, refreshToken: 0 }));
  assert.match(html, /记忆自动整理：开/);
  assert.match(html, /人工审核模式/);
});

it("UI regression 4: memory setup has one primary entry and workspace context is a navigation link", async () => {
  const html = render(createElement(MemoryConsolidationPanel, { info, busy: false, refreshToken: 0 }));
  assert.doesNotMatch(html, /设置日用记忆|改为自动记住/);
  assert.match(html, /在工作区设置/);
  const daily = await source("./daily-setup-panel.tsx");
  assert.match(daily, /onClick=\{onContext\}/);
});

it("UI regression 5: settings has one explicit entrance and appearance is not a navigation page", async () => {
  const app = await source("./App.tsx");
  assert.doesNotMatch(app, /\["Today", "任务", "记忆", "serika"\]/);
  assert.doesNotMatch(app, /\["appearance",/);
  assert.match(app, /aria-label="设置"/);
  assert.match(app, /aria-label=\{appearance === "dark" \? "切换为浅色外观" : "切换为深色外观"\}/);
});

it("reminders are a personal page, not a settings inbox", async () => {
  assert.equal(dashboardTabForDetail("reminders"), "提醒");
  assert.equal(dashboardTabForDetail("home"), "设置");
  const app = await source("./App.tsx");
  assert.match(app, /\["Today", "任务", "提醒", "记忆"\]/);
  assert.match(app, /onAutomation=\{\(\) => openDetails\("reminders"\)\}/);
  assert.doesNotMatch(app, /\["modules", "records", "context", "home", "reminders"\]/);
});

it("UI regression 6: Today explicitly allows ordinary conversation without creating a task", () => {
  const html = render(createElement(TodayPanel, { info, tasks: [], tasksLoading: false, tasksError: null, pendingMemory: 0, pendingMemoryError: null, onTasks: noop, onMemory: noop, onChat: noop, onPomodoro: noop, onAutomation: noop }));
  assert.match(html, /普通对话照常使用/);
});

it("UI regression 7: selected context mode remains enabled while actual busy controls are disabled", () => {
  const props = { budget: contextBudgetForMode("daily"), disabled: false, onSelect: noop };
  const html = render(createElement(ContextModeSelector, props));
  assert.match(html, /aria-pressed="true">日常 · 256K/);
  assert.doesNotMatch(html, /disabled/);
  assert.match(render(createElement(ContextModeSelector, { ...props, disabled: true })), /aria-pressed="true" disabled="">日常 · 256K/);
});

it("optional memory tab selection shares the settings pill instead of an underline", async () => {
  const css = await source("./personal/shell.css");
  assert.match(css, /:is\(\.personal-settings-nav, \.memory-tabs\) button:is\(\[aria-current="page"\], \[aria-selected="true"\]\)/);
  assert.match(css, /\.personal-layout \.memory-tabs \{[^}]*border: 0/);
});
