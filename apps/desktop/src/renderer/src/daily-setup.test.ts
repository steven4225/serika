import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../shared/ui-contract.js";
import { dailySetupNotice, memoryAutomaticUpgradeNeeded, memorySetupChanges, memorySetupNeeded } from "./daily-setup.js";
import { MemorySetup } from "./daily-setup-panel.js";

const info = (memory: AppInfo["memory"], workspaceRoot: string | null = "/workspace") => ({ memory, workspaceRoot }) as AppInfo;
it("offers the missing recall setting even when automatic consolidation is already on", () => {
  const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: false, writePolicy: "automatic" });
  assert.equal(memorySetupNeeded(current), true);
  assert.deepEqual(memorySetupChanges(current), ["启用普通对话的同义查询改写"]);
  assert.match(dailySetupNotice(current)!, /同义召回未开启/);
});
it("separates absent workspace, disabled memory and disabled consolidation", () => {
  assert.match(dailySetupNotice(info({ enabled: false, autoConsolidate: false }, null))!, /没有工作区/);
  assert.match(dailySetupNotice(info({ enabled: false, autoConsolidate: false }))!, /未启用记忆/);
  assert.match(dailySetupNotice(info({ enabled: true, autoConsolidate: false }))!, /记忆自动整理：关/);
  assert.equal(memorySetupChanges(info({ enabled: false, autoConsolidate: false })).length, 4);
});
it("does not prompt to rewrite a ready configuration", () => {
  const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: true, writePolicy: "automatic" });
  assert.equal(memorySetupNeeded(current), false);
  assert.equal(dailySetupNotice(current), null);
  assert.deepEqual(memorySetupChanges(current), []);
});
it("offers an explicit upgrade instead of describing review mode as automatic saving", () => {
  const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: true, writePolicy: "review" });
  assert.equal(memorySetupNeeded(current), true);
  assert.match(dailySetupNotice(current)!, /人工审核模式/);
  assert.equal(memorySetupChanges(current).length, 1);
  assert.match(memorySetupChanges(current)[0]!, /自动保存/);
});

it("offers a policy-only upgrade without enabling unrelated recall settings or upgrading recovery profiles", () => {
  for (const writePolicy of ["review", undefined] as const) {
    const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: false, ...(writePolicy ? { writePolicy } : {}) });
    assert.equal(memoryAutomaticUpgradeNeeded(current), true);
    assert.deepEqual(memorySetupChanges(current), ["自动保存明确、可溯源的普通长期信息，歧义仍留待审核"]);
    const html = renderToStaticMarkup(createElement(MemorySetup, { info: current, busy: false }));
    assert.ok(html.includes("改为自动记住"));
    assert.equal(html.includes("确认修改当前配置"), false, "preview is not open and nothing is applied on mount");
    const recovery = { ...current, recoveryWorkspace: { originalWorkspace: "/original" } };
    assert.equal(memoryAutomaticUpgradeNeeded(recovery), false);
    assert.equal(renderToStaticMarkup(createElement(MemorySetup, { info: recovery, busy: false })).includes("改为自动记住"), false);
  }
});
