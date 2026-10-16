import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  clampChatFraction,
  dashboardTabForDetail,
  loadChatFraction,
  loadSidebarOpen,
  PERSONAL_COMPACT_BREAKPOINT,
  PERSONAL_SIDEBAR_KEY,
  PERSONAL_SPLIT_KEY,
} from "./personal/layout.js";

it("personal split starts equal and preserves both pane minima while resizing", () => {
  assert.equal(PERSONAL_SPLIT_KEY, "serika:personal-chat-fraction");
  assert.equal(clampChatFraction(1200, 0.5), 0.5);
  assert.equal(clampChatFraction(1200, 0), 420 / 1194);
  assert.equal(clampChatFraction(1200, 1), 1 - 480 / 1194);
  assert.equal(clampChatFraction(2000, 0), 0.3);
  assert.equal(clampChatFraction(2000, 1), 0.7);
  for (const width of [906, 1000, 1200, 2000]) {
    for (const requested of [-1, 0.3, 0.5, 0.7, 2]) {
      const fraction = clampChatFraction(width, requested);
      assert.ok((width - 6) * fraction >= 420 - Number.EPSILON * 2000);
      assert.ok((width - 6) * (1 - fraction) >= 480 - Number.EPSILON * 2000);
      assert.ok(fraction >= 0.3 && fraction <= 0.7);
    }
  }
});

it("compact mode starts before the minimum two-pane width, not at 840px", () => {
  assert.equal(PERSONAL_COMPACT_BREAKPOINT, 906);
  assert.equal(clampChatFraction(906, 0.5), 420 / 900);
  for (const width of [905, 840, 480, 0, Number.NaN]) {
    assert.equal(clampChatFraction(width, 0.7), 0.5);
  }
});

it("saved split preferences reject invalid values without losing safe numeric preferences", () => {
  for (const raw of [null, "", "  ", "undefined", "NaN", "Infinity", "{}", "not-a-number"]) {
    assert.equal(loadChatFraction(raw), 0.5);
  }
  assert.equal(loadChatFraction("0.6"), 0.6);
  assert.equal(loadChatFraction("-2"), 0.3);
  assert.equal(loadChatFraction("2"), 0.7);
  assert.equal(clampChatFraction(1200, Number.NaN), 0.5);
});

it("the dashboard can collapse without forgetting an explicit open preference", () => {
  assert.equal(PERSONAL_SIDEBAR_KEY, "serika:personal-sidebar");
  assert.equal(loadSidebarOpen(null), true);
  assert.equal(loadSidebarOpen(""), true);
  assert.equal(loadSidebarOpen("open"), true);
  assert.equal(loadSidebarOpen("collapsed"), false);
});

it("collapsed chat keeps the create-task control in the shell", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("./personal/shell.css", import.meta.url), "utf8");
  assert.match(app, /sidebar-collapsed/);
  assert.match(app, /创建任务/);
  assert.match(app, /aria-label=\{dashboardOpen \? "收起侧栏" : "展开侧栏"\}/);
  assert.match(css, /\.personal-layout\.sidebar-collapsed > :is\(\.personal-dashboard, \.personal-divider\) \{ display: none; \}/);
  assert.match(css, /\.personal-layout\.app\.sidebar-collapsed \{ grid-template-columns: minmax\(0, 1fr\); padding-right: 0; \}/);
  assert.match(css, /\.personal-layout\.app\.sidebar-collapsed > \.main-shell \{ grid-column: 1 \/ -1; width: 100%; max-width: none; \}/);
  assert.match(css, /\.personal-layout\.sidebar-collapsed :is\(\.conversation-thread, \.action-dock, \.attention-region\) \{ width: 100%; max-width: none; margin-inline: 0; align-self: stretch; \}/);
  assert.doesNotMatch(css, /\.sidebar-collapsed[^{]*\{[^}]*--chat-fraction/);
});

it("existing details remain reachable under the personal dashboard tabs", () => {
  assert.equal(dashboardTabForDetail("home"), "设置");
  assert.equal(dashboardTabForDetail("pomodoro"), "手札");
  assert.equal(dashboardTabForDetail("tasks"), "任务");
  assert.equal(dashboardTabForDetail("reminders"), null);
  assert.equal(dashboardTabForDetail("memory"), "记忆");
  assert.equal(dashboardTabForDetail("persona"), null);
  assert.equal(dashboardTabForDetail("threads"), null);
  assert.equal(dashboardTabForDetail("settings"), "设置");
  assert.notEqual(dashboardTabForDetail("settings"), "serika");
  for (const detail of ["records", "context", "modules"]) {
    assert.equal(dashboardTabForDetail(detail), "设置");
  }
});
