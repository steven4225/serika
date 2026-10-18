import type { HomeSnapshot } from "@serika/assistant";
import type { MemoryLibraryAction } from "@serika/assistant";
import { BUILTIN_MODULE_IDS, validateChatAttachments } from "@serika/assistant";
import type { RecipeChange } from "@serika/assistant";
import { Writable } from "node:stream";
import { lstat } from "node:fs/promises";
import { readLoadedBuild } from "./build-identity.js";
import { historyPage, type HistoryPageInput } from "../shared/history.js";
import { ExecutionRecordStore } from "@serika/assistant";
import type { DesktopThread } from "./desktop-identity.js";
import type { MemoryEditInput, MemoryListInput } from "@serika/assistant";
import type { MemoryAction, MemoryHistoryInput } from "@serika/assistant";
import type { AssistantRunOptions } from "@serika/assistant";
import type { AutomationDiagnostics, SkillRunInput, SkillResult } from "@serika/assistant";
import type { AutomationScheduleAction, ScheduleSkillInput } from "@serika/assistant";
import type { DreamingChangeInput } from "@serika/assistant";
import type { AssistantController, AssistantEvent, AssistantSnapshot, AssistantState } from "@serika/assistant";
import type { RuntimeApp } from "@serika/assistant";
import type { RssAction } from "@serika/assistant";
import type { ExecutionRunRecord } from "@serika/assistant";
import { ShellProgressBuffer } from "../shared/shell-progress.js";
import { sanitizeWorkTaskInput, type WorkTask, type WorkTaskInputs, type WorkTaskOperationMethods, type WorkTaskResult } from "../shared/work-tasks.js";
import type { WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "../shared/work-tasks.js";
import type { WorkTaskContinuation } from "../shared/work-tasks.js";
import {
  toGetRunResponse,
  toListRunsResponse,
  wrapExecutionQuery,
} from "../shared/execution-records.js";
import type { MemoryResult } from "@serika/assistant";
import type {
  AppInfo,
  CommandResponse,
  ConfirmInput,
  ConfirmResponse,
  GetRunResponse,
  ListRunsResponse,
  MainToRenderer,
  RunResponse,
  UiSnapshot,
  UiState,
} from "../shared/ui-contract.js";

const TUI_DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const TUI_DEFAULT_SHELL_TIMEOUT_MS = 30_000;

function validTaskRead(input: unknown): input is WorkTaskReadInput {
  return typeof input === "object" && input !== null && "id" in input && typeof input.id === "string" &&
    input.id.trim().length > 0 && "expectedRevision" in input && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) > 0;
}

const MODULE_NOTIFICATION = /^\s*\[module:([^\]]+)\]\s*([\s\S]*?)\s*$/;

/** Parsed `[module:id] message` line written by the module host's notify hook. */
export function parseModuleNotification(text: string): { moduleId: string; message: string } | undefined {
  const match = MODULE_NOTIFICATION.exec(text);
  if (match === null) return undefined;
  return { moduleId: match[1]!, message: match[2]! };
}

export type Send = (message: MainToRenderer) => void;

/**
 * Writable passed to `createRuntimeApp`. Every chunk is teed into
 * `controller.recordOutput` so reload snapshots keep command/Home/module text.
 */
export class TeeOutput extends Writable {
  #send: Send;
  #controller: AssistantController | undefined;
  #pending: string[] = [];
  #home = false;

  constructor(send: Send) {
    super({ decodeStrings: false });
    this.#send = send;
  }

