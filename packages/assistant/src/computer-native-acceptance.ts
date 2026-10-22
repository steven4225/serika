import { dirname } from "node:path";
/** Opt-in real model/driver acceptance. Never installs, starts or kills the daemon. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RunResult } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { createModuleHost } from "./module-host.js";
import { computerConfigSchema, createComputerModule } from "./modules/computer-module.js";

export type NativeScenario = "input" | "deny" | "cancel-approval";
type Target = { bundleId: string; pid: number; windowId: number };
const observationSchema = z.object({ ok: z.literal(true), observationId: z.string(), elements: z.array(z.object({
  role: z.string(), element_token: z.string().optional(), value: z.string().nullable().optional(),
})) });
type Observation = z.infer<typeof observationSchema>;
function exactTarget(input: Record<string, unknown>, target: Target) {
  return input.bundleId === target.bundleId && input.pid === target.pid && input.windowId === target.windowId;
}

/** Test authorization, not a production bypass. Only one exact TextEdit fixture action. */
export function nativeFixtureApprovalAllowed(toolName: string, input: unknown, target: Target,
  marker: string, fresh: Observation | undefined, actions: number): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input) || target.bundleId !== "com.apple.TextEdit") return false;
  const value = input as Record<string, unknown>;
  if (toolName === "computer_observe") return exactTarget(value, target);
  return toolName === "computer_action" && exactTarget(value, target) && value.action === "type_text" &&
    value.text === marker && actions === 0 && fresh !== undefined && value.observationId === fresh.observationId &&
    fresh.elements.filter(e => e.role === "AXTextArea").length === 1 &&
    fresh.elements.some(e => e.role === "AXTextArea" && e.element_token !== undefined && e.element_token === value.elementToken);
}

