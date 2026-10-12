import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../../shared/ui-contract.js";
import { dashboardTabForDetail } from "./layout.js";
import {
  applyThinkingChoice,
  monthlyUsageView,
  settingsBackTarget,
  settingsCopy,
  settingsRouteForInitial,
  thinkingChoiceForBudget,
} from "./settings-model.js";
import { SettingsFrame, SettingsHome, ThinkingModeCards } from "./settings.js";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const info = {
  workspaceRoot: "/workspace/serika",
  computer: { enabled: true, allowedBundleIds: ["com.example.Editor"] },
  modules: [
    { id: "read-file", enabled: true },
    { id: "memory", enabled: true },
    { id: "web", enabled: false },
  ],
} as AppInfo;

it("settings home is a grouped push list and keeps engineering ids off the chrome", () => {
  const html = render(createElement(SettingsFrame, { route: "home", onBack() {} }, createElement(SettingsHome, { info, busy: false, onOpen() {} })));
  assert.match(html, /aria-label="回到手札"/);
  assert.match(html, /<h1>设置<\/h1>/);
  assert.match(html, /外观、偏好和应用信息/);
  for (const title of ["连接应用", "设备", "技能", "聊天渠道", "工作区", "通用", "通知", "快捷键", "关于", "平衡", "性能", "月度用量", "管理", "其他"]) {
    assert.match(html, new RegExp(title));
  }
  assert.match(html, /剩余 未报告/);
  assert.match(html, /重置日 未配置/);
  assert.match(html, /用量未报告／未配置/);
  assert.doesNotMatch(html, /aria-label="助手设置"|personal-settings-nav|>模块<|>执行记录<|>上下文</);
  assert.doesNotMatch(html, /mem_|read-file|pomodoro|todoist/);
});

it("a settings row pushes a detail whose back control returns to settings home", () => {
  assert.equal(settingsBackTarget("home"), "hand");
  assert.equal(settingsBackTarget("connectors"), "home");
  assert.equal(settingsCopy("connectors").title, "连接应用");
  const html = render(createElement(SettingsFrame, { route: "connectors", onBack() {} }, createElement("p", null, "连接详情")));
  assert.match(html, /aria-label="返回设置"/);
  assert.match(html, /<h1>连接应用<\/h1>/);
  assert.doesNotMatch(html, /回到手札/);
});

it("thinking mode is a single select over the existing context presets", () => {
  assert.equal(thinkingChoiceForBudget("daily"), "balanced");
  assert.equal(thinkingChoiceForBudget("long-task"), "performance");
  assert.equal(thinkingChoiceForBudget(undefined), "unconfigured");
  assert.equal(applyThinkingChoice("balanced", "balanced"), null);
  assert.equal(applyThinkingChoice("balanced", "performance"), "long-task");
  assert.equal(applyThinkingChoice("performance", "balanced"), "daily");
  assert.equal(applyThinkingChoice("unconfigured", "performance"), "long-task");
  const html = render(createElement(ThinkingModeCards, { current: "performance", disabled: false, onChoose() {} }));
  assert.match(html, /aria-label="思考方式"/);
  assert.equal(html.match(/aria-checked="true"/g)?.length, 1);
  assert.match(html, /aria-checked="true"[^>]*>[\s\S]*性能/);
  assert.match(html, /aria-checked="false"[^>]*>[\s\S]*平衡/);
  assert.doesNotMatch(html, /disabled/);
});

it("monthly usage reports recorded calls without inventing a remaining quota", () => {
  assert.deepEqual(monthlyUsageView(undefined), { remaining: "未报告", resetDay: "未配置", recordedCalls: null });
  assert.deepEqual(monthlyUsageView({ calls: [{}, {}] }), { remaining: "未报告", resetDay: "未配置", recordedCalls: 2 });
});

it("opening settings stays on the gear and does not select the persona pill", async () => {
  assert.equal(dashboardTabForDetail("settings"), "设置");
  assert.equal(dashboardTabForDetail("persona"), "serika");
  assert.notEqual(dashboardTabForDetail("settings"), "serika");
  assert.equal(settingsRouteForInitial(false), "home");
  assert.equal(settingsRouteForInitial("modules"), "skills");
  assert.equal(settingsRouteForInitial("context"), "context");
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /\["手札", "任务", "记忆", "serika"\]/);
  assert.match(app, /onClick=\{\(\) => openSettings\("home"\)\}/);
  assert.match(app, /else openDetails\("persona"\)/);
  assert.doesNotMatch(app, /openDetails\("modules"\)|personal-settings-nav/);
});
