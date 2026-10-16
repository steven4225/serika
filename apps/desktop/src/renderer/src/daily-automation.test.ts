import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundActionAllowed, backgroundServiceLabel, notificationPermissionLabel } from "./daily-automation.js";

test("daily service states never equate registration or running alone with routed notifications", () => {
  assert.match(backgroundServiceLabel({ ok: true, registered: false, running: false, rssEnabled: false }), /不会执行/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: false, rssEnabled: true }), /暂不能依赖/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true }), /未确认通知配置/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true }), /未配置点击/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }), /后台服务运行中/);
  assert.match(backgroundServiceLabel({ ok: false, message: "无法查询" }), /状态不可用/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true,
    setupReady: false, configurationMessage: "参数不一致，请先停用再启用" }), /配置未就绪.*暂不能依赖提醒/);
});

test("closing the task capability does not block an explicitly authorized service stop", () => {
  assert.equal(backgroundActionAllowed("enable", false, false, false), false);
  assert.equal(backgroundActionAllowed("disable", false, false, false), true);
  assert.equal(backgroundActionAllowed("test", false, false, false), true);
  for (const action of ["enable", "disable", "test"] as const) {
    assert.equal(backgroundActionAllowed(action, true, true, false), false);
    assert.equal(backgroundActionAllowed(action, true, false, true), false);
  }
});

test("notification permission stays separate from tool installation", () => {
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "not_requested", message: "" }), /尚未申请/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "denied", message: "" }), /已拒绝/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "unknown", message: "" }), /未确认/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "authorized", message: "" }), /已允许/);
  assert.match(notificationPermissionLabel({ helperConfigured: false, authorization: "unknown", message: "" }), /Serika 通知未就绪/);
});
