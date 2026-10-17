import type { MemoryLibraryAction } from "@serika/example-cli/dist/memory-library.js";
import { validateChatAttachments } from "@serika/example-cli/dist/chat-attachments.js";
import type { MemoryImportEntry, MemoryImportConfirm, MemoryImportPreview, MemoryImportReceipt } from "@serika/example-cli/dist/memory-import.js";
import type { RecipeChange } from "@serika/example-cli/dist/recipe-store.js";
import { Writable } from "node:stream";
import { lstat } from "node:fs/promises";
import { readLoadedBuild } from "./build-identity.js";
import { historyPage, type HistoryPageInput } from "../shared/history.js";
import { ExecutionRecordStore } from "@serika/example-cli/dist/execution-record-store.js";
import type { DesktopThread } from "./desktop-identity.js";
import type { MemoryEditInput, MemoryListInput } from "@serika/example-cli/dist/memory-management.js";
import type { MemoryAction, MemoryHistoryInput } from "@serika/example-cli/dist/memory-controls.js";
import type { AssistantRunOptions } from "@serika/example-cli/dist/assistant-controller.js";
import type { AutomationDiagnostics, SkillRunInput, SkillResult } from "@serika/example-cli/dist/automation-execution.js";
import type { AutomationScheduleAction, ScheduleSkillInput } from "@serika/example-cli/dist/automation-scheduling.js";
import type { DreamingChangeInput } from "@serika/example-cli/dist/dreaming.js";
import type { MemoryConsolidationRequest } from "@serika/example-cli/dist/memory-consolidation.js";
import type { MemoryTemporalQuery } from "@serika/example-cli/dist/memory-store.js";
import type {
  AssistantController,
  AssistantEvent,
  AssistantSnapshot,
  AssistantState,
} from "@serika/example-cli/dist/assistant-controller.js";
import type { RuntimeApp } from "@serika/example-cli/dist/app.js";
import type { RssAction } from "@serika/example-cli/dist/rss-subscriptions.js";
import type { ExecutionRunRecord } from "@serika/example-cli/dist/execution-record-store.js";
import { ShellProgressBuffer } from "../shared/shell-progress.js";
import { sanitizeWorkTaskInput, type WorkTask, type WorkTaskInputs, type WorkTaskResult } from "../shared/work-tasks.js";
import type { WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "../shared/work-tasks.js";
import type { WorkTaskContinuation } from "../shared/work-tasks.js";
import {
  toGetRunResponse,
  toListRunsResponse,
  wrapExecutionQuery,
} from "../shared/execution-records.js";
import type {
  CandidateListInput,
  CandidatePage,
  CandidatePreview,
  CandidateResolution,
  CandidateResolveInput,
  MemoryResult,
} from "@serika/example-cli/dist/memory-candidates.js";
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
    this.#send({ type: "home", text: "", reset: true });
  }

  endHome(): void {
    this.#home = false;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.#controller !== undefined) this.#controller.recordOutput(text);
    else this.#pending.push(text);
    if (this.#home) this.#send({ type: "home", text });
    callback();
  }
}

export function toUiState(state: AssistantState): UiState {
  return state;
}

const CANDIDATE_STATUSES = ["pending", "accepted", "rejected", "stale"] as const;

type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

function invalidInput(message: string): MemoryResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

/** Keep only list fields the controller understands. Drop path, thread, and source. */
export function sanitizeCandidateListInput(input: unknown): CandidateListInput | MemoryResult<never> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return invalidInput("Candidate list input must be an object");
  const record = input as Record<string, unknown>;
  const result: CandidateListInput = {};
  if ("status" in record && record.status !== undefined) {
    if (!CANDIDATE_STATUSES.includes(record.status as CandidateStatus)) {
      return invalidInput("Candidate status must be pending, accepted, rejected, or stale");
    }
    result.status = record.status as CandidateStatus;
  }
  if ("offset" in record && record.offset !== undefined) {
    if (typeof record.offset !== "number" || !Number.isSafeInteger(record.offset) || record.offset < 0) {
      return invalidInput("Candidate offset must be a non-negative integer");
    }
    result.offset = record.offset;
  }
  if ("limit" in record && record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isSafeInteger(record.limit) || record.limit < 1) {
      return invalidInput("Candidate limit must be a positive integer");
    }
    result.limit = record.limit;
  }
  return result;
}

