import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResidentServicePanel, residentServiceLabel } from "./resident-service-panel.js";
import type { ResidentServiceState } from "../../shared/resident-service.js";

it("service panel never draws a failed status query as disabled, or registration as connection readiness", () => {
  const base: ResidentServiceState = { ok: true, registered: false, running: false, compatible: true, label: "fixture" };
  assert.equal(residentServiceLabel(null), "尚未查询");
  assert.equal(residentServiceLabel({ ...base, ok: false }), "状态未确认");
  assert.match(residentServiceLabel({ ...base, registered: true, running: true, compatible: false }), /配置不匹配/);
  assert.equal(residentServiceLabel({ ...base, registered: true, running: true }), "常驻进程运行中");
  const html = renderToStaticMarkup(React.createElement(ResidentServicePanel, { status: base, busy: true,
    refresh: async () => base, setEnabled: async () => base }));
  assert.match(html, /新的工具请求仍需确认/);
  assert.match(html, /不会自动结束或转移计时/);
  assert.match(html, /不保证崩溃后计时恢复/);
  assert.match(html, /请先结束当前执行/);
  assert.match(html, /disabled=""/);
});
