import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SteerStatus } from "./steer-status.js";
import type { AssistantSteerRecord } from "../../shared/ui-contract.js";

const base = { id: "s1", runId: "r1", text: "保留原文", receivedAt: "2026-10-08T00:00:00Z" };

it("renders accepted/applied/not-applied distinctly and restores only by explicit action", () => {
  const render = (record: AssistantSteerRecord, restore?: (text: string) => void) => renderToStaticMarkup(React.createElement(SteerStatus, { records: [record], onRestore: restore }));
  assert.match(render({ ...base, status: "accepted" }), /等待当前步骤结束/);
  const applied = render({ ...base, status: "applied" });
  assert.match(applied, /已加入后续规划/);
  assert.match(applied, /不代表模型已收到、已执行或一定遵从/);
  assert.doesNotMatch(applied, /<button/);
  const failed = render({ ...base, status: "not_applied", reason: "cancelled" }, () => { throw new Error("render must not resubmit"); });
  assert.match(failed, /本轮未应用/);
  assert.match(failed, /移回草稿，不自动发送/);
  assert.equal(renderToStaticMarkup(React.createElement(SteerStatus, { records: [] })), "");
});

it("composer sends current Run steer before approval/new-task admission and retains Stop", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const submit = app.slice(app.indexOf("const submit = useCallback"), app.indexOf("const busy = state.kind"));
  assert.ok(submit.indexOf("window.runloom.steer(request)") < submit.indexOf("if (approval !== null)"));
  assert.ok(submit.indexOf("window.runloom.steer(request)") < submit.indexOf("await workTasks.run(line)"));
  assert.match(submit, /expectedRunId: state.runId, id: crypto.randomUUID\(\), text: line/);
  assert.match(app, /aria-label=\{steering \? "补充要求"/);
  assert.match(app, /title="停止本轮；已执行的操作不会撤回"/);
  assert.match(app, /核对接收状态/);
  assert.match(app, /if \(uncertainSteer !== null\)/);
  assert.match(app, /message\.runId !== latestPrimaryId\.current/);
});
