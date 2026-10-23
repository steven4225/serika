import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HerdrTargetSetting } from "./herdr-target-setting.js";
import type { AppInfo } from "../../shared/ui-contract.js";

it("keeps target metadata selection separate from per-call execution authority", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { runloom: { listHerdrSessions() {}, listHerdrPanes() {}, setHerdrTarget() {} } } });
  try {
    const info = { authorizedDirectory: "/tmp/authorized", terminalTarget: { authorizedDirectory: "/tmp/authorized", session: "s", paneId: "p", terminalId: "t" } } as AppInfo;
    const html = renderToStaticMarkup(createElement(HerdrTargetSetting, { info, busy: true }));
    assert.match(html, /已选择：s \/ p/);
    assert.match(html, /桌面和 Telegram 的每次读取、输入和停止操作都需要确认/);
    assert.match(html, /目标选择不授予免确认/);
    assert.match(html, /disabled=""/);
  } finally { if (before) Object.defineProperty(globalThis, "window", before); else Reflect.deleteProperty(globalThis, "window"); }
});
