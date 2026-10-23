import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerConnectionSetting } from "./computer-connection-setting.js";
import type { AppInfo } from "../../shared/ui-contract.js";

it("offers explicit Computer setup without checking a driver or claiming Accessibility readiness on render", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  const unexpected = () => { throw new Error("Rendering must not discover, check or save Computer configuration"); };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { runloom: {
    getComputerConnection: unexpected, findComputerDrivers: unexpected,
    checkComputerConnection: unexpected, saveComputerConnection: unexpected,
  } } });
  try {
    const info = { computer: { enabled: false, allowedBundleIds: [] } } as AppInfo;
    const render = (busy: boolean, current = info) => renderToStaticMarkup(createElement(ComputerConnectionSetting, { info: current, busy }));
    const html = render(false);
    assert.match(html, /连接电脑控制驱动/);
    assert.match(html, />设置连接<\/button>/);
    assert.match(html, /明确填写允许控制的应用 Bundle ID/);
    assert.match(html, /驱动必须在授权目录之外/);
    assert.match(html, /连接检查只读取运行应用列表/);
    assert.match(html, /系统辅助功能权限需在 macOS 中由你设置/);
    assert.match(html, /每次观察与操作都需要确认，且不可记住/);
    assert.doesNotMatch(html, /连接可达|权限已通过|辅助功能已就绪/);
    assert.doesNotMatch(html, /disabled=""/);
    assert.match(render(true), /disabled=""/);
    assert.match(render(false, { ...info, runtimeRecovery: { state: "failed", message: "等待恢复" } }), /disabled=""/);
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