/** Keep the review identity and explicit from-now choice; never accept rewritten fact/source/scope fields. */
export function sanitizeCandidateResolveInput(input: unknown): CandidateResolveInput | MemoryResult<never> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidInput("Candidate review input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.candidateId !== "string" || record.candidateId.length === 0) {
    return invalidInput("Candidate id must be non-empty");
  }
  if (typeof record.expectedCandidateRevision !== "number" || !Number.isSafeInteger(record.expectedCandidateRevision) || record.expectedCandidateRevision < 1) {
    return invalidInput("Candidate revision must be a positive integer");
  }
  if (record.decision !== "accept" && record.decision !== "reject") {
    return invalidInput("Candidate decision must be accept or reject");
  }
  if (record.effectiveAt !== undefined && (record.effectiveAt !== "now" || record.decision !== "accept")) {
    return invalidInput("Effective time must be an explicit from-now acceptance");
  }
  return {
    candidateId: record.candidateId,
    expectedCandidateRevision: record.expectedCandidateRevision,
    decision: record.decision,
    ...(record.effectiveAt === "now" ? { effectiveAt: "now" as const } : {}),
  };
}

function isInputError<T>(value: CandidateListInput | CandidateResolveInput | MemoryResult<T>): value is MemoryResult<T> {
  return "ok" in value && value.ok === false;
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
    const automation = this.#controller.getAutomationDiagnostics();
    const memorySkills = new Set(automation.skills.filter(skill => skill.kind === "memory-consolidate").map(skill => skill.id));
    const autoConsolidate = automation.hooks.some(rule => rule.enabled !== false && memorySkills.has(rule.handler.id));
    return {
      build: readLoadedBuild(),
      ...(this.#app.getCapabilities ? { capabilities: this.#app.getCapabilities() } : {}),
      modules: (["pomodoro", "read-file", "memory", "checkpoint", "task", "todoist", "shell", "web", "computer"] as const).map(id => ({
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
    const receipts = await this.#controller.getMemoryReceipts();
    if (!receipts.ok) return { ...page, memoryReceipts: [], memoryReceiptError: receipts.error.message };
    // Latest batch is bounded. Return its full projection so loading an older
    // page cannot erase receipts already attached to newer loaded messages.
    return { ...page, memoryReceipts: receipts.value };
  }

  getContextDiagnostics() {
    return this.#controller.getContextDiagnostics();
  }

  getAutomationDiagnostics(): AutomationDiagnostics {
    return this.#controller.getAutomationDiagnostics();
  }
  getAutomationOverview() { return this.#controller.getAutomationOverview(); }
  scheduleSkill(input: ScheduleSkillInput) { return this.#controller.scheduleSkill(input); }
  changeAutomationSchedule(input: AutomationScheduleAction) { return this.#controller.changeAutomationSchedule(input); }
  getDreamingOverview() { return this.#controller.getDreamingOverview(); }
  dream() { return this.#controller.dream(); }
  changeLearnedSkill(input: DreamingChangeInput) { return this.#controller.changeLearnedSkill(input); }
  getLearnedSkillReferences() { return this.#controller.getLearnedSkillReferences(); }

  /** Pass the complete invocation to strict host validation; never drop forged authority fields. */
  runSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>> {
    return this.#controller.runSkill(input);
  }
  getMemoryLibrary() { return this.#controller.getMemoryLibrary(); }
  readMemoryDocument(id: string) { return this.#controller.readMemoryDocument(id); }
  changeMemoryLibrary(input: MemoryLibraryAction) { return this.#controller.changeMemoryLibrary(input); }
  listMemories(input?: MemoryListInput) {
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) return Promise.resolve(invalidInput("Invalid Memory page"));
    return this.#controller.listMemories(input);
  }
  getMemory(id: string) {
    if (typeof id !== "string" || !id || id.length > 256) return Promise.resolve(invalidInput("Invalid Memory id"));
    return this.#controller.getMemory(id);
  }
  previewMemoryImport(entries: MemoryImportEntry[]) { return this.#controller.previewMemoryImport(entries); }
  confirmMemoryImport(input: MemoryImportConfirm) { return this.#controller.confirmMemoryImport(input); }
  getMemoryImportReceipt(operationId: string) { return this.#controller.getMemoryImportReceipt(operationId); }
  listRecipes() { return this.#controller.listRecipes(); }
  changeRecipe(input: RecipeChange) { return this.#controller.changeRecipe(input); }
  updateMemory(input: MemoryEditInput) { return this.#controller.updateMemory(input); }
  getMemoryHistory(input: MemoryHistoryInput) { return this.#controller.getMemoryHistory(input); }
  queryMemory(input: MemoryTemporalQuery & { id: string }) { return this.#controller.queryMemory(input); }
  previewMemoryAction(input: MemoryAction) { return this.#controller.previewMemoryAction(input); }
  applyMemoryAction(input: MemoryAction) { return this.#controller.applyMemoryAction(input); }
  getMemoryMaintenance() { return this.#controller.getMemoryMaintenance(); }
  consolidateMemory(input: MemoryConsolidationRequest) { return this.#controller.consolidateMemory(input); }
  listMemoryConsolidationSources(offset?: number) { return this.#controller.listMemoryConsolidationSources(offset); }
  getMemoryReferences() { return this.#controller.getMemoryReferences(); }

  getRssSubscriptions() { return this.#controller.getRssSubscriptions(); }
  updateRssSubscriptions(input: RssAction) { return this.#controller.updateRssSubscriptions(input); }
  getRssInbox() { return this.#controller.getRssInbox(); }
  acknowledgeRssResult(id: string) { return this.#controller.acknowledgeRssResult(id); }
  getTaskInbox() { return this.#controller.getTaskInbox(); }
  getScheduledTask(id: string) { return this.#controller.getScheduledTask(id); }
  acknowledgeTaskResult(id: string) { return this.#controller.acknowledgeTaskResult(id); }

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
    return { accepted: this.#controller.confirm(input) };
  }

  command(line: string): Promise<CommandResponse> {
    return this.#controller.command(line);
  }

  async listRuns(): Promise<ListRunsResponse> {
    const usage = await wrapExecutionQuery(async () => this.#controller.listModelUsage?.());
    if (!usage.ok) return usage;
    return toListRunsResponse(
      await wrapExecutionQuery((): Promise<ExecutionRunRecord[]> => this.#controller.listRuns()),
      usage.value,
    );
  }

  async getRun(runId: string): Promise<GetRunResponse> {
    return toGetRunResponse(
      await wrapExecutionQuery((): Promise<ExecutionRunRecord | null> => this.#controller.getRun(runId)),
    );
  }

  async listMemoryCandidates(input?: CandidateListInput): Promise<MemoryResult<CandidatePage>> {
    const sanitized = sanitizeCandidateListInput(input);
    if (isInputError(sanitized)) return sanitized;
    return this.#controller.listMemoryCandidates(sanitized);
  }

  async getMemoryCandidate(id: string): Promise<MemoryResult<CandidatePreview>> {
    if (typeof id !== "string" || id.length === 0) return invalidInput("Candidate id must be non-empty");
    return this.#controller.getMemoryCandidate(id);
  }

  async resolveMemoryCandidate(input: CandidateResolveInput): Promise<MemoryResult<CandidateResolution>> {
    const sanitized = sanitizeCandidateResolveInput(input);
    if (isInputError(sanitized)) return sanitized;
    return this.#controller.resolveMemoryCandidate(sanitized);
  }

  listWorkTasks(): Promise<WorkTaskResult<WorkTask[]>> { return this.#controller.listWorkTasks(); }

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
    return this.#controller.getWorkTask(id);
  }

  async getWorkTaskContinuation(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTaskContinuation>> {
    if (!validTaskRead(input)) return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    return this.#controller.getWorkTaskContinuation({ id: input.id, expectedRevision: input.expectedRevision });
  }

  async getWorkTaskDeliveryDraft(input: WorkTaskReadInput): Promise<WorkTaskReadResult<WorkTaskDeliveryDraft>> {
    if (!validTaskRead(input)) return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    return this.#controller.getWorkTaskDeliveryDraft({ id: input.id, expectedRevision: input.expectedRevision });
  }

  async getWorkTaskArtifact(input: WorkTaskArtifactInput): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>> {
    if (!validTaskRead(input) || typeof input.path !== "string" || !input.path || input.path.length > 1024) {
      return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task identity and artifact path are required" } };
    }
    return this.#controller.getWorkTaskArtifact({ id: input.id, expectedRevision: input.expectedRevision, path: input.path });
  }

  async #writeTask<K extends Exclude<keyof WorkTaskInputs, "runWorkTask">>(operation: K, input: WorkTaskInputs[K]): Promise<WorkTaskResult<WorkTask>> {
    const sanitized = sanitizeWorkTaskInput(operation, input);
    if (!sanitized.ok) return sanitized;
    if (this.#controller.getSnapshot().state.kind !== "idle") return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller busy; task change was not queued" } };
    // Sanitization preserves each method's input; the controller enforces Thread and revision.
    const method = this.#controller[operation] as (value: WorkTaskInputs[K]) => Promise<WorkTaskResult<WorkTask>>;
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
    return this.#controller.runWorkTask({ ...sanitized.value, ...(source ? { source } : {}) }, source === "telegram" ? undefined : { desktopEntry: true });
  }

  async shutdown(): Promise<void> {
    this.#unsubscribe();
    await this.#controller.shutdown();
  }
}
