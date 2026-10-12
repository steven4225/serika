import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import type {
  AppInfo,
  CommandResponse,
  MainToRenderer,
  PendingApproval,
  UiSnapshot,
  UiState,
  ExecutionRunRecord,
  ThreadSummary,
  AssistantSteerRecord,
} from "../../shared/ui-contract.js";
import { ShellProgressBuffer } from "../../shared/shell-progress.js";
import {
  applyEvent,
  applyShellProgress,
  emptyLiveRun,
  finishRun,
  overlayShellProgress,
  overlayExecutionReceipts,
  canReuseReceiptHistory,
  resultRow,
  rowsFromHistory,
  annotateHistoryTools,
  rowsFromToolActivity,
  type ConversationRow,
  type LiveRun,
  type ToolRowStatus,
} from "./conversation.js";
import { baseName, parseHome, shortId, type HomeView } from "./home.js";
import { MemoryPanel } from "./memory.js";
import { MemoryConsolidationPanel, MemoryConsolidationNotice } from "./memory-consolidation.js";
import { ThreadsPanel } from "./threads.js";
import { MemoryReferences } from "./memory-references.js";
import { ContextPanel } from "./context.js";
import { RecordsPanel, type RecordDetailState, type RecordsState } from "./records.js";
import { ApprovalCard } from "./approval.js";
import { shouldSubmitComposer, canSubmitComposer, canSteerComposer } from "../../shared/composer.js";
import { mergeSteerRecords, steerFailureLabel } from "../../shared/steer.js";
import { SteerStatus } from "./steer-status.js";
import { Icon, SerikaMark, SerikaPersona, type IconName } from "./icons.js";
import { MessageContent } from "./markdown.js";
import { CapabilitiesPanel } from "./capabilities.js";
import { PomodoroPanel } from "./pomodoro.js";
import { PendingMemory, type PendingMemoryStatus } from "./pending-memory.js";
import { AssistantReply } from "./delivery.js";
import { attentionKind, headerStatus, loadedCountLabel, deliveredReplyKeys, isMockModel } from "./attention.js";
import { CurrentTask, useWorkTasks, WorkTasksPanel } from "./work-tasks.js";
import { RssPanel } from "./rss.js";
import { TaskInbox } from "./task-inbox.js";
import { SavedTaskNotice } from "./saved-task-notice.js";
import { unreconciledRuns, taskSelectionKey, taskActions } from "./work-task-data.js";
import { bindTaskComposer, completionLabel, draftKey, type ConversationDraft } from "./navigation.js";
import { DailySetup } from "./daily-setup-panel.js";
import { desktopLayout, type DesktopLayout } from "./zcode/layout.js";
import { ZCodeMessage, ZCodeMessageContent } from "./zcode/message.js";
import { PersonalConversation as ZCodeConversation, PersonalBackToBottom as ZCodeBackToBottom } from "./personal/conversation.js";
import { PersonalPromptEditor as ZCodePromptEditor, PersonalPromptOptions as ZCodePromptOptions } from "./personal/composer.js";
import { TodayPanel } from "./personal/today.js";
import { PersonaPanel } from "./personal/persona.js";
import { SearchOverlay } from "./personal/search-overlay.js";
import { clampChatFraction, loadChatFraction, loadSidebarOpen, dashboardTabForDetail, PERSONAL_SPLIT_KEY, PERSONAL_SIDEBAR_KEY, PERSONAL_COMPACT_BREAKPOINT } from "./personal/layout.js";
import { humanFacingTitle } from "../../shared/human-title.js";
import { RemindersPanel } from "./reminders.js";
import { presentHomeTaskItem, reminderClock } from "./reminder-copy.js";
import { DesktopWindowFrame } from "./zcode/upstream/desktop-window-frame.js";
import { Button } from "./zcode/upstream/button.js";
import { ArrowUp, Square, Search, Settings2, Sun, Moon } from "lucide-react";
import { draftScope, type UncertainSteer } from "../../shared/conversation-drafts.js";
import { ErrorBanner, FailureInline } from "./failure-notice.js";
import "./zcode/theme.css";
import "./personal/shell.css";
import "./personal/today.css";
import "./personal/conversation.css";

const OUTPUT_MAX_CHARS = 64 * 1024;

function commandError(response: CommandResponse): string {
  if (response.ok) return "";
  switch (response.reason) {
    case "failed":
      return response.message;
    case "cancelled":
      return "命令已取消";
    case "busy":
      return "当前忙，未排队";
    case "unknown":
      return "未知命令";
    case "empty":
      return "命令为空";
    default: {
      const exhaustive: never = response;
      return exhaustive;
    }
  }
}