  attach(controller: AssistantController): void {
    this.#controller = controller;
    for (const text of this.#pending) controller.recordOutput(text);
    this.#pending = [];
  }

  beginHome(): void {
    this.#home = true;
    this.#send({ type: "home", snapshot: null });
  }

  endHome(): void {
    this.#home = false;
  }

  /** The structured Home for the panel; its CLI text still goes through _write to the output log. */
  homeSnapshot(snapshot: HomeSnapshot): void {
    if (this.#home) this.#send({ type: "home", snapshot });
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.#controller !== undefined) this.#controller.recordOutput(text);
    else this.#pending.push(text);
    callback();
  }
}

export function toUiState(state: AssistantState): UiState {
  return state;
}

const WORK_TASK_METHODS: WorkTaskOperationMethods = {
  createWorkTask: "create",
  runWorkTask: "run",
  submitWorkTaskDelivery: "submitDelivery",
  recordHumanAcceptance: "recordHumanAcceptance",
  reconcileWorkTask: "reconcile",
  cancelWorkTask: "cancel",
  requestWorkTaskChanges: "requestChanges",
};
function invalidInput(message: string): MemoryResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

/**
 * Map a controller event onto the renderer channel.
 * Unknown events stay in the exhaustive default and are not silently ignored.
 */
export function assistantEventToRenderer(event: AssistantEvent): MainToRenderer | null {
  switch (event.type) {
    case "state":
      return { type: "state", state: toUiState(event.state) };
    case "approval":
      return { type: "approval", approval: event.approval };
    case "approval-cleared":
      return { type: "approval-cleared", approvalId: event.approvalId };
    case "steer":
      return { type: "steer", steer: event.steer };
    case "run-event":
      return { type: "event", phase: event.phase, event: event.event };
    case "run-result":
      return { type: "result", phase: event.phase, result: event.result };
    case "shell-progress":
      return {
        type: "shell-progress",
        phase: event.phase,
        runId: event.runId,
        progress: event.progress,
      };
    case "memory-updated":
      return { type: "memory-updated", reason: event.reason };
    case "memory-references-changed":
      return { type: "memory-references-changed" };
    case "work-task-updated":
      return { type: "work-task-updated", task: event.task };
    case "output":
      return { type: "output", text: event.text };
    case "error":
      return { type: "error", message: event.message };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function toUiSnapshot(snapshot: AssistantSnapshot, shellProgress: UiSnapshot["shellProgress"]): UiSnapshot {
  return {
    state: toUiState(snapshot.state),
    canSubmit: snapshot.canSubmit,
    canSteer: snapshot.canSteer,
    steers: snapshot.steers,
    pendingApproval: snapshot.pendingApproval,
    recentOutput: snapshot.recentOutput,
    outputTruncated: snapshot.outputTruncated,
    toolActivity: snapshot.toolActivity,
    lastPrimaryResult: snapshot.lastPrimaryResult,
    lastConsolidationResult: snapshot.lastConsolidationResult,
    resultTextTruncated: snapshot.resultTextTruncated,
    shellProgress,
  };
}

export interface BridgeIdentity {
  modelAlias: string;
  modelId?: string;
  identitySource?: "saved" | "explicit";
  entryMode?: "daily" | "test";
  temporaryThread: boolean;
  temporaryDirectory: boolean;
}

/**
 * Thin IPC adapter over AssistantController. Owns the Shell progress buffer
 * used to survive renderer reloads; it does not run a second AgentLoop.
 */
export class RuntimeBridge {
  readonly #app: RuntimeApp;
  readonly #controller: AssistantController;
  readonly #output: TeeOutput;
  readonly #identity: BridgeIdentity;
  readonly #shell = new ShellProgressBuffer();
  readonly #unsubscribe: () => void;

  constructor(
    app: RuntimeApp,
    controller: AssistantController,
    identity: BridgeIdentity,
    output: TeeOutput,
    send: Send,
  ) {
    this.#app = app;
    this.#controller = controller;
    this.#identity = identity;
    this.#output = output;
    this.#unsubscribe = controller.subscribe((event) => {
      if (event.type === "state" && event.state.kind === "running" && event.state.phase === "primary" && event.state.runId === null) this.#shell.clear();
      if (event.type === "shell-progress") this.#shell.apply(event.progress);
      const message = assistantEventToRenderer(event);
      if (message !== null) send(message);
    });
  }

  info(): AppInfo {
    const automation = this.#controller.automation.getDiagnostics();
    const memorySkills = new Set(automation.skills.filter(skill => skill.kind === "memory-consolidate").map(skill => skill.id));
    const autoConsolidate = automation.hooks.some(rule => rule.enabled !== false && memorySkills.has(rule.handler.id));
    return {
      build: readLoadedBuild(),
      ...(this.#app.getCapabilities ? { capabilities: this.#app.getCapabilities() } : {}),
      modules: BUILTIN_MODULE_IDS.map(id => ({
        id,
        enabled: this.#app.moduleConfig?.enabled[id] === true,
      })),
      autonomy: { enabled: this.#app.desktopAutonomyEnabled === true, workspaceRoot: this.#app.workspaceRoot ?? null },
      configPath: this.#app.moduleConfig?.configPath ?? null,
      moduleOptions: {
        webSearch: this.#app.moduleConfig?.webSearchEnabled === true,
        webFeed: this.#app.moduleConfig?.webFeedEnabled === true,
        autoConsolidate,
      },
      modelAlias: this.#identity.modelAlias,
      ...(this.#identity.modelId === undefined ? {} : { modelId: this.#identity.modelId }),
      computer: {
        enabled: this.#app.moduleConfig?.enabled.computer === true,
        allowedBundleIds: this.#app.moduleConfig?.computer?.allowedBundleIds ?? [],
      },
      ...(this.#identity.identitySource === undefined ? {} : { identitySource: this.#identity.identitySource }),
      entryMode: this.#identity.entryMode ?? "daily",
      threadId: this.#app.threadId,
      temporaryThread: this.#identity.temporaryThread,
      directory: this.#app.directory,
      temporaryDirectory: this.#identity.temporaryDirectory,
      workspaceRoot: this.#app.workspaceRoot ?? null,
      tuiMode: this.#app.tuiMode,
      commands: [...new Set([
        ...(this.#app.commands ? [...this.#app.commands.keys()] : []),
        ...(this.#app.compaction ? ["compact"] : []),
        ...(this.#app.resume ? ["resume"] : []),
        "skills", "hooks", "skill",
      ])].sort(),
      hasCompaction: this.#app.compaction !== undefined,
      hasResume: this.#app.resume !== undefined,
      totalTimeoutMs: this.#app.moduleConfig?.totalTimeoutMs ?? TUI_DEFAULT_TOTAL_TIMEOUT_MS,
      shellTimeoutMs: this.#app.moduleConfig?.shellTimeoutMs ?? TUI_DEFAULT_SHELL_TIMEOUT_MS,
      memory: {
        enabled: this.#app.moduleConfig?.enabled.memory === true && this.#app.memoryStore !== undefined,
        autoConsolidate,
        writePolicy: this.#app.moduleConfig?.memoryWritePolicy ?? "review",
        queryRewriteEnabled: this.#app.moduleConfig?.memoryQueryRewriteEnabled === true,
      },
      workTasks: this.#app.workTasks !== undefined,
    };
  }

  snapshot(): UiSnapshot {
    return toUiSnapshot(this.#controller.getSnapshot(), this.#shell.snapshot());
  }

  history() {
    return this.#controller.getHistory();
  }

  async historyPage(input?: HistoryPageInput) {
    const page = historyPage(await this.#controller.getHistory(), this.#app.threadId, input);
    const receipts = await this.#controller.memory.getReceipts();
    if (!receipts.ok) return { ...page, memoryReceipts: [], memoryReceiptError: receipts.error.message };
    // Latest batch is bounded. Return its full projection so loading an older
    // page cannot erase receipts already attached to newer loaded messages.
    return { ...page, memoryReceipts: receipts.value };
  }

  getContextDiagnostics() {
    return this.#controller.getContextDiagnostics();
  }

  getAutomationDiagnostics(): AutomationDiagnostics {
    return this.#controller.automation.getDiagnostics();
  }
  getAutomationOverview() { return this.#controller.automation.getOverview(); }
  scheduleSkill(input: ScheduleSkillInput) { return this.#controller.automation.scheduleSkill(input); }
  changeAutomationSchedule(input: AutomationScheduleAction) { return this.#controller.automation.changeSchedule(input); }
  getDreamingOverview() { return this.#controller.dreaming.getOverview(); }
  dream() { return this.#controller.dreaming.dream(); }
  changeLearnedSkill(input: DreamingChangeInput) { return this.#controller.dreaming.changeLearnedSkill(input); }
  getLearnedSkillReferences() { return this.#controller.dreaming.getLearnedSkillReferences(); }

  /** Pass the complete invocation to strict host validation; never drop forged authority fields. */
  runSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>> {
    return this.#controller.automation.runSkill(input);
  }
  getMemoryLibrary() { return this.#controller.memory.getLibrary(); }
  readMemoryDocument(id: string) { return this.#controller.memory.readDocument(id); }
  changeMemoryLibrary(input: MemoryLibraryAction) { return this.#controller.memory.changeLibrary(input); }
  listMemories(input?: MemoryListInput) {
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) return Promise.resolve(invalidInput("Invalid Memory page"));
    return this.#controller.memory.list(input);
  }
  getMemory(id: string) {
    if (typeof id !== "string" || !id || id.length > 256) return Promise.resolve(invalidInput("Invalid Memory id"));
    return this.#controller.memory.get(id);
  }
  listRecipes() { return this.#controller.recipes.list(); }
  changeRecipe(input: RecipeChange) { return this.#controller.recipes.change(input); }
  updateMemory(input: MemoryEditInput) { return this.#controller.memory.update(input); }
  getMemoryHistory(input: MemoryHistoryInput) { return this.#controller.memory.getHistory(input); }
  previewMemoryAction(input: MemoryAction) { return this.#controller.memory.previewAction(input); }
  applyMemoryAction(input: MemoryAction) { return this.#controller.memory.applyAction(input); }
  getMemoryMaintenance() { return this.#controller.memory.getMaintenance(); }
  getMemoryReferences() { return this.#controller.memory.getReferences(); }

  getRssSubscriptions() { return this.#controller.rss.getSubscriptions(); }
  updateRssSubscriptions(input: RssAction) { return this.#controller.rss.updateSubscriptions(input); }
  getRssInbox() { return this.#controller.rss.getInbox(); }
  acknowledgeRssResult(id: string) { return this.#controller.rss.acknowledgeResult(id); }
  getTaskInbox() { return this.#controller.automation.getTaskInbox(); }
  getScheduledTask(id: string) { return this.#controller.automation.getScheduledTask(id); }
  acknowledgeTaskResult(id: string) { return this.#controller.automation.acknowledgeTaskResult(id); }

  async home(): Promise<CommandResponse> {
    this.#output.beginHome();
    try {
      return await this.#controller.command("/home");
    } finally {
      this.#output.endHome();
    }
  }

  async run(text: string, options?: AssistantRunOptions): Promise<RunResponse> {
    // No renderer-supplied metadata, model options or authority may cross this boundary.
    const attachments = validateChatAttachments(options?.attachments);
    const safeOptions = { ...(options?.memoryConsolidation === "exclude" ? { memoryConsolidation: "exclude" as const } : {}), ...(attachments.length ? { attachments } : {}) };
    return this.#runWithOptions(text, { ...safeOptions, desktopEntry: true });
  }

  /** Trusted gateway clock, deliberately separate from renderer run options. */
  telegramAutonomyEnabled() { return this.#app.telegramAutonomyEnabled?.() === true; }

  async runFromChannel(text: string, receivedAt?: string): Promise<RunResponse> {
    if (receivedAt !== undefined && (!/\+08:00$/.test(receivedAt) || !Number.isFinite(Date.parse(receivedAt)))) throw new Error("消息接收时间无效，未启动执行");
    return this.#runWithOptions(text, { source: "telegram", ...(receivedAt ? { receivedAt } : {}) });
  }

  async #runWithOptions(text: string, safeOptions?: AssistantRunOptions): Promise<RunResponse> {
    if (text.trim().length === 0 && !safeOptions?.attachments?.length) return { ok: false, reason: "empty" };
    if (this.#controller.getSnapshot().state.kind !== "idle") {
      return this.#controller.run(text, safeOptions);
    }
    this.#shell.clear();
    return this.#controller.run(text, safeOptions);
  }

  cancel(): Promise<void> {
    return this.#controller.cancel();
  }

  steer(input: Parameters<AssistantController["steer"]>[0]): ReturnType<AssistantController["steer"]> {
    // Forward only the controller-owned Run and request identity, never authority.
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    return this.#controller.steer({ expectedRunId: input.expectedRunId, id: input.id, text: input.text });
  }

  confirm(input: ConfirmInput): ConfirmResponse {
    if (typeof input !== "object" || input === null || typeof input.approvalId !== "string" ||
      (input.decision !== "allow" && input.decision !== "deny") ||
      (input.remember !== undefined && input.remember !== true)) return { accepted: false };
    return { accepted: this.#controller.confirm({ approvalId: input.approvalId, decision: input.decision,
      ...(input.remember === true ? { remember: true } : {}) }) };
  }

  command(line: string): Promise<CommandResponse> {
    return this.#controller.command(line);
  }

  async listRuns(): Promise<ListRunsResponse> {
    const usage = await wrapExecutionQuery(async () => this.#controller.runs.listModelUsage?.());
    if (!usage.ok) return usage;
    return toListRunsResponse(
      await wrapExecutionQuery((): Promise<ExecutionRunRecord[]> => this.#controller.runs.list()),
      usage.value,
    );
  }

  async getRun(runId: string): Promise<GetRunResponse> {
    return toGetRunResponse(
      await wrapExecutionQuery((): Promise<ExecutionRunRecord | null> => this.#controller.runs.get(runId)),
    );
  }

  listWorkTasks(): Promise<WorkTaskResult<WorkTask[]>> { return this.#controller.workTasks.list(); }

  /** Registered identities only, read-only stores; never activate/recover another Controller. */
  async threadActivity(thread: DesktopThread) {
    const tasks = await this.#app.workTasks?.list({ threadId: thread.threadId, limit: 100 });
    if (tasks && !tasks.ok) throw new Error(`任务记录读取失败：${tasks.error.message}`);
    let runs: ExecutionRunRecord[] = [];
    let directoryExists = true;
    try { await lstat(thread.transcriptDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") directoryExists = false; else throw error; }
    if (directoryExists) runs = await new ExecutionRecordStore(thread.transcriptDirectory).listRuns(thread.threadId, 50);
    return { tasks: tasks?.value ?? [], runs };
  }

  async getWorkTask(id: string): Promise<WorkTaskResult<WorkTask>> {
    if (typeof id !== "string" || !id.trim()) return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id must be non-empty" } };
    return this.#controller.workTasks.get(id);
  }

  async getWorkTaskContinuation(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTaskContinuation>> {
    if (!validTaskRead(input)) return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    return this.#controller.workTasks.getContinuation({ id: input.id, expectedRevision: input.expectedRevision });
  }

  async getWorkTaskDeliveryDraft(input: WorkTaskReadInput): Promise<WorkTaskReadResult<WorkTaskDeliveryDraft>> {
    if (!validTaskRead(input)) return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    return this.#controller.workTasks.getDeliveryDraft({ id: input.id, expectedRevision: input.expectedRevision });
  }

  async getWorkTaskArtifact(input: WorkTaskArtifactInput): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>> {
    if (!validTaskRead(input) || typeof input.path !== "string" || !input.path || input.path.length > 1024) {
      return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task identity and artifact path are required" } };
    }
    return this.#controller.workTasks.getArtifact({ id: input.id, expectedRevision: input.expectedRevision, path: input.path });
  }

  async #writeTask<K extends Exclude<keyof WorkTaskInputs, "runWorkTask">>(operation: K, input: WorkTaskInputs[K]): Promise<WorkTaskResult<WorkTask>> {
    const sanitized = sanitizeWorkTaskInput(operation, input);
    if (!sanitized.ok) return sanitized;
    if (this.#controller.getSnapshot().state.kind !== "idle") return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller busy; task change was not queued" } };
    // Sanitization preserves each method's input; the controller enforces Thread and revision.
    const method = this.#controller.workTasks[WORK_TASK_METHODS[operation]] as (value: WorkTaskInputs[K]) => Promise<WorkTaskResult<WorkTask>>;
    return method(sanitized.value);
  }

  createWorkTask(input: WorkTaskInputs["createWorkTask"]) { return this.#writeTask("createWorkTask", input); }
  submitWorkTaskDelivery(input: WorkTaskInputs["submitWorkTaskDelivery"]) { return this.#writeTask("submitWorkTaskDelivery", input); }
  recordHumanAcceptance(input: WorkTaskInputs["recordHumanAcceptance"]) { return this.#writeTask("recordHumanAcceptance", input); }
  reconcileWorkTask(input: WorkTaskInputs["reconcileWorkTask"]) { return this.#writeTask("reconcileWorkTask", input); }
  cancelWorkTask(input: WorkTaskInputs["cancelWorkTask"]) { return this.#writeTask("cancelWorkTask", input); }
  requestWorkTaskChanges(input: WorkTaskInputs["requestWorkTaskChanges"]) { return this.#writeTask("requestWorkTaskChanges", input); }

  runWorkTask(input: WorkTaskInputs["runWorkTask"]): Promise<RunResponse> { return this.#startWorkTask(input); }

  /** Trusted gateway only; deliberately absent from resident/renderer method dispatch. */
  runWorkTaskFromChannel(input: WorkTaskInputs["runWorkTask"]): Promise<RunResponse> { return this.#startWorkTask(input, "telegram"); }

  async #startWorkTask(input: WorkTaskInputs["runWorkTask"], source?: "telegram"): Promise<RunResponse> {
    const sanitized = sanitizeWorkTaskInput("runWorkTask", input);
    if (!sanitized.ok) return { ok: false, reason: "starting" };
    if (this.#controller.getSnapshot().state.kind !== "idle") return { ok: false, reason: "busy" };
    return this.#controller.workTasks.run({ ...sanitized.value, ...(source ? { source } : {}) }, source === "telegram" ? undefined : { desktopEntry: true });
  }

  async shutdown(): Promise<void> {
    this.#unsubscribe();
    await this.#controller.shutdown();
  }
}
