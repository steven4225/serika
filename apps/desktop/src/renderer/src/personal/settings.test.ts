import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../../shared/ui-contract.js";
import { dashboardTabForDetail } from "./layout.js";
import {
  applyThinkingChoice,
  readRecordedCallsWhenActive,
  readWhenHostReady,
  recordedCallLabel,
  recordedCallView,
  SETTINGS_HOST_RETRY_MS,
  settingsBackTarget,
  settingsCopy,
  settingsRouteForInitial,
  takeHostRead,
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
  for (const title of ["连接应用", "文件与网页", "电脑控制", "技能", "Telegram", "通用", "记忆设置", "通知与后台", "高级", "快捷键", "关于", "平衡", "性能"]) assert.match(html, new RegExp(title));
  assert.doesNotMatch(html, /执行记录与用量|本地使用，无需订阅|云电脑|入会提醒|退出登录未配置|已开启 \d+ 项/);
  assert.doesNotMatch(html, /月度用量|立即重置|剩余 未报告|重置日 未配置|订阅未配置|近期保留记录|已记录 \d+ 次/);
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

it("call counts exclude pre-dispatch cancellation and mark a dropped journal as retained", () => {
  assert.deepEqual(recordedCallView(undefined), { recordedCalls: null, incomplete: false });
  assert.equal(recordedCallLabel(recordedCallView(undefined)), null);
  const mixed = recordedCallView({
    calls: [{ status: "returned" }, { status: "not_dispatched" }, { status: "failed" }, { status: "cancelled" }],
    droppedCount: 0,
  });
  assert.deepEqual(mixed, { recordedCalls: 3, incomplete: false });
  assert.equal(recordedCallLabel(mixed), "已记录 3 次模型调用");
  const dropped = recordedCallView({
    calls: [{ status: "returned" }, { status: "not_dispatched" }],
    droppedCount: 4,
  });
  assert.deepEqual(dropped, { recordedCalls: 1, incomplete: true });
  assert.equal(recordedCallLabel(dropped), "近期保留记录 · 1 次调用");
  assert.doesNotMatch(recordedCallLabel(dropped) ?? "", /已记录 2|4 次模型调用/);
});

it("a host that becomes ready 300ms late still yields a selectable preset, and a late failure stays stale", async () => {
  assert.equal(SETTINGS_HOST_RETRY_MS, 300);
  let ready = false;
  let reads = 0;
  let releaseWait: (() => void) | null = null;
  const waiting = readWhenHostReady({
    hostReady: () => ready,
    isCurrent: () => true,
    retryMs: SETTINGS_HOST_RETRY_MS,
    wait: () => new Promise(resolve => { releaseWait = resolve; }),
    read: async () => {
      reads += 1;
      return { ok: true as const, value: { mode: "long-task" as const } };
    },
  });
  assert.equal(reads, 0);
  assert.equal(typeof releaseWait, "function");
  ready = true;
  releaseWait!();
  const readyResult = await waiting;
  assert.equal(reads, 1);
  assert.deepEqual(readyResult, { status: "ready", value: { mode: "long-task" } });
  const applied = takeHostRead(1, 1, readyResult);
  assert.equal(applied?.status, "ready");
  assert.equal(applied?.status === "ready" ? thinkingChoiceForBudget(applied.value.mode) : null, "performance");
  assert.equal(takeHostRead(1, 2, { status: "unavailable" }), null);

  let attempt = 0;
  let releaseRetry: (() => void) | null = null;
  const retried = readWhenHostReady({
    hostReady: () => true,
    isCurrent: () => true,
    maxAttempts: 3,
    wait: () => new Promise(resolve => { releaseRetry = resolve; }),
    read: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ipc not registered");
      return { ok: true as const, value: { mode: "daily" as const } };
    },
  });
  await Promise.resolve();
  assert.equal(attempt, 1);
  releaseRetry!();
  const afterRetry = await retried;
  assert.deepEqual(afterRetry, { status: "ready", value: { mode: "daily" } });
  assert.equal(thinkingChoiceForBudget(afterRetry.status === "ready" ? afterRetry.value.mode : undefined), "balanced");

  let current = true;
  let releaseStale: ((value: { ok: true; value: { mode: "daily" } }) => void) | null = null;
  const stale = readWhenHostReady({
    hostReady: () => true,
    isCurrent: () => current,
    read: () => new Promise(resolve => { releaseStale = resolve; }),
  });
  current = false;
  releaseStale!({ ok: true, value: { mode: "daily" } });
  assert.deepEqual(await stale, { status: "stale" });
  assert.equal(takeHostRead(1, 2, { status: "ready", value: { mode: "daily" } }), null);
});

it("recorded calls refresh only while settings usage is active and ignore a late page", async () => {
  let reads = 0;
  const hidden = await readRecordedCallsWhenActive({
    active: () => false,
    isCurrent: () => true,
    read: async () => { reads += 1; return { calls: [{ status: "returned" }], droppedCount: 0 }; },
  });
  assert.equal(hidden.status, "inactive");
  assert.equal(reads, 0);

  let current = true;
  let releasePage: ((page: { calls: { status: string }[]; droppedCount: number }) => void) | null = null;
  const late = readRecordedCallsWhenActive({
    active: () => true,
    isCurrent: () => current,
    read: () => new Promise(resolve => { releasePage = resolve; }),
  });
  current = false;
  releasePage!({ calls: [{ status: "returned" }, { status: "returned" }], droppedCount: 0 });
  assert.deepEqual(await late, { status: "stale" });

  const opened = await readRecordedCallsWhenActive({
    active: () => true,
    isCurrent: () => true,
    read: async () => ({ calls: [{ status: "returned" }, { status: "not_dispatched" }], droppedCount: 2 }),
  });
  assert.equal(opened.status, "ready");
  assert.equal(opened.status === "ready" ? recordedCallLabel(opened.view) : null, "近期保留记录 · 1 次调用");
});

it("opening settings stays on the gear and does not select the persona pill", async () => {
  assert.equal(dashboardTabForDetail("settings"), "设置");
  assert.equal(dashboardTabForDetail("persona"), null);
  assert.notEqual(dashboardTabForDetail("settings"), "serika");
  assert.equal(settingsRouteForInitial(false), "home");
  assert.equal(settingsRouteForInitial("modules"), "advanced");
  assert.equal(settingsRouteForInitial("terminal"), "files");
  assert.equal(settingsRouteForInitial("context"), "context");
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("./settings.tsx", import.meta.url), "utf8");
  assert.match(app, /\["手札", "任务", "记忆"\]/);
  assert.match(app, /onClick=\{\(\) => openSettings\("home"\)\}/);
  assert.doesNotMatch(app, /openDetails\("persona"\)/);
  assert.match(app, /if \(route === "records"\) \{ openDetails\("records"\); return; \}/);
  assert.doesNotMatch(settings, /window\.runloom\.listRuns\(/);
  assert.match(settings, /readWhenHostReady\(/);
  assert.match(settings, /hostReady=\{info !== null\}/);
  assert.doesNotMatch(settings, /useEffect\(\(\) => \{ void load\(\); \}, \[\]\)/);
  assert.doesNotMatch(settings, /月度用量|订阅未配置/);
  assert.doesNotMatch(app, /openDetails\("modules"\)|personal-settings-nav/);
});
