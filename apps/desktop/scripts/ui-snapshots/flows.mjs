import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const URL0 = (process.env.PREVIEW_URL ?? "http://127.0.0.1:5187") + "/zcode-preview.html?lifecycle";
const norm = html => html.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "ISO").replace(/\d{1,2}:\d{2}(:\d{2})?(\.\d+)?/g, "HH:MM").replace(/\?t=\d+/g, "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID").replace(/\d+ 毫秒|\d+(\.\d+)? 秒/g, "N 秒");
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
let n = 0;
const calls = [];
async function scenario(name, body) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto(URL0, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  // Record every API call the App makes, in order, with arguments.
  await p.evaluate(() => {
    const f = window.previewFixture; window.__calls = [];
    for (const key of Object.keys(f.api)) {
      const orig = f.api[key];
      if (typeof orig !== "function" || key === "onMessage") continue;
      f.api[key] = (...args) => { window.__calls.push(key + " " + JSON.stringify(args).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID").slice(0, 300)); return orig(...args); };
    }
    f.wrap = (key, impl) => { f.api[key] = (...args) => { window.__calls.push(key + " " + JSON.stringify(args).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID").slice(0, 300)); return impl(...args); }; };
  });
  const shot = async (label) => {
    const key = `${String(++n).padStart(3, "0")}-${name}-${label}`;
    writeFileSync(`${out}/${key}.html`, norm(await p.evaluate(() => document.body.innerHTML)));
    await p.screenshot({ path: `${out}/${key}.png` });
  };
  const send = async (text) => {
    await p.locator("textarea").first().fill(text);
    await p.locator(`button[aria-label="发送消息"]`).first().click({ timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(1200);
  };
  try { await body({ p, shot, send }); } catch (e) { errs.push("SCENARIO " + String(e)); }
  const apiCalls = await p.evaluate(() => window.__calls);
  writeFileSync(`${out}/calls-${name}.txt`, apiCalls.join("\n") + "\n");
  writeFileSync(`${out}/errors-${name}.txt`, errs.join("\n"));
  await ctx.close();
}

await scenario("deny", async ({ p, shot, send }) => {
  await send("读一下计划");
  await shot("approval");
  await p.getByRole("button", { name: /^拒绝/ }).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await shot("denied");
});

await scenario("cancel", async ({ p, shot, send }) => {
  await send("读一下计划");
  await p.locator(`button[aria-label="停止本轮"]`).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await shot("cancelled");
});

await scenario("stream", async ({ p, shot }) => {
  // A run driven only by pushed messages: deltas, steps, a shell tool with live output, then completion.
  await p.evaluate(() => {
    const f = window.previewFixture;
    f.snapshot.state = { kind: "running", runId: "flow-run", phase: "primary" };
    f.emit({ type: "state", state: f.snapshot.state });
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const f = window.previewFixture;
    const ev = (type, data, seq) => f.emit({ type: "event", phase: "primary", event: { id: "e" + seq, runId: "flow-run", threadId: f.threadId(), sequence: seq, occurredAt: "2026-01-01T00:00:00.000Z", type, data } });
    ev("run.started", { agentId: "primary", agentVersion: "1" }, 1);
    ev("step.started", { stepNumber: 1 }, 2);
    ev("message.delta", { text: "先看一下目录，" }, 3);
    ev("tool.call.requested", { toolCallId: "sh1", toolName: "shell_exec", input: { command: "ls" } }, 4);
    ev("tool.call.started", { toolCallId: "sh1", toolName: "shell_exec" }, 5);
    f.emit({ type: "shell-progress", phase: "primary", runId: "flow-run", progress: { toolCallId: "sh1", sequence: 1, stream: "stdout", text: "notes\nsrc\n", truncated: false } });
    f.emit({ type: "shell-progress", phase: "primary", runId: "flow-run", progress: { toolCallId: "sh1", sequence: 2, stream: "stderr", text: "warning: x\n", truncated: false } });
  });
  await p.waitForTimeout(800);
  await shot("shell-live");
  await p.evaluate(() => {
    const f = window.previewFixture;
    const ev = (type, data, seq) => f.emit({ type: "event", phase: "primary", event: { id: "e" + seq, runId: "flow-run", threadId: f.threadId(), sequence: seq, occurredAt: "2026-01-01T00:00:00.000Z", type, data } });
    ev("tool.call.completed", { toolCallId: "sh1", toolName: "shell_exec", output: { exitCode: 0, stdout: "notes\nsrc\n", stderr: "warning: x\n" } }, 6);
    ev("step.completed", { stepNumber: 1, finishReason: "tool-calls", usage: {} }, 7);
    ev("message.delta", { text: "目录里有 notes 和 src。" }, 8);
  });
  await p.waitForTimeout(800);
  await shot("tool-done");
  await p.evaluate(() => {
    const f = window.previewFixture;
    const result = { runId: "flow-run", threadId: f.threadId(), status: "failed", text: "", steps: 1, usage: {}, error: { code: "MODEL_TIMEOUT", message: "模型超时", retryable: true, phase: "model" } };
    f.snapshot.state = { kind: "idle" }; f.snapshot.lastPrimaryResult = result;
    f.emit({ type: "result", phase: "primary", result });
    f.emit({ type: "state", state: f.snapshot.state });
  });
  await p.waitForTimeout(1500);
  await shot("failed-result");
});

await scenario("steer", async ({ p, shot, send }) => {
  await p.evaluate(() => {
    const f = window.previewFixture;
    f.wrap("steer", async (request) => {
      const steer = { id: request.id, runId: request.expectedRunId, text: request.text, status: "accepted", receivedAt: "2026-01-01T00:00:00.000Z" };
      f.snapshot.steers = [steer];
      return { ok: true, steer };
    });
  });
  await send("读一下计划");
  await p.evaluate(() => { const f = window.previewFixture; f.snapshot.canSteer = true; f.emit({ type: "state", state: f.snapshot.state }); });
  await p.waitForTimeout(800);
  await shot("can-steer");
  await send("只看第一节");
  await shot("steer-accepted");
  await p.evaluate(() => {
    const f = window.previewFixture;
    const steer = { ...f.snapshot.steers[0], status: "applied", appliedAt: "2026-01-01T00:00:01.000Z", messageId: "m1" };
    f.snapshot.steers = [steer];
    f.emit({ type: "steer", steer });
  });
  await p.waitForTimeout(800);
  await shot("steer-applied");
  await p.getByRole("button", { name: /^允许/ }).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await shot("finished");
});

await scenario("steer-failed", async ({ p, shot, send }) => {
  await p.evaluate(() => { window.previewFixture.wrap("steer", async () => ({ ok: false, reason: "failed" })); });
  await send("读一下计划");
  await p.evaluate(() => { const f = window.previewFixture; f.snapshot.canSteer = true; f.emit({ type: "state", state: f.snapshot.state }); });
  await p.waitForTimeout(800);
  await send("只看第一节");
  await shot("steer-uncertain");
  await p.evaluate(() => { window.previewFixture.wrap("acknowledgeSteer", async () => null); });
  await p.getByRole("button", { name: "核对接收状态" }).first().click({ timeout: 2000 });
  await p.waitForTimeout(500);
  await shot("recheck-missing");
  await p.getByRole("button", { name: /^允许/ }).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await shot("uncertain-idle");
  await p.evaluate(() => { window.previewFixture.wrap("releaseSteer", async () => true); });
  await p.getByRole("button", { name: "保留草稿，结束本次核对" }).first().click({ timeout: 2000 });
  await p.waitForTimeout(800);
  await shot("released");
});

await scenario("steer-recheck", async ({ p, shot, send }) => {
  await p.evaluate(() => { window.previewFixture.wrap("steer", async () => ({ ok: false, reason: "failed" })); });
  await send("读一下计划");
  await p.evaluate(() => { const f = window.previewFixture; f.snapshot.canSteer = true; f.emit({ type: "state", state: f.snapshot.state }); });
  await p.waitForTimeout(800);
  await send("只看第一节");
  await p.evaluate(() => {
    const f = window.previewFixture;
    f.wrap("acknowledgeSteer", async (_scope, id) => ({ id, runId: f.runId(), text: "只看第一节", status: "accepted", receivedAt: "2026-01-01T00:00:00.000Z" }));
  });
  await p.getByRole("button", { name: "核对接收状态" }).first().click({ timeout: 2000 });
  await p.waitForTimeout(800);
  await shot("rechecked");
  await p.getByRole("button", { name: /^允许/ }).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await shot("finished");
});

await scenario("brief-continue", async ({ p, shot }) => {
  await p.getByRole("button", { name: "手札", exact: true }).last().click({ timeout: 2000 });
  await p.waitForTimeout(500);
  await p.locator(".today-chat-button").first().click({ timeout: 2000 });
  await p.waitForTimeout(1000);
  await shot("continued");
});

await scenario("attachments", async ({ p, shot, send }) => {
  await p.evaluate(() => window.previewFixture.patchInfo({ attachments: true }));
  await p.waitForTimeout(1200);
  await p.locator('input[type="file"]').first().setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("附件正文\n") });
  await p.waitForTimeout(800);
  await shot("attached");
  await p.evaluate(() => {
    const f = window.previewFixture;
    f.wrap("run", async () => {
      f.snapshot.state = { kind: "running", runId: "att-run", phase: "primary" };
      f.emit({ type: "state", state: f.snapshot.state });
      setTimeout(() => {
        const result = { runId: "att-run", threadId: f.threadId(), status: "failed", text: "", steps: 0, usage: {}, error: { code: "MODEL_ERROR", message: "image input not supported", retryable: false, phase: "model" } };
        f.snapshot.state = { kind: "idle" }; f.snapshot.lastPrimaryResult = result;
        f.emit({ type: "result", phase: "primary", result });
        f.emit({ type: "state", state: f.snapshot.state });
      }, 300);
      return { ok: true, runId: "att-run" };
    });
  });
  await send("看看这个附件");
  await shot("recoverable");
  await p.getByRole("button", { name: "恢复到草稿" }).first().click({ timeout: 2000 });
  await p.waitForTimeout(800);
  await shot("restored");
});

await scenario("threads", async ({ p, shot }) => {
  await p.evaluate(() => window.previewFixture.api.selectThread("preview-rss"));
  await p.waitForTimeout(1200);
  await shot("switched");
  await p.evaluate(() => window.previewFixture.api.createThread());
  await p.waitForTimeout(1200);
  await shot("created");
});

await scenario("recovery", async ({ p, shot }) => {
  await p.evaluate(() => window.previewFixture.patchInfo({ runtimeRecovery: { state: "failed", message: "常驻助手已停止" } }));
  await p.waitForTimeout(1200);
  await shot("recovery-failed");
  await p.evaluate(() => window.previewFixture.patchInfo({}));
  await p.waitForTimeout(1200);
  await shot("recovered");
});

await scenario("records", async ({ p, shot, send }) => {
  await send("读一下计划");
  await p.getByRole("button", { name: /^允许/ }).first().click({ timeout: 2000 });
  await p.waitForTimeout(1500);
  await p.locator(`button[aria-label="设置"]`).first().click({ timeout: 2000 });
  await p.waitForTimeout(500);
  await p.locator("button", { hasText: "高级" }).first().click({ timeout: 2000 });
  await p.waitForTimeout(600);
  await shot("advanced");
  const rec = p.locator("button", { hasText: "执行记录" }).first();
  if (await rec.count()) { await rec.click({ timeout: 2000 }); await p.waitForTimeout(1000); await shot("records"); }
  await p.evaluate(() => window.previewFixture.emit({ type: "output", text: "\n[module:pomodoro] 已启动 1 分钟番茄钟。\n" }));
  await p.waitForTimeout(500);
  await shot("after-output");
});

await b.close(); process.exit(0);
