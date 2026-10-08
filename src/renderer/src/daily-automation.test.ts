import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundServiceLabel, notificationPermissionLabel } from "./daily-automation.js";

test("daily service states never equate registration or running alone with routed notifications", () => {
  assert.match(backgroundServiceLabel({ ok: true, registered: false, running: false, rssEnabled: false }), /不会执行/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: false, rssEnabled: true }), /暂不能依赖/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true }), /未确认通知配置/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true }), /未配置点击/);
  assert.match(backgroundServiceLabel({ ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }), /后台服务运行中/);
  assert.match(backgroundServiceLabel({ ok: false, message: "无法查询" }), /状态不可用/);
});

test("notification permission stays separate from tool installation", () => {
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "not_requested", message: "" }), /尚未申请/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "denied", message: "" }), /已拒绝/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "unknown", message: "" }), /未确认/);
  assert.match(notificationPermissionLabel({ helperConfigured: true, authorization: "authorized", message: "" }), /已允许/);
  assert.match(notificationPermissionLabel({ helperConfigured: false, authorization: "unknown", message: "" }), /Serika 通知未就绪/);
});
