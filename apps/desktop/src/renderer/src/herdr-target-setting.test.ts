import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HerdrTargetSetting } from "./herdr-target-setting.js";
import type { AppInfo } from "../../shared/ui-contract.js";

it("shows fixed-target Herdr read permission and unremembered send approvals", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { runloom: { listHerdrSessions() {}, listHerdrPanes() {}, setHerdrTarget() {} } } });
  try {
    const info = { authorizedDirectory: "/tmp/authorized", terminalTarget: { authorizedDirectory: "/tmp/authorized", session: "s", paneId: "p", terminalId: "t" } } as AppInfo;
    const html = renderToStaticMarkup(createElement(HerdrTargetSetting, { info, busy: true }));
    assert.match(html, /已选择：s \/ p/);
    assert.match(html, /桌面和 Telegram 的结构化 get、read、wait 免逐条确认/);
    assert.match(html, /每次先核对终端身份；不匹配就停下要求重选/);
    assert.match(html, /prompt、input、stop 每次确认且不可记住/);
    assert.match(html, /通用本机 CLI 仍每次确认/);
    assert.match(html, /disabled=""/);
  } finally { if (before) Object.defineProperty(globalThis, "window", before); else Reflect.deleteProperty(globalThis, "window"); }
});
