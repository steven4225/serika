import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultContextBudget } from "@serika/assistant";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@serika/assistant/testing";
import type { MemoryMaintenance } from "@serika/assistant";
import type { AppInfo } from "../../shared/ui-contract.js";
import { contextOverview } from "../../shared/context-panel.js";
import { ContextPanel } from "./context.js";
import { consolidationStatusLabel } from "./memory-consolidation.js";
import { MemoryPanel } from "./memory.js";
import { dashboardTabForDetail } from "./personal/layout.js";
import { readAppSource } from "../test-support/app-source.js";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const info = { workspaceRoot: "/workspace", configPath: "/config.json", memory: { enabled: true, autoConsolidate: false }, workTasks: true } as AppInfo;
const maintenance: MemoryMaintenance = { stored: 0, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0, capacity: { entries: 200, bytes: 1024, assertionsPerEntry: 10 }, consolidation: { enabled: false, state: "off" } };

it("message exclusion explains the actual cloud inference boundary without claiming it disables saved keyword references", async () => {
  const app = await readAppSource();
  const hint = app.match(/className="memory-exclusion" title="([^"]+)"/)?.[1];
  assert.ok(hint);
  assert.match(hint, /已有记忆仍通过固定快照和按需读取提供/);
});

it("UI regression 1: workspace belongs to settings and never selects 手札", async () => {
  assert.equal(dashboardTabForDetail("home"), "设置");
  assert.equal(dashboardTabForDetail("settings"), "设置");
  const app = await readAppSource();
  assert.match(app, /openSettings\("advanced"\)/);
  assert.doesNotMatch(app, /personal-settings-nav|aria-label="助手设置"/);
  assert.doesNotMatch(app, /\["modules", "模块"\]/);
});

it("UI regression 2: context compression and memory consolidation have distinct status and stop wording", async () => {
  const panel = render(createElement(ContextPanel, { controllerIdle: true, refreshToken: 0, }));
  const overview = contextOverview({ enabled: false } as Parameters<typeof contextOverview>[0]);
  assert.doesNotMatch(panel + JSON.stringify(overview), /整理/);
  assert.match(consolidationStatusLabel(true, { ...maintenance, consolidation: { enabled: true, state: "running" } }, ""), /记忆/);
  const app = await readAppSource();
  assert.doesNotMatch(app, /"停止整理"/);
  assert.match(app, /"停止记忆整理"/);
});

it("UI regression 3: the memory automation off state uses the same phrase across summaries and pending", async () => {
  const expected = "记忆自动整理：关";
  assert.equal(consolidationStatusLabel(true, maintenance, ""), expected);
  assert.doesNotMatch(render(createElement(MemoryPanel, { memory: info.memory, temporaryThread: false, controllerIdle: true, refreshToken: 0 })), /引用说明与审核记录/);
  for (const file of ["./capabilities.tsx"]) assert.match(await source(file), /memoryAutomationLabel\(/);
});

it("UI regression 4: memory setup has one primary entry and workspace context is a navigation link", async () => {
  const app = await readAppSource();
  assert.match(app, /openSettings\("context"\)/);
});

it("UI regression 5: settings has one explicit entrance and the persona pill is not that entrance", async () => {
  const app = await readAppSource();
  assert.match(app, /\["手札", "任务", "记忆"\]/);
  assert.doesNotMatch(app, /\["Today",/);
  assert.doesNotMatch(app, /openDetails\("persona"\)/);
  assert.doesNotMatch(app, /\["appearance",/);
  assert.match(app, /aria-label="设置"/);
  assert.match(app, /onClick=\{\(\) => openSettings\("home"\)\}/);
  assert.match(app, /detailTab === "tasks" \|\| detailTab === "settings" \|\| detailTab === "memory"/);
  assert.doesNotMatch(app, /openDetails\("modules"\)/);
  assert.match(await source("./personal/settings.tsx"), /aria-label=\{appearance === "dark" \? "切换为浅色外观" : "切换为深色外观"\}/);
});

it("reminders stay reachable from 手札 and are not a top pill or a settings inbox", async () => {
  assert.equal(dashboardTabForDetail("reminders"), null);
  assert.equal(dashboardTabForDetail("persona"), null);
  assert.equal(dashboardTabForDetail("home"), "设置");
  const app = await readAppSource();
  assert.match(app, /\["手札", "任务", "记忆"\]/);
  assert.match(app, /aria-label="手札与个人助手"/);
  assert.match(app, />手札</);
  assert.match(app, /回到手札/);
  assert.doesNotMatch(app, /["']Today["']|回到今天|今天与个人助手|>今天</);
  assert.match(app, /onAutomation=\{\(\) => openDetails\("reminders"\)\}/);
  assert.doesNotMatch(app, /\["手札", "任务", "提醒", "记忆"\]/);
  assert.doesNotMatch(app, /\["modules", "records", "context", "home", "reminders"\]/);
});

it("schedule management belongs to reminders instead of task templates", async () => {
  const app = await readAppSource();
  assert.doesNotMatch(app, /detailTab === "tasks" && info \? <details className="task-arrangements"/);
  const reminders = app.slice(app.indexOf('<div hidden={detailTab !== "reminders"}>'), app.indexOf('<div hidden={detailTab !== "settings"}>'));
  assert.match(reminders, /管理定时安排与订阅/);
  assert.match(reminders, /<AutomationPanel/);
  assert.match(reminders, /<RssPanel/);
  assert.doesNotMatch(reminders, /onSettings/);
});
