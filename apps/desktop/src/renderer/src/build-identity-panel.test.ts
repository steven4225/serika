import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildIdentityPanel } from "./build-identity-panel.js";

test("version details display frozen loaded identity and separate it from different disk build", () => {
  const markup = renderToStaticMarkup(createElement(BuildIdentityPanel, { info: {
    loaded: { schemaVersion: 1, id: "0123456789abcdef", version: "0.1.0", builtAt: "2026-10-08T00:00:00.000Z",
      frontendSource: { revision: "a".repeat(40), dirty: true }, backendSource: { revision: "b".repeat(40), dirty: false }, backendDistFingerprint: "c".repeat(64) },
    backendDistAtStartup: "c".repeat(64), backendMatchesBuild: true, diskBuild: "different", diskBuildId: "fedcba9876543210",
  } }));
  assert.match(markup, /已加载主进程/);
  assert.match(markup, /0123456789abcdef/);
  assert.match(markup, /磁盘桌面构建/);
  assert.match(markup, /fedcba9876543210/);
  assert.match(markup, /刷新页面不会更新主进程/);
  assert.match(markup, /含未提交修改/);
  assert.match(markup, /不是已编译证明/);
  assert.match(markup, /核对磁盘构建/);
});

test("older preview without identity is unknown rather than assumed current", () => {
  const markup = renderToStaticMarkup(createElement(BuildIdentityPanel, { info: undefined }));
  assert.match(markup, /不能确认版本/);
  assert.doesNotMatch(markup, /一致/);
});

test("build warning does not duplicate punctuation after a macOS service error", () => {
  for (const message of ["后台服务仅支持 macOS。", "后台服务仅支持 macOS.", "后台服务仅支持 macOS。 "]) {
    const markup = renderToStaticMarkup(createElement(BuildIdentityPanel, { info: {
      loaded: null, backendDistAtStartup: null, backendMatchesBuild: null, diskBuild: "unavailable", diskBuildId: null,
    }, worker: { ok: false, message } }));
    assert.match(markup, /后台版本状态不可用：后台服务仅支持 macOS。不能确认/);
    assert.doesNotMatch(markup, /macOS[。.\s]*[。.][。]/);
  }
});

test("Demo: version panel visibly warns about an old worker without a stop side effect", () => {
  const markup = renderToStaticMarkup(createElement(BuildIdentityPanel, { info: {
    loaded: { schemaVersion: 1, id: "0123456789abcdef", version: "0.1.0", builtAt: "2026-10-11T00:00:00.000Z",
      frontendSource: { revision: null, dirty: false }, backendSource: { revision: null, dirty: false }, backendDistFingerprint: "c".repeat(64) },
    backendDistAtStartup: "c".repeat(64), backendMatchesBuild: true, diskBuild: "same", diskBuildId: "0123456789abcdef",
  }, worker: { ok: true, registered: true, running: true, rssEnabled: true, processStartedAt: "2026-10-10T00:00:00.000Z" } }));
  assert.match(markup, /worker 启动早于当前桌面构建/);
  assert.match(markup, /退出托盘/);
  assert.match(markup, /不会自动停止或重做旧任务/);
});
