import assert from "node:assert/strict";
import { it } from "node:test";
import type { AppInfo } from "../../shared/ui-contract.js";
import { dailySetupNotice, memorySetupChanges, memorySetupNeeded } from "./daily-setup.js";

const info = (memory: AppInfo["memory"], workspaceRoot: string | null = "/workspace") => ({ memory, workspaceRoot }) as AppInfo;
it("offers the missing recall setting even when automatic consolidation is already on", () => {
  const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: false });
  assert.equal(memorySetupNeeded(current), true);
  assert.deepEqual(memorySetupChanges(current), ["启用普通对话的同义查询改写"]);
  assert.match(dailySetupNotice(current)!, /同义召回未开启/);
});
it("separates absent workspace, disabled memory and disabled consolidation", () => {
  assert.match(dailySetupNotice(info({ enabled: false, autoConsolidate: false }, null))!, /没有工作区/);
  assert.match(dailySetupNotice(info({ enabled: false, autoConsolidate: false }))!, /未启用记忆/);
  assert.match(dailySetupNotice(info({ enabled: true, autoConsolidate: false }))!, /不会.*自动提出候选/);
  assert.equal(memorySetupChanges(info({ enabled: false, autoConsolidate: false })).length, 3);
});
it("does not prompt to rewrite a ready configuration", () => {
  const current = info({ enabled: true, autoConsolidate: true, queryRewriteEnabled: true });
  assert.equal(memorySetupNeeded(current), false);
  assert.equal(dailySetupNotice(current), null);
  assert.deepEqual(memorySetupChanges(current), []);
});