export async function runComputerNativeAcceptance(configPath: string, title: string, scenario: NativeScenario) {
  assert.equal(process.env.RUNLOOM_COMPUTER_ACCEPTANCE, "1", "Set RUNLOOM_COMPUTER_ACCEPTANCE=1 to opt in to paid requests and test-document interaction");
  assert.equal(process.platform, "darwin", "Native acceptance requires macOS");
  assert.ok(title.trim(), "An exact isolated TextEdit document title is required");
  assert.ok(["input", "deny", "cancel-approval"].includes(scenario), "Unknown scenario");
  const configured = configureCliModel(createDemoModel);
  assert.notEqual(configured.modelAlias, "mock/default", "A real model is required");
  const root = await mkdtemp(join(tmpdir(), "runloom-computer-acceptance-"));
  const marker = `RUNLOOM_TEST_${randomUUID()}`;
  const output = new PassThrough();
  let controller: AssistantController | undefined;
  output.on("data", (chunk: Buffer) => controller?.recordOutput(chunk.toString()));
  const report = { version: 1, scenario, provider: configured.modelAlias, root, marker,
    backendPassed: false, sealed: false, failure: null as string | null,
    approvals: [] as Array<{ toolName: string; decision: "allow" | "deny" | "cancel" }>,
    actions: 0, observedMarker: false, unchanged: false, runStatus: null as string | null,
    runErrorCode: null as string | null, actionReceiptStatus: null as string | null, actionReceiptErrorCode: null as string | null,
    orderedObserveActionObserve: false, whitelistRefused: false, staleTokenRefused: false,
    beforeTextHash: null as string | null, afterTextHash: null as string | null,
    electronHumanApproval: "not_run", independentVisualAcceptance: "not_run",
    inFlightNativeCancellation: "not_run", nativeDisconnect: "not_run" };
  let app: Awaited<ReturnType<typeof createRuntimeApp>> | undefined;
  let host: ReturnType<typeof createModuleHost> | undefined;
  try {
    // Static config and trusted-path validation must complete before any driver call.
    app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(resolve(configPath)), "workspace/.runloom"), threadId: `native-${scenario}`, configPath: resolve(configPath) }, ...configured, output, env: process.env, cwd: process.cwd() });
    controller = createAssistantController(app);
    const config = z.object({ modules: z.object({ computer: computerConfigSchema }).strict() }).parse(JSON.parse(await readFile(configPath, "utf8")));
    assert.equal(config.modules.computer.enabled, true);
    assert.deepEqual(config.modules.computer.allowedBundleIds, ["com.apple.TextEdit"], "Acceptance config must allow only TextEdit");
    host = createModuleHost([createComputerModule(config.modules.computer)], { notify() {} });
    const invoke = async (name: string, input: unknown) => host!.tools.find(t => t.metadata.name === name)!.tool.execute!(input as never,
      { toolCallId: "fixture-preflight", messages: [], context: undefined, abortSignal: new AbortController().signal });
    const listed = z.object({ ok: z.literal(true), truncated: z.literal(false), windows: z.array(z.object({
      pid: z.number(), windowId: z.number(), title: z.string(),
    })) }).parse(await invoke("computer_observe", { bundleId: "com.apple.TextEdit" }));
    const matches = listed.windows.filter(w => w.title === title);
    assert.equal(matches.length, 1, "Exactly one window must match the isolated document title");
    const target = { bundleId: "com.apple.TextEdit", pid: matches[0]!.pid, windowId: matches[0]!.windowId };
    const before = observationSchema.parse(await invoke("computer_observe", target));
    const textOf = (observation: Observation) => {
      const areas = observation.elements.filter(e => e.role === "AXTextArea");
      assert.equal(areas.length, 1, "Fixture must contain one text area");
      assert.equal(typeof areas[0]!.value, "string");
      return areas[0]!.value!;
    };
    const baseline = textOf(before);
    report.whitelistRefused = (await invoke("computer_observe", { bundleId: "com.apple.finder" }) as { ok: boolean }).ok === false;
    assert.ok(report.whitelistRefused);
    let fresh: Observation | undefined;
    const seen = new Set<string>();
    const receipts: Array<{ toolName: string; output: unknown }> = [];
    let cancellation: Promise<void> | undefined;
    const done = new Promise<void>(resolveDone => {
      controller!.subscribe(event => {
        if (event.type === "approval" && !seen.has(event.approval.approvalId)) {
          seen.add(event.approval.approvalId);
          const { toolName, input, approvalId } = event.approval;
          const scoped = nativeFixtureApprovalAllowed(toolName, input, target, marker, fresh, report.actions);
          if (toolName === "computer_action" && scoped && scenario === "cancel-approval") {
            report.approvals.push({ toolName, decision: "cancel" });
            cancellation = controller!.cancel();
          } else {
            const allow = scoped && (toolName !== "computer_action" || scenario === "input");
            report.approvals.push({ toolName, decision: allow ? "allow" : "deny" });
            if (allow && toolName === "computer_action") report.actions++;
            controller!.confirm({ approvalId, decision: allow ? "allow" : "deny" });
          }
        }
        if (event.type === "run-event" && event.phase === "primary" && event.event.type === "tool.call.completed") {
          const data = event.event.data;
          receipts.push(data);
          if (data.toolName === "computer_observe") {
            const parsed = observationSchema.safeParse(data.output);
            fresh = parsed.success ? parsed.data : undefined;
          }
          if (data.toolName === "computer_action") fresh = undefined;
        }
        if (event.type === "state" && event.state.kind === "idle") resolveDone();
      });
    });
    const started = await controller.run(`只进行隔离验收，精确目标 bundleId=${target.bundleId}, pid=${target.pid}, windowId=${target.windowId}，标题=${JSON.stringify(title)}。先 computer_observe 该精确窗口，再对唯一 AXTextArea 以 type_text 插入一次 ${marker}，之后再次观察并回读核对。拒绝或取消则停止，不重试，不改其他内容，不保存，不关闭，不点击，不调用其他工具。不要把 AX 回读或驱动回执说成磁盘保存或业务成功。`);
    assert.ok(started.ok);
    await done;
    await cancellation;
    const result: RunResult | null = controller.getSnapshot().lastPrimaryResult;
    report.runStatus = result?.status ?? null;
    report.runErrorCode = result?.error?.code ?? null;
    const record = await controller.runs.get(started.runId);
    report.actionReceiptStatus = record?.tools.find(t => t.toolName === "computer_action")?.status ?? null;
    report.actionReceiptErrorCode = record?.tools.find(t => t.toolName === "computer_action")?.errorCode ?? null;
    const after = observationSchema.parse(await invoke("computer_observe", target));
    const afterText = textOf(after);
    report.observedMarker = afterText.split(marker).length - 1 === 1;
    report.beforeTextHash = createHash("sha256").update(baseline).digest("hex");
    report.afterTextHash = createHash("sha256").update(afterText).digest("hex");
    report.unchanged = report.beforeTextHash === report.afterTextHash;
    const actionIndex = receipts.findIndex(r => r.toolName === "computer_action" &&
      z.object({ ok: z.literal(true), dispatched: z.literal(true), verified: z.literal(false) }).safeParse(r.output).success);
    report.orderedObserveActionObserve = actionIndex > 0 && receipts.slice(actionIndex + 1).some(r => {
      const parsed = observationSchema.safeParse(r.output);
      return r.toolName === "computer_observe" && parsed.success && textOf(parsed.data).includes(marker);
    });
    // Invalid token must be rejected before dispatch; never valid against this new session.
    report.staleTokenRefused = (await invoke("computer_action", { ...target, observationId: before.observationId,
      elementToken: before.elements.find(e => e.role === "AXTextArea")!.element_token,
      action: "type_text", text: "MUST_NOT_DISPATCH" }) as { ok: boolean }).ok === false;
    assert.ok(report.staleTokenRefused);
    if (scenario === "input") {
      assert.equal(report.runStatus, "completed");
      assert.equal(report.actions, 1);
      assert.ok(report.observedMarker && report.orderedObserveActionObserve);
      assert.equal(report.actionReceiptStatus, "completed");
    } else {
      assert.equal(report.actions, 0);
      assert.ok(report.unchanged);
      assert.ok(report.approvals.some(a => a.toolName === "computer_action" && a.decision === (scenario === "deny" ? "deny" : "cancel")));
      assert.equal(report.runStatus, scenario === "deny" ? "completed" : "cancelled");
      assert.equal(report.actionReceiptStatus, scenario === "deny" ? "failed" : "not_started");
      assert.equal(report.actionReceiptErrorCode, scenario === "deny" ? "TOOL_DENIED" : null);
    }
    report.backendPassed = true;
  } catch { report.failure = "Native fixture check failed; inspect Run receipts. The acceptance program did not rerun the scenario or replay an action."; }
  finally {
    host?.dispose();
    if (controller) await controller.shutdown(); else app?.dispose();
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [configPath, title, scenario = "input"] = process.argv.slice(2);
  assert.ok(configPath && title, "Usage: computer-native-acceptance.js <external-config.json> <exact-test-document-title> [input|deny|cancel-approval]");
  const report = await runComputerNativeAcceptance(configPath, title, scenario as NativeScenario);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.backendPassed) process.exitCode = 1;
}