function Row({ row, delivered = false, layout = "classic" }: { row: ConversationRow; delivered?: boolean; layout?: DesktopLayout }) {
  switch (row.kind) {
    case "text":
      if (layout === "zcode") return <ZCodeMessage from={row.role} className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
        <ZCodeMessageContent>
          {row.role !== "user" ? <span className="role">{row.role === "assistant" ? <><SerikaMark size={18} /> Serika</> : "系统"}</span> : null}
          {row.role === "assistant" ? <AssistantReply text={row.text} delivered={delivered} /> : <pre>{row.text}</pre>}
        </ZCodeMessageContent>
      </ZCodeMessage>;
      return (
        <div className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
          {row.role !== "user" ? <span className="role">{row.role === "assistant" ? <><SerikaMark size={20} /> Serika</> : "系统"}</span> : null}
          {row.role === "assistant" ? <AssistantReply text={row.text} delivered={delivered} /> : <pre>{row.text}</pre>}
        </div>
      );
    case "tool":
      return (
        <details className={`row row-tool status-${row.status}`} open={["failed", "unknown", "timed_out", "dispatched"].includes(row.status) || (row.status === "requested" && !!(row.stdout || row.stderr))}>
          <summary><span className="dot" /><span className="tool-name">{toolDisplayName(row.toolName)}</span>
            {row.receipt ? <span className="tool-receipt"><code title={row.receipt.path}>{row.receipt.path}</code><span>{row.receipt.bytes} 字节</span></span> : null}
            <span className="tool-status">{toolStatusLabel(row.status)}</span><Icon name="chevron" size={14} /></summary>
          <div className="tool-body"><code>{row.toolName}</code>
          {row.detail ? <div className="tool-detail"><FailureInline text={row.detail} /></div> : null}
          {row.stdout ? <pre className="shell-stream stdout">{row.stdout}</pre> : null}
          {row.stderr ? <pre className="shell-stream stderr">{row.stderr}</pre> : null}
          {row.progressTruncated ? <span className="truncated">输出已截断</span> : null}
          </div>
        </details>
      );
    case "step":
      return <div className="row row-step">第 {row.step} 步</div>;
    case "result":
      return (
        <div className={`row row-result status-${row.status}`}>
          {completionLabel(row)}
          {row.status === "completed" && !row.completion ? <span className="result-boundary" title="本轮结束仅表示 Run 正常结束，工具效果以回执为准；不是任务验收。">执行结果见回执</span> : null}
          {row.detail ? <span className="tool-detail"> · <FailureInline text={row.detail} /></span> : null}
        </div>
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = { computer_observe: "观察应用", computer_action: "操作应用", read_file: "读取文件", write_file: "写入文件", edit_file: "编辑文件", shell_exec: "运行命令", web_fetch: "读取网页", web_search: "搜索网页", feed_read: "读取订阅", memory_add: "保存记忆", memory_update: "更新记忆", task_create: "创建提醒", task_reschedule: "调整提醒", task_cancel: "取消提醒", task_repeat_create: "重复提醒", task_repeat_cancel: "取消重复提醒", task_repeat_pause: "暂停重复提醒", task_repeat_resume: "恢复重复提醒", checkpoint_save: "保存进度" };
  return labels[name] ?? name;
}

function toolStatusLabel(status: ToolRowStatus): string {
  switch (status) {
    case "requested":
      return "调用中";
    case "ok":
      return "返回成功";
    case "incomplete":
      return "回执不完整";
    case "observed":
      return "观察已返回";
    case "dispatched":
      return "已派发 · 待核对";
    case "not_started":
      return "未执行";
    case "failed":
      return "失败";
    case "denied":
      return "已拒绝";
    case "unknown":
      return "结果未知 · 需人工核实";
    case "timed_out":
      return "Shell 超时";
    case "cancelled":
      return "已取消";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function Identity({ info }: { info: AppInfo }) {
  const [copied, setCopied] = useState(false);
  const copyThread = (): void => {
    void navigator.clipboard.writeText(info.threadId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const workspace = info.workspaceRoot ? baseName(info.workspaceRoot) : "无 workspace";
  return (
    <div className="identity" aria-label="当前会话配置">
      <span className="pill" title={`模型：${info.modelAlias}\n${info.modelId ?? ""}（配置值，不代表已联网验证）`}>
        {info.modelAlias}
      </span>
      <span className="pill" title={info.workspaceRoot ?? "未设置 workspace；文件、记忆、checkpoint、任务模块都不可用"}>
        {workspace}
      </span>
      <span
        className="pill"
        title={`主 Run ${info.totalTimeoutMs} ms（确认等待不计时）\nShell ${info.shellTimeoutMs} ms\n超过 30 秒的任务两条都要大于任务时长`}
      >
        {Math.round(info.totalTimeoutMs / 1000)}s / {Math.round(info.shellTimeoutMs / 1000)}s
      </span>
      <button
        className="pill mono"
        title={`Thread ${info.threadId}\nTranscript ${info.directory}\n点击复制 thread id`}
        onClick={copyThread}
      >
        {copied ? "已复制" : shortId(info.threadId)}
      </button>
      {info.temporaryThread || info.temporaryDirectory ? (
        <span
          className="pill warn"
          title={[
            info.temporaryThread ? "Thread ID 为本次临时生成；重启不会自动回到这段对话。" : null,
            info.temporaryDirectory ? "transcript 目录为本次临时生成；重启不会自动回到这里。" : null,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          临时
        </span>
      ) : info.identitySource ? (
        <span className="pill" title={info.identitySource === "saved" ? "已保存启动身份；重启会回到同一 Thread 和 transcript 目录。" : "本次使用环境变量显式覆盖；以相同覆盖配置重启可回到同一对话，不会改写默认身份。"}>
          {info.identitySource === "saved" ? "固定身份" : "显式身份"}
        </span>
      ) : null}
    </div>
  );
}

function HomeBody({ view }: { view: HomeView }) {
  if (view.sections.length === 0 && view.unparsed.length === 0) {
    return <div className="muted">正在读取…</div>;
  }
  const clock = reminderClock();
  return (
    <div className="home-body">
      {view.sections.map((section) => (
        <div className="home-section" key={section.title}>
          <div className="home-title">
            <span>{section.title === "本地任务" ? "提醒与定时结果" : section.title}</span>
            {section.summary ? <span className="home-summary">{section.summary}</span> : null}
          </div>
          {section.items.length > 0 ? (
            <ul className="home-items">
              {section.items.map((item, index) => {
                const shown = section.title === "本地任务" ? presentHomeTaskItem(item.text, clock) : { primary: item.text, detail: null };
                return (
                  <li key={index} className={item.kind}>
                    {shown.primary}
                    {shown.detail ? <small>{shown.detail}</small> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ))}
      {view.unparsed.length > 0 ? <pre className="home-text">{view.unparsed.join("\n")}</pre> : null}
    </div>
  );
}

export function App({ initialLayout }: { initialLayout?: DesktopLayout } = {}) {
  const layout = initialLayout ?? desktopLayout(window.location.search);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const [initialSettings, setInitialSettings] = useState<false | "modules" | "context">(false);
  const [initialSettingsError, setInitialSettingsError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, ConversationDraft>());
  const [appearance, setAppearance] = useState<"dark" | "light">(() => localStorage.getItem("serika:personal-appearance") === "dark" ? "dark" : "light");
  const toggleAppearance = () => setAppearance(value => {
    const next = value === "dark" ? "light" : "dark";
    localStorage.setItem("serika:personal-appearance", next);
    return next;
  });
  useEffect(() => window.runloom.onMessage(message => {
    if (message.type === "identity-changed") { setInitialSettings(message.reason ?? false); setInitialSettingsError(message.configurationError ?? null); setIdentityGeneration(value => value + 1); }
  }), []);
  // Reset evidence/previews on identity changes; drafts also recover from main-process storage.
  const page = <AssistantPage key={identityGeneration} drafts={drafts.current} layout={layout} initialSettings={initialSettings} initialSettingsError={initialSettingsError} appearance={appearance} onAppearance={toggleAppearance} />;
  return <div className={`serika-personal-shell personal-theme-${appearance}`}><DesktopWindowFrame title="Serika" isDesktop={true} isMacDesktop={document.documentElement.dataset.nativeWindowControls === "macos"}>{page}</DesktopWindowFrame></div>;
}

function AssistantPage({ drafts, layout, initialSettings = false, initialSettingsError = null, appearance, onAppearance }: { drafts: Map<string, ConversationDraft>; layout: DesktopLayout; initialSettings?: false | "modules" | "context"; initialSettingsError?: string | null; appearance: "dark" | "light"; onAppearance: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mobileDashboard, setMobileDashboard] = useState(!!initialSettings);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [chatFraction, setChatFraction] = useState(() => loadChatFraction(localStorage.getItem(PERSONAL_SPLIT_KEY)));
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarOpen(localStorage.getItem(PERSONAL_SIDEBAR_KEY)));
  const splitRoot = useRef<HTMLDivElement | null>(null);
  const compact = windowWidth < PERSONAL_COMPACT_BREAKPOINT;
  const dashboardOpen = compact ? mobileDashboard : sidebarOpen;
  const actualFraction = clampChatFraction(windowWidth, chatFraction);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const saveSplit = (value: number) => {
    const next = clampChatFraction(windowWidth, value);
    setChatFraction(next);
    try { localStorage.setItem(PERSONAL_SPLIT_KEY, String(next)); } catch { /* Layout remains usable without preference storage. */ }
  };
  const [conversationTitle, setConversationTitle] = useState("当前对话");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsRefresh, setThreadsRefresh] = useState(0);
  const [memoryFocus, setMemoryFocus] = useState<{ id: string | null; sequence: number }>({ id: null, sequence: 0 });
  const [taskResultFocus, setTaskResultFocus] = useState<{ taskId: string; workspaceRoot: string; sequence: number } | null>(null);
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [home, setHome] = useState("");
  const [output, setOutput] = useState("");
  const [storedHistory, setStoredHistory] = useState<{ rows: ConversationRow[]; runId: string | null }>({ rows: [], runId: null });
  const history = storedHistory.rows;
  const historyMessages = useRef<UIMessage[]>([]);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [live, setLive] = useState<LiveRun>(emptyLiveRun);
  const [lastResult, setLastResult] = useState<ConversationRow | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [canSteer, setCanSteer] = useState(false);
  useEffect(() => { if (approval) setMobileDashboard(false); }, [approval?.approvalId]);
  const [steers, setSteers] = useState<readonly AssistantSteerRecord[]>([]);
  const [uncertainSteer, setUncertainSteer] = useState<UncertainSteer | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const draftSave = useRef<Promise<void>>(Promise.resolve());
  const draftSaveSequence = useRef(0);
  const [reconnecting, setReconnecting] = useState(false);
  const steerReceipts = useRef<readonly AssistantSteerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [excludeFromMemory, setExcludeFromMemory] = useState(false);
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [records, setRecords] = useState<RecordsState>({ status: "loading" });
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [memoryDeferred, setMemoryDeferred] = useState(false);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const [automationRefresh, setAutomationRefresh] = useState(0);
  const [createTaskRequest, setCreateTaskRequest] = useState(0);
  const [taskDraft, setTaskDraft] = useState("");
  const [taskFocused, setTaskFocused] = useState(false);
  const [switchingThread, setSwitchingThread] = useState(false);
  const threadSwitchInFlight = useRef(false);
  const [pendingMemory, setPendingMemory] = useState<PendingMemoryStatus>({ count: 0, hasMore: false, loading: false, error: null, reviewing: false });
  const [recordDetail, setRecordDetail] = useState<RecordDetailState>({ status: "idle" });
  const [finalRecord, setFinalRecord] = useState<ExecutionRunRecord | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const decisionInFlight = useRef<string | null>(null);
  const latestPrimaryId = useRef<string | null>(null);
  const latestCompletedPrimaryId = useRef<string | null>(null);
  const historyRequest = useRef(0);
  const [detailsOpen, setDetailsOpen] = useState(!!initialSettings);
  const [detailTab, setDetailTab] = useState<"threads" | "tasks" | "reminders" | "home" | "records" | "memory" | "context" | "pomodoro" | "modules" | "persona">(initialSettings || "home");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const homeBuffer = useRef("");
  const shellBuffer = useRef(new ShellProgressBuffer());
  const conversationEnd = useRef<HTMLDivElement | null>(null);
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const inspectorScroll = useRef<HTMLDivElement | null>(null);
  const inspectorPositions = useRef(new Map<string, number>());
  const followConversation = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [unreadOutput, setUnreadOutput] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const selectedRecordId = useRef<string | null>(null);
  const recordListRequest = useRef(0);
  const recordDetailRequest = useRef(0);
  const recordRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceVisible = useRef(false);
  const [traceFocusTool, setTraceFocusTool] = useState<string | null>(null);
  traceVisible.current = detailsOpen && detailTab === "records";
  const taskRunStarted = useCallback((text: string) => { setSubmittedInput(text); followConversation.current = true; setDetailsOpen(false); setMobileDashboard(false); }, []);
  const workTasks = useWorkTasks(info?.workTasks === true, state.kind !== "idle", taskRefresh, taskRunStarted, taskSelectionKey(info), info ? draftScope(info) : null);
  const { composerTaskId: taskComposerId, setComposerTaskId: setTaskComposerId } = workTasks;
  const composerBinding = bindTaskComposer(taskComposerId, workTasks.task);
  const composingTask = composerBinding.kind === "task";
  const composerTask = composerBinding.kind === "task" ? composerBinding.task : null;
  const composerText = composingTask ? composerTask ? workTasks.instruction : "" : input;
  const inspectorKey = detailTab === "tasks" ? `tasks:${workTasks.task?.id ?? "none"}:${taskFocused}` : detailTab;
  useLayoutEffect(() => {
    if (detailsOpen && inspectorScroll.current) inspectorScroll.current.scrollTop = inspectorPositions.current.get(inspectorKey) ?? 0;
  }, [detailsOpen, inspectorKey]);

  const applySnapshot = useCallback((snapshot: UiSnapshot) => {
    setState(snapshot.state);
    setCanSteer(snapshot.canSteer);
    steerReceipts.current = snapshot.steers;
    setSteers(snapshot.steers);
    setApproval(snapshot.pendingApproval);
    setOutput(snapshot.recentOutput);
    shellBuffer.current.clear();
    for (const chunk of snapshot.shellProgress) shellBuffer.current.apply(chunk);
    const activePrimary = snapshot.state.kind === "running" && snapshot.state.phase === "primary";
    latestPrimaryId.current = snapshot.state.kind === "running" && snapshot.state.phase === "primary"
      ? snapshot.state.runId : snapshot.lastPrimaryResult?.runId ?? null;
    latestCompletedPrimaryId.current = !activePrimary && snapshot.lastPrimaryResult?.status === "completed"
      ? snapshot.lastPrimaryResult.runId : null;
    setLastResult(!activePrimary && snapshot.lastPrimaryResult ? resultRow(snapshot.lastPrimaryResult) : null);
    if (!activePrimary) {
      setLive(emptyLiveRun);
    } else {
      setLive({
        rows: overlayShellProgress(rowsFromToolActivity(snapshot.toolActivity, latestPrimaryId.current ?? undefined), shellBuffer.current),
        streaming: "",
      });
    }
  }, []);

  const reloadHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    const primaryId = latestPrimaryId.current;
    const completedId = latestCompletedPrimaryId.current;
    const [page, receipts, identity] = await Promise.all([window.runloom.historyPage(), window.runloom.listRuns().catch(() => null), window.runloom.info()]);
    if (request !== historyRequest.current || primaryId !== latestPrimaryId.current || completedId !== latestCompletedPrimaryId.current) return;
    if (page.threadId !== identity.threadId) return;
    const messages = page.messages;
    historyMessages.current = messages;
    setHistoryBefore(page.beforeId);
    // Only a reread made after this primary Run completed can supply its full
    // outcomes. Provider tool IDs are not unique across the whole Thread.
    const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
    setStoredHistory({ rows: completedId === null ? rows : overlayShellProgress(rows, shellBuffer.current), runId: completedId });
  }, []);

  const loadOlderHistory = async () => {
    if (!historyBefore || historyLoading) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    const area = conversationScroll.current, height = area?.scrollHeight ?? 0, top = area?.scrollTop ?? 0;
    try {
      const [page, identity, receipts] = await Promise.all([window.runloom.historyPage({ beforeId: historyBefore }), window.runloom.info(), window.runloom.listRuns().catch(() => null)]);
      if (request !== historyRequest.current || page.threadId !== identity.threadId) return;
      const messages = [...page.messages, ...historyMessages.current];
      historyMessages.current = messages; setHistoryBefore(page.beforeId);
      const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
      followConversation.current = false;
      setStoredHistory(current => ({ ...current, rows }));
      requestAnimationFrame(() => { if (area) area.scrollTop = top + area.scrollHeight - height; });
    } catch { setError("更早的对话读取失败；当前内容仍保留，可以重试"); }
    finally { setHistoryLoading(false); }
  };

  const loadFinalRun = useCallback(async (runId: string) => {
    const response = await window.runloom.getRun(runId);
    if (latestPrimaryId.current !== runId) return;
    if (!response.ok) { setError(`最终执行回执不可用：${response.message}`); return; }
    if (response.run === null) { setError("最终执行回执缺失，不能据此确认动作结果"); return; }
    setFinalRecord(response.run);
    steerReceipts.current = response.run.steers ?? [];
    setSteers(steerReceipts.current);
  }, []);

  const readRecord = useCallback(async (runId: string) => {
    const request = ++recordDetailRequest.current;
    const opened = await window.runloom.getRun(runId);
    if (request !== recordDetailRequest.current || selectedRecordId.current !== runId) return;
    if (!opened.ok) setRecordDetail({ status: "unavailable", runId, message: opened.message });
    else if (opened.run === null) setRecordDetail({ status: "missing", runId });
    else setRecordDetail({ status: "ready", run: opened.run });
  }, []);

  const loadRecords = useCallback(async (selectedRunId?: string) => {
    const request = ++recordListRequest.current;
    const listed = await window.runloom.listRuns();
    if (request !== recordListRequest.current) return;
    if (!listed.ok) {
      setRecords({ status: "unavailable", message: listed.message });
      return;
    }
    setRecords({ status: "ready", runs: listed.runs, ...(listed.modelUsage ? { modelUsage: listed.modelUsage } : {}) });
    if (selectedRunId !== undefined && selectedRecordId.current === selectedRunId) await readRecord(selectedRunId);
  }, [readRecord]);

  const openRecord = useCallback(async (runId: string, toolCallId?: string) => {
    selectedRecordId.current = runId;
    setTraceFocusTool(toolCallId ?? null);
    setRecordDetail({ status: "loading", runId });
    await readRecord(runId);
  }, [readRecord]);

  const refreshOpenTrace = useCallback(() => {
    if (!traceVisible.current || recordRefreshTimer.current !== null) return;
    recordRefreshTimer.current = setTimeout(() => {
      recordRefreshTimer.current = null;
      if (traceVisible.current) void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行追踪读取失败"));
    }, 250);
  }, [loadRecords]);

  useEffect(() => {
    let cancelled = false;
    let stop = (): void => undefined;
    const openNotificationResult = async () => {
      const route = await window.runloom.takeTaskResultOpen?.();
      if (!route || cancelled) return;
      setTaskResultFocus(previous => ({ ...route, sequence: (previous?.sequence ?? 0) + 1 }));
      setDetailTab("reminders"); setDetailsOpen(true); setMobileDashboard(true);
    };

    const onMessage = (message: MainToRenderer): void => {
      switch (message.type) {
        case "task-result-available":
          void openNotificationResult().catch(cause => { if (!cancelled) setError(String(cause)); });
          return;
        case "identity-changed":
          return; // The outer App remounts this view for the new controller.
        case "state":
          setState(message.state);
          setCanSteer(false);
          if (message.state.kind === "running" && message.state.runId === null && message.state.phase === "primary") {
            shellBuffer.current.clear();
            setLive(emptyLiveRun);
            setLastResult(null);
            setFinalRecord(null);
            setSteers([]);
            steerReceipts.current = [];
            latestPrimaryId.current = null;
            latestCompletedPrimaryId.current = null;
            historyRequest.current += 1;
          }
          if (message.state.kind === "running" && message.state.phase === "primary" && message.state.runId !== null) {
            latestPrimaryId.current = message.state.runId;
            const expectedRunId = message.state.runId;
            void window.runloom.snapshot().then(snapshot => {
              if (cancelled || latestPrimaryId.current !== expectedRunId || snapshot.state.kind !== "running" || snapshot.state.runId !== expectedRunId) return;
              setCanSteer(snapshot.canSteer);
            }).catch(() => {});
          }
          if (message.state.kind === "idle") {
            setMemoryRefresh(value => value + 1);
            setContextRefresh((value) => value + 1);
            setTaskRefresh((value) => value + 1);
            void reloadHistory().catch((cause: unknown) => setError(String(cause)));
            void loadRecords(selectedRecordId.current ?? undefined).catch((cause: unknown) => setError(String(cause)));
          }
          return;
        case "output":
          setOutput((previous) => (previous + message.text).slice(-OUTPUT_MAX_CHARS));
          return;
        case "home":
          if (message.reset) homeBuffer.current = "";
          homeBuffer.current += message.text;
          setHome(homeBuffer.current.trim());
          return;
        case "approval":
          setApproval(message.approval);
          refreshOpenTrace();
          return;
        case "approval-cleared":
          setApproval((current) => (current?.approvalId === message.approvalId ? null : current));
          return;
        case "steer": {
          const records = mergeSteerRecords(steerReceipts.current, message.steer, latestPrimaryId.current);
          if (records === steerReceipts.current) return;
          steerReceipts.current = records;
          setSteers(records);
          return;
        }
        case "event":
          if (message.event.type !== "message.delta" && message.event.type !== "usage.updated") refreshOpenTrace();
          if (message.phase !== "primary") return;
          if (latestPrimaryId.current !== null && message.event.runId !== latestPrimaryId.current) return;
          setLive((previous) => applyEvent(previous, message.event));
          return;
        case "result": {
          setContextRefresh((value) => value + 1);
          if (message.phase !== "primary") return;
          if (latestPrimaryId.current !== null && message.result.runId !== latestPrimaryId.current) return;
          setCanSteer(false);
          latestPrimaryId.current = message.result.runId;
          latestCompletedPrimaryId.current = message.result.status === "completed" ? message.result.runId : null;
          void loadFinalRun(message.result.runId).catch((cause: unknown) => setError(String(cause)));
          const rows = finishRun(emptyLiveRun, message.result);
          setLastResult(rows.find((row) => row.kind === "result") ?? null);
          setLive((previous) => ({ rows: finishRun(previous, message.result), streaming: "" }));
          return;
        }
        case "memory-references-changed":
          setContextRefresh(value => value + 1);
          return;
        case "shell-progress":
          if (message.phase !== "primary") return;
          if (message.runId !== latestPrimaryId.current) return;
          shellBuffer.current.apply(message.progress);
          setLive((previous) => applyShellProgress(previous, message.progress.toolCallId, shellBuffer.current));
          return;
        case "memory-updated":
          if (message.reason === "proposals") setMemoryDeferred(false);
          setMemoryRefresh((value) => value + 1);
          return;
        case "work-task-updated":
          setTaskRefresh((value) => value + 1);
          return;
        case "error":
          setError(message.message);
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    };

    void (async () => {
      try {
        stop = window.runloom.onMessage(onMessage);
        const nextInfo = await window.runloom.info();
        if (cancelled) return;
        setInfo(nextInfo);
        try {
          const saved = await window.runloom.loadConversationDraft(draftScope(nextInfo));
          if (cancelled) return;
          drafts.set(draftKey(nextInfo), saved.draft);
          setInput(saved.draft.text || (!saved.uncertainSteer?.taskId ? saved.uncertainSteer?.text : "") || "");
          setExcludeFromMemory(saved.draft.excludeFromMemory);
          setUncertainSteer(saved.uncertainSteer);
          setDraftReady(true);
        } catch {
          if (cancelled) return;
          const cached = drafts.get(draftKey(nextInfo));
          setInput(cached?.text ?? "");
          setDraftError("保存的草稿无法读取，未覆盖原文件。修复保存位置后重新加载；当前不会发送。");
        }
        if (nextInfo.runtimeRecovery) { setError(nextInfo.runtimeRecovery.message); return; }
        await openNotificationResult();
        const first = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(first);
        const second = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(second);
        if (second.lastPrimaryResult && !(second.state.kind === "running" && second.state.phase === "primary")) {
          await loadFinalRun(second.lastPrimaryResult.runId);
        }
        await reloadHistory();
        // History waits for receipt recovery; only now is the restart Steer state authoritative.
        const recovered = await window.runloom.snapshot();
        if (cancelled) return;
        steerReceipts.current = recovered.steers;
        setSteers(recovered.steers);
        setCanSteer(recovered.canSteer);
        await loadRecords();
        const homeResult = await window.runloom.home();
        if (!homeResult.ok && !cancelled) setError(commandError(homeResult));
      } catch (cause: unknown) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
      recordListRequest.current += 1;
      recordDetailRequest.current += 1;
      if (recordRefreshTimer.current !== null) clearTimeout(recordRefreshTimer.current);
      recordRefreshTimer.current = null;
      stop();
    };
  }, [applySnapshot, reloadHistory, loadRecords, loadFinalRun, drafts, refreshOpenTrace]);

  useEffect(() => {
    if (detailsOpen && detailTab === "records") void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行追踪读取失败"));
  }, [detailsOpen, detailTab, loadRecords]);

  useEffect(() => {
    if (!info || !draftReady) return;
    const key = draftKey(info);
    if (input.length) drafts.set(key, { text: input, excludeFromMemory });
    else drafts.delete(key);
    const sequence = ++draftSaveSequence.current;
    setDraftSaving(true);
    const save = window.runloom.saveConversationDraft(draftScope(info), { text: input, excludeFromMemory });
    draftSave.current = save;
    void save.then(() => {
      if (draftSaveSequence.current === sequence) { setDraftError(null); setDraftSaving(false); }
    }).catch(() => {
      if (draftSaveSequence.current === sequence) { setDraftError("草稿未保存，当前内容仍在输入框；修复保存位置后重试，不会发送。"); setDraftSaving(false); }
    });
  }, [info, input, excludeFromMemory, drafts, draftReady]);

  useEffect(() => {
    if (!detailsOpen && !mobileDashboard) return;
    const close = (event: KeyboardEvent) => {
      // Let an inner disclosure/dialog consume Escape first.
      if (searchOpen) return;
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
        setDetailsOpen(false); setMobileDashboard(false); event.preventDefault();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detailsOpen, mobileDashboard, searchOpen]);

  useEffect(() => {
    if (!info) return;
    let active = true;
    const idle = state.kind === "idle";
    if (idle) setThreadsLoading(true);
    void window.runloom.listThreads().then(threads => {
      if (!active) return;
      // The header title stays human while a confirmation is open; the list itself refreshes only when idle.
      setConversationTitle(humanFacingTitle(threads.find(thread => thread.threadId === info.threadId)?.title, "当前对话"));
      if (idle) { setThreads(threads); setThreadsError(null); }
    }).catch(() => { if (active && idle) setThreadsError("对话列表读取失败"); })
      .finally(() => { if (active && idle) setThreadsLoading(false); });
    return () => { active = false; };
  }, [info, state.kind, threadsRefresh]);

  useLayoutEffect(() => {
    const area = conversationScroll.current;
    if (!area) return;
    if (followConversation.current) { area.scrollTop = area.scrollHeight; setUnreadOutput(false); setAwayFromLatest(false); }
    else setUnreadOutput(true);
  }, [history, live, lastResult, submittedInput, approval, detailsOpen, composerText]);

  useLayoutEffect(() => {
    const area = conversationScroll.current;
    if (!area) return;
    // Window/composer resizing must keep the latest message anchored, but must
    // not pull someone away from the history they deliberately scrolled to.
    const observer = new ResizeObserver(() => {
      if (followConversation.current && area.clientHeight > 0) area.scrollTop = area.scrollHeight;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(open => !open);
        return;
      }
      if (searchOpen) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (detailsOpen || mobileDashboard) { setDetailsOpen(false); setMobileDashboard(false); }
        else void window.runloom.hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen, mobileDashboard, searchOpen]);

  const decide = useCallback(async (decision: "allow" | "deny") => {
    if (approval === null || decisionInFlight.current === approval.approvalId) return;
    const id = approval.approvalId;
    decisionInFlight.current = id;
    setDecidingId(id);
    setError(null);
    try {
      const { accepted } = await window.runloom.confirm({ approvalId: id, decision });
      if (!accepted) setError("确认已失效，本次点击未执行。请重新核对当前调用，不会自动批准新调用。");
    } catch { setError("确认结果未收到。请查看当前状态，不会自动重试。"); }
    finally {
      if (decisionInFlight.current === id) decisionInFlight.current = null;
      setDecidingId(current => current === id ? null : current);
    }
  }, [approval]);

  const submit = useCallback(async () => {
    const line = composerText.trim();
    if ((!composingTask && line.length === 0) || sendInFlight.current || threadSwitchInFlight.current) return;
    setError(null);
    if (!info || !draftReady || draftError || info.runtimeRecovery) { setError("请先恢复连接和草稿保存，再发送。"); return; }
    if (uncertainSteer !== null) { setError("上次补充的接收结果未知，请先核对；不会重复发送。"); return; }
    if (canSteerComposer(state, canSteer)) {
      if (line.length === 0) return;
      if (line.startsWith("/")) { setError("运行中只接收补充要求，命令请等本轮结束再执行。草稿已保留。"); return; }
      const request = { expectedRunId: state.runId, id: crypto.randomUUID(), text: line, scope: draftScope(info), ...(composingTask && composerTask ? { taskId: composerTask.id } : {}) };
      sendInFlight.current = true;
      setSending(true);
      let invokedSteer = false;
      try {
        await draftSave.current;
        if (composingTask) await workTasks.flushDrafts();
        invokedSteer = true;
        const response = await window.runloom.steer(request);
        if (!response.ok) {
          if (response.reason === "failed") {
            setUncertainSteer({ id: request.id, runId: request.expectedRunId, text: line, ...(request.taskId ? { taskId: request.taskId } : {}) });
            setError("补充要求的持久接收凭证尚未确认。请核对状态；草稿保留，不会自动重发。");
          } else if (response.reason === "storage") {
            setError("草稿存储不可用，补充未发送。请恢复保存位置后重试。");
          } else if (response.reason === "unresolved") {
            const saved = await window.runloom.loadConversationDraft(draftScope(info));
            setUncertainSteer(saved.uncertainSteer);
            setError("上一条补充仍待核对，不会发送新补充。");
          } else setError(steerFailureLabel(response.reason));
          return;
        }
        const records = mergeSteerRecords(steerReceipts.current, response.steer, latestPrimaryId.current);
        steerReceipts.current = records;
        setSteers(records);
        const receipt = await window.runloom.acknowledgeSteer(draftScope(info), request.id);
        if (!receipt) throw new Error("接收凭证尚未确认");
        if (receipt.status !== "not_applied") {
          if (request.taskId) workTasks.clearInstruction(request.taskId, line);
          else setInput(current => current.trim() === line ? "" : current);
        }
      } catch {
        if (!invokedSteer) { setDraftError("草稿未保存，补充未发送。请先重试保存。"); return; }
        // An IPC failure is not proof that the controller did not accept it.
        setUncertainSteer({ id: request.id, runId: request.expectedRunId, text: line, ...(request.taskId ? { taskId: request.taskId } : {}) });
        setError("补充要求的接收结果未收到。请核对状态；草稿保留，不会自动重发。");
      } finally { sendInFlight.current = false; setSending(false); }
      return;
    }
    if (approval !== null) {
      setError("请先处理上方确认");
      return;
    }
    if (!canSubmitComposer(state, composingTask ? "task" : line.startsWith("/") ? "command" : "chat")) { setError("当前忙，输入未排队"); return; }
    sendInFlight.current = true;
    setSending(true);
    try {
      await draftSave.current;
      if (composingTask) {
        if (!composerTask || !taskActions(composerTask).run || workTasks.locked) {
          setError("当前任务不能开始下一轮，请先核对任务状态。"); return;
        }
        await workTasks.run(line);
        return;
      }
      if (line.startsWith("/")) {
        const response = await window.runloom.command(line);
        if (!response.ok) { setError(commandError(response)); return; }
        setInput("");
        return;
      }
      const response = await window.runloom.run(line, excludeFromMemory ? { memoryConsolidation: "exclude" } : undefined);
      if (!response.ok) {
        setError(response.reason === "empty" ? "输入为空" : `当前忙（${response.reason}），未排队`);
        return;
      }
      setSubmittedInput(line);
      setInput("");
      setExcludeFromMemory(false);
    } catch { setError("未收到启动结果。请核对当前状态，不会自动重发。"); }
    finally { sendInFlight.current = false; setSending(false); }
  }, [composerText, composingTask, composerTask, workTasks, approval, state, excludeFromMemory, canSteer, uncertainSteer, info, draftReady, draftError]);

  const busy = state.kind !== "idle";
  const steering = canSteerComposer(state, canSteer);
  const composerReady = draftReady && draftError === null && (!composingTask || (workTasks.draftReady && !workTasks.draftError)) && !info?.runtimeRecovery && uncertainSteer === null && (steering || canSubmitComposer(state, composingTask ? "task" : composerText.trim().startsWith("/") ? "command" : "chat"));
  const running = state.kind === "running";
  const activePrimary = running && state.phase === "primary";
  const recheckSteer = async () => {
    if (!uncertainSteer || !info) return;
    try {
      const receipt = await window.runloom.acknowledgeSteer(draftScope(info), uncertainSteer.id);
      if (!receipt) { setError("尚未查到这次补充的接收凭证，不能据此断言未发送；不会自动重发。"); return; }
      const records = mergeSteerRecords(steerReceipts.current, receipt, latestPrimaryId.current);
      steerReceipts.current = records;
      setSteers(records);
      setUncertainSteer(null);
      if (receipt.status !== "not_applied") {
        if (uncertainSteer.taskId) {
          workTasks.clearInstruction(uncertainSteer.taskId, uncertainSteer.text);
        } else setInput(current => current.trim() === uncertainSteer.text ? "" : current);
      }
      setError(receipt.status === "not_applied" && uncertainSteer.taskId
        ? "这次工作任务补充未应用，原文与任务目标已保留；核对任务后可显式继续，不会自动续做。"
        : null);
    } catch { setError("核对失败，草稿保持锁定，不会重发。"); }
  };
  const releaseSteer = async () => {
    if (!info || !uncertainSteer || busy) return;
    try {
      await draftSave.current;
      if (uncertainSteer.taskId) await workTasks.flushDrafts();
      if (!await window.runloom.releaseSteer(draftScope(info), uncertainSteer.id)) { setError("待核对记录已变化，请重新加载。"); return; }
      if (uncertainSteer.taskId) {
        setTaskComposerId(uncertainSteer.taskId);
        workTasks.select(uncertainSteer.taskId);
        if (workTasks.task?.id === uncertainSteer.taskId && !workTasks.instruction) workTasks.setInstruction(uncertainSteer.text);
      } else { setTaskComposerId(null); setInput(current => current || uncertainSteer.text); }
      setUncertainSteer(null);
      setError(uncertainSteer.taskId
        ? "原任务补充的接收结果仍未确认，原文保留在该任务；不会转成普通对话或自动重发。"
        : "原补充的接收结果仍未确认。草稿不会自动发送；如再次发送，将开启新一轮。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "未解除待核对状态，草稿仍锁定；不会重发。"); }
  };
  const retryConnection = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try { await window.runloom.retryConnection(); }
    catch { setError("连接恢复失败。请修正配置后重试；不会重放之前的任务。"); }
    finally { setReconnecting(false); }
  };
  const visibleRows: ConversationRow[] = [...history, ...(activePrimary ? [
    ...(submittedInput ? [{ kind: "text" as const, key: "submitted-input", role: "user" as const, text: submittedInput, committed: false }] : []),
    ...live.rows,
  ] : [])];
  const rows = [...(!activePrimary && finalRecord ? overlayExecutionReceipts(visibleRows, finalRecord.tools, { reuseHistory: canReuseReceiptHistory(finalRecord, storedHistory.runId), runId: finalRecord.runId }) : visibleRows),
    ...(!activePrimary && lastResult ? [lastResult] : [])];
  const delivered = deliveredReplyKeys(rows);
  const homeView = parseHome(home);
  const unknownRuns = records.status === "ready" ? unreconciledRuns(records.runs, workTasks.tasks) : [];
  const reviewTask = workTasks.tasks.find(task => task.status === "needs_review");
  const rememberSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try { localStorage.setItem(PERSONAL_SIDEBAR_KEY, open ? "open" : "collapsed"); } catch { /* The in-memory choice still applies for this window. */ }
  };
  const openDetails = (tab: typeof detailTab) => {
    setDetailTab(tab); setDetailsOpen(true); setMobileDashboard(true);
    if (!compact) rememberSidebar(true);
  };
  const toggleSidebar = () => {
    if (compact) { setMobileDashboard(value => !value); return; }
    rememberSidebar(!sidebarOpen);
  };
  const openCreateTask = () => {
    if (!info?.workTasks || busy || sending || switchingThread) return;
    setTaskDraft(input.trim());
    setTaskFocused(true);
    openDetails("tasks");
    setCreateTaskRequest(value => value + 1);
  };
  const openMemory = (id: string | null = null) => { setMemoryFocus(current => ({ id, sequence: current.sequence + 1 })); openDetails("memory"); };
  const openTask = () => { setTaskFocused(true); openDetails("tasks"); };
  const composeTask = () => {
    if (!workTasks.task || !taskActions(workTasks.task).run || workTasks.locked) return;
    setTaskComposerId(workTasks.task.id); setDetailsOpen(false); setMobileDashboard(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const attention = attentionKind({ approval: approval !== null, unknownRuns: unknownRuns.length || (reviewTask ? 1 : 0), pendingMemory: pendingMemory.count, idle: !busy, memoryDeferred });
  const status = headerStatus(state, attention);
  const stageLabel = info?.runtimeRecovery ? "连接已停止" : info ? status.label : error ? "连接失败" : "正在连接";
  const pendingLabel = loadedCountLabel(pendingMemory.count, pendingMemory.hasMore);
  const refreshMemory = useCallback(() => setMemoryRefresh(value => value + 1), []);
  const threadDrafts = new Map(threads.flatMap(thread => {
    const draft = drafts.get(draftKey({ workspaceRoot: info?.workspaceRoot ?? null, directory: thread.transcriptDirectory, threadId: thread.threadId }));
    return draft?.text ? [[thread.threadId, draft.text] as const] : [];
  }));
  const pageTitle = !detailsOpen ? conversationTitle : ({ threads: "全部对话", tasks: "工作任务", reminders: "提醒", home: "工作区", records: "执行记录", memory: "记忆", context: "上下文与压缩", pomodoro: "番茄钟", modules: "模块能力", persona: "serika" })[detailTab];
  const pageDescription = ({ threads: "继续之前的对话，或开始一段新对话。", tasks: "把需要执行和验收的事放在这里；普通聊天不用创建任务。", reminders: "查看已经设好的提醒，以及刚刚触发的结果。", home: "查看保存的进度、订阅和当前配置。提醒列表在「提醒」。", records: "核对每次执行的工具结果，区分完成、失败和未知效果。", memory: "已保存的记忆和待审核的候选，都在这里。", context: "长对话由系统自动管理，通常不需要你操作。", pomodoro: "专注计时，直接操作，不必发消息。", modules: "决定助手可以使用哪些能力。", persona: "你的个人助手。" })[detailTab];
  const newConversation = async () => {
    if (busy || sending || threadSwitchInFlight.current || !info) return;
    threadSwitchInFlight.current = true;
    setSwitchingThread(true);
    try {
      await draftSave.current;
      await workTasks.flushDrafts();
      if (input.length) drafts.set(draftKey(info), { text: input, excludeFromMemory });
      await window.runloom.createThread({ preserveDraft: input.length > 0 });
      setDetailsOpen(false); setMobileDashboard(false);
    }
    catch { setError("新对话未打开，请查看当前会话；不会自动重试。"); }
    finally { threadSwitchInFlight.current = false; setSwitchingThread(false); }
  };
  const selectConversation = async (id: string) => {
    if (busy || sending || threadSwitchInFlight.current || !info) return;
    if (id === info.threadId) { setDetailsOpen(false); setMobileDashboard(false); return; }
    threadSwitchInFlight.current = true;
    setSwitchingThread(true);
    try { await draftSave.current; await workTasks.flushDrafts(); await window.runloom.selectThread(id); }
    catch { setError("对话切换未确认，请核对当前会话；不会自动重试。"); }
    finally { threadSwitchInFlight.current = false; setSwitchingThread(false); }
  };
  const prepareInput = (text: string) => { setInput(text); inputRef.current?.focus(); };
  const scrollToLatest = () => {
    followConversation.current = true;
    if (conversationScroll.current) conversationScroll.current.scrollTop = conversationScroll.current.scrollHeight;
    setUnreadOutput(false);
  };

  return (
    <div ref={splitRoot} className={`app personal-layout${compact ? " is-compact" : ""}${compact && mobileDashboard ? " show-dashboard" : ""}${!compact && !sidebarOpen ? " sidebar-collapsed" : ""}`} style={{ "--chat-fraction": actualFraction } as CSSProperties}>
      <div className="main-shell">
        <header className="header">
          <span className="personal-name"><SerikaPersona size={52} /></span>
          <span className="personal-conversation-title">{conversationTitle}</span>
          <span className={`run-state ${status.tone}`} role="status"><span className={`state-dot ${status.tone}`} />{stageLabel}</span>
          <span className="spacer" />
          <button className="personal-mobile-today" type="button" onClick={() => setMobileDashboard(true)}>今天<Icon name="chevron" size={14} /></button>
          {info?.workTasks ? <button className="personal-create-task" type="button" disabled={busy || sending || switchingThread} onClick={openCreateTask}><Icon name="new-chat" size={15} />创建任务</button> : null}
          {!dashboardOpen ? <button className="personal-sidebar-toggle" type="button" aria-label="搜索" title="搜索" onClick={() => setSearchOpen(true)}><Search size={16} /></button> : null}
          <button className="personal-sidebar-toggle" type="button" aria-pressed={dashboardOpen} aria-label={dashboardOpen ? "收起侧栏" : "展开侧栏"} title={dashboardOpen ? "收起侧栏，对话占满窗口" : "展开侧栏"} onClick={toggleSidebar}><Icon name="panel" size={16} /></button>
          <button className="icon-button personal-new-chat" type="button" aria-label="新对话" title="新对话；保留当前草稿" disabled={busy || sending || switchingThread || !info} onClick={() => void newConversation()}><Icon name="new-chat" /></button>
        </header>
        {isMockModel(info?.modelAlias) || info?.entryMode === "test" ? <div className="model-mode-notice" role="status">{info?.entryMode === "test" ? "隔离测试 · 会话和记忆不属于日用工作区。" : ""}{isMockModel(info?.modelAlias) ? "模拟模型，不会调用真实模型。" : ""}</div> : null}
        {info ? <SavedTaskNotice key={`${info.configPath}:${info.workspaceRoot}`} enabled={!!info.workspaceRoot} refreshSequence={automationRefresh} onOpen={taskId => {
          const workspaceRoot = info.workspaceRoot;
          if (!workspaceRoot) return;
          setTaskResultFocus(previous => ({ taskId, workspaceRoot, sequence: (previous?.sequence ?? 0) + 1 }));
          openDetails("reminders");
        }} /> : null}
        {info && attention === "none" ? <MemoryConsolidationNotice key={`${info.workspaceRoot}:${info.threadId}`} enabled={info.memory.enabled} busy={busy} quiet={true} running={state.kind === "running" && state.phase === "consolidation"} refreshToken={memoryRefresh} onOpen={() => openMemory()} /> : null}
        <div className="attention-region" hidden={attention === "none" && !pendingMemory.error}>
          {attention === "unknown" ? <div className="review-notice" role="status"><Icon name="shield" size={16} /><span>有执行效果还没核对，不会自动重做。</span><button className="ghost" onClick={() => { if (reviewTask) { workTasks.select(reviewTask.id); openTask(); } else { openDetails("records"); const run = unknownRuns[0]; if (run) void openRecord(run.runId); } }}>{reviewTask ? "核对工作任务" : "查看回执"}<Icon name="chevron" size={14} /></button></div> : null}
          {info ? <PendingMemory memory={info.memory} controllerIdle={!busy} refreshToken={memoryRefresh} visible={attention === "memory"} onStatus={setPendingMemory} onReviewed={refreshMemory} onLater={() => setMemoryDeferred(true)} onOpenCandidate={id => openMemory(id)} /> : null}
          {pendingMemory.error && attention === "none" ? <div className="attention-summary"><span>记忆候选暂不可用，不能据此判断没有待审项。</span><button className="ghost" onClick={() => openDetails("memory")}>查看原因</button></div> : null}
          {attention === "approval" && (unknownRuns.length > 0 || pendingLabel) ? <div className="attention-summary">{unknownRuns.length > 0 ? <button className="ghost" onClick={() => openDetails("records")}>另有执行效果待核对</button> : null}{pendingLabel ? <button className="ghost" onClick={() => openDetails("memory")}>待审记忆 {pendingLabel}</button> : null}</div> : null}
          {attention === "unknown" && pendingLabel ? <div className="attention-summary"><button className="ghost" onClick={() => openDetails("memory")}>还有待审记忆 {pendingLabel}</button></div> : null}
        </div>
        <div className="workbench">
          <main className="workspace-pane">
            <section className="conversation" aria-label="对话">
              <CurrentTask view={workTasks} onOpen={openTask} onCompose={composeTask} compact={busy} />
              <div className="rows" ref={conversationScroll} onScroll={() => {
                const area = conversationScroll.current;
                if (!area) return;
                followConversation.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
                setAwayFromLatest(!followConversation.current);
                if (followConversation.current) setUnreadOutput(false);
              }}>
                {rows.length === 0 && !live.streaming && !workTasks.task ? <div className="conversation-empty">
                  <SerikaPersona size={72} />
                  <h1>你想完成什么？</h1>
                </div> : null}
                <div className="conversation-thread">
                  {historyBefore ? <button className="secondary" disabled={historyLoading} onClick={() => void loadOlderHistory()}>{historyLoading ? "正在读取…" : "查看更早的对话"}</button> : null}
                  {layout === "zcode" ? <ZCodeConversation rows={rows} workspaceRoot={info?.workspaceRoot ?? undefined} running={activePrimary} streaming={live.streaming} waitingForApproval={approval !== null} onTrace={(runId, toolCallId) => { openDetails("records"); void openRecord(runId, toolCallId).catch(() => setError("执行追踪读取失败")); }} /> : rows.map(row => <Row key={row.key} row={row} delivered={delivered.has(row.key)} />)}
                  {info?.memory.enabled ? <MemoryReferences hideEmpty={layout === "zcode"} refreshToken={contextRefresh} runId={state.kind === "running" && state.phase === "primary" ? state.runId : latestPrimaryId.current} starting={state.kind === "running" && state.phase === "primary" && state.runId === null} /> : null}
                  {layout !== "zcode" && activePrimary && live.streaming ? <div className="row row-text role-assistant live">
                    <span className="role"><SerikaMark size={20} /> Serika <span className="streaming-label">正在回复</span></span>
                    <MessageContent text={live.streaming} />
                  </div> : null}
                  {layout !== "zcode" && activePrimary && !live.streaming ? <div className="working-indicator" role="status"><span /><span /><span /><small>{approval ? "等待你的确认" : "正在处理"}</small></div> : null}
                  <SteerStatus records={steers} onRestore={text => {
                    setTaskComposerId(null);
                    setInput(current => current ? `${current}\n${text}` : text);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }} />
                  <div ref={conversationEnd} />
                </div>
              </div>
              {layout === "zcode" && awayFromLatest ? <ZCodeBackToBottom unread={unreadOutput} onClick={() => { scrollToLatest(); setAwayFromLatest(false); }} /> : layout !== "zcode" && unreadOutput ? <button className="latest-button" onClick={scrollToLatest}><Icon name="arrow" size={14} style={{ transform: "rotate(180deg)" }} />最新消息</button> : null}
              {showOutput ? <div className="system-output"><div><Icon name="terminal" size={16} /><span>系统输出 · 仅供诊断</span><button className="icon-button" aria-label="关闭系统输出" onClick={() => setShowOutput(false)}><Icon name="close" size={16} /></button></div><pre className="output">{output || "暂无输出"}</pre></div> : null}
            </section>
          </main>
        </div>
        <div className="action-dock">
          {info?.runtimeRecovery ? <div className="error error-banner" role="alert"><span>助手连接已停止：{info.runtimeRecovery.message}。修正配置后重新连接，不会重做旧任务。</span><button type="button" className="ghost" disabled={reconnecting} onClick={() => void retryConnection()}>{reconnecting ? "正在连接…" : "重新连接"}</button></div> : null}
          {draftError ? <div className="error error-banner" role="alert"><span>{draftError}</span><button type="button" className="ghost" onClick={() => {
            if (!info) return;
            if (!draftReady) { window.location.reload(); return; }
            const save = window.runloom.saveConversationDraft(draftScope(info), { text: input, excludeFromMemory });
            draftSave.current = save;
            void save.then(() => setDraftError(null)).catch(() => setDraftError("草稿仍未保存，内容保留，请检查保存位置。"));
          }}>重试保存</button></div> : null}
          {error ? info ? <ErrorBanner message={error} onClose={() => setError(null)} /> : <ErrorBanner message={error} /> : null}
          {workTasks.draftError ? <div className="error error-banner" role="alert"><span>{workTasks.draftError}</span><button className="ghost" type="button" onClick={workTasks.retryDrafts}>重试任务草稿保存</button></div> : null}
          {uncertainSteer ? <div className="attention-summary" role="status"><span>补充要求的接收凭证待核对，草稿不会重发。{uncertainSteer.taskId ? "原补充属于工作任务；核对前不会作为普通对话发送。" : ""}</span><details><summary>查看这次补充</summary><pre>{uncertainSteer.text}</pre></details><button type="button" className="ghost" onClick={() => void recheckSteer()}>核对接收状态</button>{!busy ? <button type="button" className="ghost" onClick={() => void releaseSteer()}>保留草稿，结束本次核对</button> : null}</div> : null}
          {approval ? <ApprovalCard approval={approval} deciding={decidingId === approval.approvalId} onDecision={decision => void decide(decision)} /> : null}
          <ZCodePromptEditor inputRef={inputRef} value={composerText} aria-label={composingTask ? "本轮任务指令" : "消息输入"}
              notice={steering ? "补充将进入当前这轮规划；已执行操作不会撤销，工具仍需重新确认。本条不整理为记忆。" : composingTask ? !composerTask ? "任务已切换，原草稿仍保留。重新选择任务，或切回普通对话。" : !busy && !taskActions(composerTask).run ? "本轮已结束，请从任务卡查看结果，或切回普通对话。" : null : null}
              topContent={<>{workTasks.task || composingTask ? <div className="composer-target" role="group" aria-label="发送方式"><button className={!composingTask ? "selected" : ""} type="button" aria-pressed={!composingTask} onClick={() => setTaskComposerId(null)}>普通对话</button><button className={composingTask ? "selected" : ""} type="button" aria-pressed={composingTask} disabled={!workTasks.task || (!taskActions(workTasks.task).run && !composingTask)} onClick={composeTask}>补充当前任务</button>{composingTask ? <span>{composerTask ? humanFacingTitle(composerTask.goal, "当前任务") : "当前任务暂不可用"}</span> : null}</div> : null}{excludeFromMemory && !composingTask ? <div className="zcode-draft-setting"><Icon name="memory" size={13} /><span>本条不整理为记忆</span><button type="button" className="icon-button" aria-label="恢复本条记忆整理" onClick={() => setExcludeFromMemory(false)}><Icon name="close" size={12} /></button></div> : null}</>}
              disabled={sending || switchingThread || info === null || !draftReady || !!info.runtimeRecovery || (composingTask && !composerTask)}
              placeholder={steering ? "补充这轮的要求…" : composingTask && !composerTask ? "重新选择任务，或切回对话…" : approval ? "先确认上方操作，再发送…" : !composerReady ? "可以先写，结束后再发送…" : composingTask ? "补充本轮要求…" : "和 Serika 聊天"}
              onChange={event => { if (!composingTask) setInput(event.target.value); else if (composerTask) workTasks.setInstruction(event.target.value); }}
              onKeyDown={event => {
                if (composerReady && shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
                  event.preventDefault(); followConversation.current = true; void submit();
                }
              }}
              leadingActions={<ZCodePromptOptions>
                {info?.memory.enabled && !composingTask ? <label className="memory-exclusion" title="这条消息不进入现在或以后的记忆候选整理；不会删除对话记录，也不关闭已有记忆引用。"><input type="checkbox" checked={excludeFromMemory} disabled={sending} onChange={event => setExcludeFromMemory(event.target.checked)} />本条不整理为记忆</label> : null}
                {info?.workTasks && !composingTask ? <button type="button" className="ghost" disabled={busy || workTasks.acting || sending} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setTaskDraft(input.trim()); setTaskFocused(true); openDetails("tasks"); setCreateTaskRequest(value => value + 1); }}><Icon name="activity" size={15} />{input.trim() ? "作为工作任务…" : "创建工作任务"}</button> : null}
                {info && info.commands.length > 0 && !composingTask ? <><div className="command-caption">命令 · 填入后发送，不会立即执行</div><div className="zcode-command-list">{info.commands.map(name => <button type="button" key={name} disabled={busy} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); prepareInput(`/${name} `); }}>/{name}</button>)}</div></> : null}
                <button type="button" className="ghost" aria-pressed={showOutput} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setShowOutput(value => !value); }}><Icon name="terminal" size={15} />{showOutput ? "隐藏系统输出" : "查看系统输出"}</button>
              </ZCodePromptOptions>}
              submitControl={<>
                {!composingTask && input ? <span className="hint" role="status">{draftError ? "草稿未保存" : draftSaving ? "保存草稿…" : "草稿已保存"}</span> : null}
                {composingTask ? <span className="hint" role="status">{workTasks.draftError ? "任务草稿未保存" : workTasks.draftSaving ? "保存任务草稿…" : workTasks.draftReady ? "任务草稿已保存" : "正在恢复任务草稿…"}</span> : null}
                <span className="zcode-model-name" title="当前配置的模型；不代表本轮已联网验证">{info?.modelId ?? info?.modelAlias ?? "连接中"}</span>
                {busy ? <Button type="button" variant="outline" size="icon" className="zcode-stop-button" aria-label={state.kind === "compacting" ? "停止上下文压缩" : state.kind === "running" && state.phase === "consolidation" ? "停止记忆整理" : "停止本轮"} title={state.kind === "compacting" ? "停止上下文压缩" : state.kind === "running" && state.phase === "consolidation" ? "停止记忆整理" : "停止本轮；已执行的操作不会撤回"} onClick={() => void window.runloom.cancel().catch(() => setError("取消结果未收到，请核对当前状态。"))}><Square size={12} /></Button> : null}
                {!busy || steering ? <Button type="button" size={steering || composingTask ? "default" : "icon"} className={`send-button${steering || composingTask ? " task-send" : ""}`}
                  aria-label={steering ? "补充要求" : composingTask ? composerTask?.status === "ready" ? "开始任务" : "继续此任务" : "发送消息"}
                  title={steering ? "补充当前 Run 的要求，不启动新一轮" : composingTask ? "显式开启任务的新一轮；工具仍需确认" : "发送（Enter）· 换行（Shift + Enter）"}
                  disabled={!composerReady || sending || switchingThread || !info || (steering ? !composerText.trim() : composingTask ? workTasks.locked || !composerTask || !taskActions(composerTask).run : !input.trim())}
                  onClick={() => { followConversation.current = true; void submit(); }}>
                  {steering ? "补充要求" : composingTask ? composerTask?.status === "ready" ? "开始任务" : "继续此任务" : <ArrowUp size={18} />}
                </Button> : null}
              </>}
          />
        </div>
      </div>
      <div className="personal-divider" role="separator" aria-label="调整对话栏宽度" aria-orientation="vertical"
        aria-valuemin={Math.round(clampChatFraction(windowWidth, 0.3) * 100)} aria-valuemax={Math.round(clampChatFraction(windowWidth, 0.7) * 100)} aria-valuenow={Math.round(actualFraction * 100)} tabIndex={compact || !sidebarOpen ? -1 : 0}
        onDoubleClick={() => saveSplit(0.5)}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); saveSplit(actualFraction + (event.key === "ArrowLeft" ? -0.02 : 0.02)); } if (event.key === "Home") { event.preventDefault(); saveSplit(0.5); } }}
        onPointerDown={event => { if (!compact) event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = splitRoot.current?.getBoundingClientRect(); if (bounds) saveSplit((event.clientX - bounds.left) / (bounds.width - 6)); } }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <section className="personal-dashboard" aria-label="今天与个人助手">
        <header className="personal-dashboard-header">
          <button className="personal-mobile-back" type="button" onClick={() => setMobileDashboard(false)}><Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} />对话</button>
          <nav className="personal-segments" aria-label="个人助手页面">
            {(["Today", "任务", "记忆", "serika"] as const).map(tab => <button type="button" key={tab}
              aria-current={(detailsOpen ? dashboardTabForDetail(detailTab) : "Today") === tab ? "page" : undefined}
              onClick={() => { if (tab === "Today") { setDetailsOpen(false); setMobileDashboard(true); } else if (tab === "任务") { setTaskFocused(false); openDetails("tasks"); } else if (tab === "记忆") openMemory(); else openDetails("persona"); }}>{tab}{tab === "记忆" && pendingLabel ? <span className="personal-segment-count">{pendingLabel}</span> : null}</button>)}
          </nav>
          <div className="personal-dashboard-actions">
            <button type="button" className="personal-circle" aria-label="搜索" title="搜索" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Search size={18} /></button>
            <button type="button" className="personal-circle" aria-label="设置" title="设置" aria-current={detailsOpen && dashboardTabForDetail(detailTab) === "设置" ? "page" : undefined} onClick={() => openDetails("modules")}><Settings2 size={18} /></button>
          </div>
        </header>
        <div className="personal-today-scroll" hidden={detailsOpen}>
          <TodayPanel info={info} tasks={workTasks.tasks} tasksLoading={workTasks.loading} tasksError={workTasks.error}
            pendingMemory={pendingMemory.count} pendingMemoryError={pendingMemory.error}
            onTasks={() => { setTaskFocused(false); openDetails("tasks"); }} onMemory={() => openMemory()}
            onChat={() => { setMobileDashboard(false); requestAnimationFrame(() => inputRef.current?.focus()); }}
            onPomodoro={() => openDetails("pomodoro")} onAutomation={() => openDetails("reminders")} />
        </div>
        {detailsOpen && ["modules", "records", "context", "home"].includes(detailTab) ? <div className="personal-settings-toolbar">
          <nav className="personal-settings-nav" aria-label="助手设置">
            {([["modules", "模块"], ["records", "执行记录"], ["context", "上下文"], ["home", "工作区"]] as const).map(([tab, label]) => <button type="button" key={tab} aria-current={detailTab === tab ? "page" : undefined} onClick={() => openDetails(tab)}>{label}</button>)}
          </nav>
          <button type="button" className="personal-circle" aria-label={appearance === "dark" ? "切换为浅色外观" : "切换为深色外观"} title="切换外观" onClick={onAppearance}>{appearance === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
        </div> : null}
          <section className="inspector" hidden={!detailsOpen} aria-label={pageTitle}>
            <div className="inspector-header"><div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><button className="ghost" title="回到今天 · Escape" onClick={() => { setDetailsOpen(false); setMobileDashboard(false); }}><Icon name="close" size={16} />回到今天</button></div>
            <div className="inspector-pane" ref={inspectorScroll} onScroll={() => { if (inspectorScroll.current) inspectorPositions.current.set(inspectorKey, inspectorScroll.current.scrollTop); }}>
              {detailTab === "threads" && info ? <ThreadsPanel info={info} drafts={threadDrafts} busy={busy || switchingThread} onSelect={selectConversation} onCreate={newConversation} onChanged={() => setThreadsRefresh(value => value + 1)} /> : null}
              <div hidden={detailTab !== "tasks"}>
                <WorkTasksPanel view={workTasks} createRequest={createTaskRequest} initialGoal={taskDraft} focused={taskFocused} onCompose={composeTask} onCreated={() => { setDetailsOpen(false); setMobileDashboard(false); setTaskFocused(true); }} onRun={runId => { openDetails("records"); void openRecord(runId).catch(() => setError("执行回执读取失败")); }} />
              </div>
              <div hidden={detailTab !== "reminders"}>
                <RemindersPanel enabled={!!info?.workspaceRoot} busy={busy} identity={`${info?.configPath ?? ""}:${info?.workspaceRoot ?? ""}`} refreshSequence={automationRefresh} onSettings={() => openDetails("home")} />
                <TaskInbox key={`${info?.configPath}:${info?.workspaceRoot}`} enabled={!!info?.workspaceRoot} canAcknowledge={info?.modules?.some(m => m.id === "task" && m.enabled) === true} busy={busy} onResultsRead={() => setAutomationRefresh(value => value + 1)} focus={taskResultFocus?.workspaceRoot === info?.workspaceRoot ? taskResultFocus : null} />
              </div>
              <div hidden={detailTab !== "home"}>
                {info ? <DailySetup info={info} busy={busy} automationRefresh={automationRefresh} onContext={() => openDetails("context")} onHistory={() => openDetails("threads")} onReminders={() => openDetails("reminders")} onRun={runId => { openDetails("records"); void openRecord(runId).catch(() => setError("执行结果读取失败")); }} /> : null}
                <RssPanel key={info?.workspaceRoot ?? "no-workspace"} showInbox={false} enabled={!!info?.workspaceRoot && info.modules?.some(m => m.id === "task" && m.enabled) === true} busy={busy} />
                <section className="card home">
                  <div className="card-head"><span>工作区概览</span><button className="ghost" disabled={busy} onClick={() => void window.runloom.home().then(response => {
                    if (!response.ok) setError(commandError(response));
                  }).catch(() => setError("概览读取失败"))}>刷新</button></div>
                  <p className="hint">项目进度来自保存的 checkpoint。提醒和刚触发的结果在「提醒」。这里不检查 Git 或文件现状。</p><HomeBody view={homeView} />
                </section>
                {info ? <section className="card session-card"><div className="card-head"><SerikaPersona size={44} /><span>会话与配置</span></div><Identity info={info} />
                  <dl className="session-facts">
                    <dt>模型</dt><dd>{info.modelId ?? info.modelAlias}<small>配置值，不代表已联网验证</small></dd>
                    <dt>工作区</dt><dd>{info.workspaceRoot ?? "未配置"}</dd>
                    <dt>记录目录</dt><dd>{info.directory}</dd>
                    <dt>本机控制</dt><dd>{info.computer.enabled ? info.computer.allowedBundleIds.join("、") : "未启用"}{info.computer.enabled ? <small>仅显示配置，驱动尚未验证</small> : null}</dd>
                  </dl>
                </section> : null}
              </div>
              <div hidden={detailTab !== "records"}>
                {recordDetail.status === "ready" && recordDetail.run.workTaskId && workTasks.tasks.some(task => task.id === recordDetail.run.workTaskId) ? <button className="ghost" onClick={() => { if (recordDetail.run.workTaskId) workTasks.select(recordDetail.run.workTaskId); openTask(); }}>回到工作任务</button> : null}
                <RecordsPanel records={records} detail={recordDetail} focusTool={traceFocusTool}
                onBack={() => { selectedRecordId.current = null; recordDetailRequest.current += 1; setTraceFocusTool(null); setRecordDetail({ status: "idle" }); }}
                onRefresh={() => void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行记录读取失败"))}
                onOpen={runId => void openRecord(runId).catch(() => setError("执行回执读取失败"))} /></div>
              <div hidden={detailTab !== "memory"}>{info ? <MemoryConsolidationPanel key={`${info.workspaceRoot}:${info.threadId}`} info={info} busy={busy} refreshToken={memoryRefresh} onSettings={() => openDetails("home")} /> : null}{info ? <MemoryPanel key={`${info.workspaceRoot}:${info.threadId}`} memory={info.memory} temporaryThread={info.temporaryThread}
                controllerIdle={!busy} refreshToken={memoryRefresh} focusRequest={memoryFocus} pendingCount={pendingMemory.count} pendingHasMore={pendingMemory.hasMore} /> : null}</div>
              <div hidden={detailTab !== "context"}>{info ? <ContextPanel controllerIdle={!busy} refreshToken={contextRefresh} initialError={initialSettings === "context" ? initialSettingsError : null}
                hasCompaction={info.hasCompaction} /> : null}</div>
              <div hidden={detailTab !== "modules"}>{info ? <CapabilitiesPanel info={info} busy={busy} initialError={initialSettingsError} /> : null}</div>
              <div hidden={detailTab !== "pomodoro"}>{info ? <PomodoroPanel enabled={info.commands.includes("pomodoro")} busy={busy} output={output} /> : null}</div>
              <div hidden={detailTab !== "persona"}><PersonaPanel /></div>
            </div>
          </section>
      </section>
      {searchOpen ? <SearchOverlay drafts={threadDrafts} busy={busy || switchingThread} onClose={() => setSearchOpen(false)} onOpenThread={id => { setSearchOpen(false); void selectConversation(id); }} /> : null}
    </div>
  );
}
