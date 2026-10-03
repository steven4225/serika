import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppInfo,
  CommandResponse,
  MainToRenderer,
  PendingApproval,
  UiSnapshot,
  UiState,
  ExecutionRunRecord,
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
  rowsFromToolActivity,
  type ConversationRow,
  type LiveRun,
  type ToolRowStatus,
} from "./conversation.js";
import { baseName, parseHome, shortId, type HomeView } from "./home.js";
import { MemoryPanel } from "./memory.js";
import { MemoryReferences } from "./memory-references.js";
import { ContextPanel } from "./context.js";
import { RecordsPanel, type RecordDetailState, type RecordsState } from "./records.js";
import { ApprovalCard } from "./approval.js";
import { shouldSubmitComposer } from "../../shared/composer.js";
import { Icon, RunloomMark, type IconName } from "./icons.js";
import { MessageContent } from "./markdown.js";
import { CapabilitiesPanel } from "./capabilities.js";
import { PomodoroPanel } from "./pomodoro.js";
import { PendingMemory, type PendingMemoryStatus } from "./pending-memory.js";
import { AssistantReply } from "./delivery.js";
import { attentionKind, headerStatus, loadedCountLabel, deliveredReplyKeys, isMockModel } from "./attention.js";
import { CurrentTask, useWorkTasks, WorkTasksPanel } from "./work-tasks.js";
import { RssPanel } from "./rss.js";
import { unreconciledRuns, taskSelectionKey } from "./work-task-data.js";

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

function Row({ row, delivered = false }: { row: ConversationRow; delivered?: boolean }) {
  switch (row.kind) {
    case "text":
      return (
        <div className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
          {row.role !== "user" ? <span className="role">{row.role === "assistant" ? <><RunloomMark size={20} /> Runloom</> : "系统"}</span> : null}
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
          {row.detail ? <div className="tool-detail">{row.detail}</div> : null}
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
          {row.status === "completed" ? "本轮结束" : row.status === "timed_out" ? "本轮超时" : row.status === "cancelled" ? "本轮已取消 · 已执行动作不会撤回" : `本轮 ${row.status}`}
          {row.status === "completed" ? <span className="result-boundary" title="本轮结束仅表示 Run 正常结束，工具效果以回执为准；不是任务验收。">执行结果见回执</span> : null}
          {row.detail ? <span className="tool-detail"> · {row.detail}</span> : null}
        </div>
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = { computer_observe: "观察应用", computer_action: "操作应用", read_file: "读取文件", write_file: "写入文件", edit_file: "编辑文件", shell_exec: "运行命令", web_fetch: "读取网页", web_search: "搜索网页", feed_read: "读取订阅", memory_add: "保存记忆", memory_update: "更新记忆", task_create: "创建提醒", task_reschedule: "调整提醒", checkpoint_save: "保存进度" };
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
  return (
    <div className="home-body">
      {view.sections.map((section) => (
        <div className="home-section" key={section.title}>
          <div className="home-title">
            <span>{section.title}</span>
            {section.summary ? <span className="home-summary">{section.summary}</span> : null}
          </div>
          {section.items.length > 0 ? (
            <ul className="home-items">
              {section.items.map((item, index) => (
                <li key={index} className={item.kind}>
                  {item.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      {view.unparsed.length > 0 ? <pre className="home-text">{view.unparsed.join("\n")}</pre> : null}
    </div>
  );
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [home, setHome] = useState("");
  const [output, setOutput] = useState("");
  const [storedHistory, setStoredHistory] = useState<{ rows: ConversationRow[]; runId: string | null }>({ rows: [], runId: null });
  const history = storedHistory.rows;
  const [live, setLive] = useState<LiveRun>(emptyLiveRun);
  const [lastResult, setLastResult] = useState<ConversationRow | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [records, setRecords] = useState<RecordsState>({ status: "loading" });
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const [createTaskRequest, setCreateTaskRequest] = useState(0);
  const [pendingMemory, setPendingMemory] = useState<PendingMemoryStatus>({ count: 0, hasMore: false, loading: false, error: null, reviewing: false });
  const [recordDetail, setRecordDetail] = useState<RecordDetailState>({ status: "idle" });
  const [finalRecord, setFinalRecord] = useState<ExecutionRunRecord | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const decisionInFlight = useRef<string | null>(null);
  const latestPrimaryId = useRef<string | null>(null);
  const latestCompletedPrimaryId = useRef<string | null>(null);
  const historyRequest = useRef(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"home" | "records" | "memory" | "context" | "pomodoro" | "modules">("home");
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const homeBuffer = useRef("");
  const shellBuffer = useRef(new ShellProgressBuffer());
  const conversationEnd = useRef<HTMLDivElement | null>(null);
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const followConversation = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [unreadOutput, setUnreadOutput] = useState(false);
  const selectedRecordId = useRef<string | null>(null);
  const taskRunStarted = useCallback((text: string) => { setSubmittedInput(text); followConversation.current = true; setDetailsOpen(false); }, []);
  const workTasks = useWorkTasks(info?.workTasks === true, state.kind !== "idle", taskRefresh, taskRunStarted, taskSelectionKey(info));

  const applySnapshot = useCallback((snapshot: UiSnapshot) => {
    setState(snapshot.state);
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
        rows: overlayShellProgress(rowsFromToolActivity(snapshot.toolActivity), shellBuffer.current),
        streaming: "",
      });
    }
  }, []);

  const reloadHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    const primaryId = latestPrimaryId.current;
    const completedId = latestCompletedPrimaryId.current;
    const messages = await window.runloom.history();
    if (request !== historyRequest.current || primaryId !== latestPrimaryId.current || completedId !== latestCompletedPrimaryId.current) return;
    // Only a reread made after this primary Run completed can supply its full
    // outcomes. Provider tool IDs are not unique across the whole Thread.
    const rows = rowsFromHistory(messages);
    setStoredHistory({ rows: completedId === null ? rows : overlayShellProgress(rows, shellBuffer.current), runId: completedId });
  }, []);

  const loadFinalRun = useCallback(async (runId: string) => {
    const response = await window.runloom.getRun(runId);
    if (latestPrimaryId.current !== runId) return;
    if (!response.ok) { setError(`最终执行回执不可用：${response.message}`); return; }
    if (response.run === null) { setError("最终执行回执缺失，不能据此确认动作结果"); return; }
    setFinalRecord(response.run);
  }, []);

  const loadRecords = useCallback(async (selectedRunId?: string) => {
    const listed = await window.runloom.listRuns();
    if (!listed.ok) {
      setRecords({ status: "unavailable", message: listed.message });
      return;
    }
    setRecords({ status: "ready", runs: listed.runs });
    if (selectedRunId === undefined) return;
    const opened = await window.runloom.getRun(selectedRunId);
    if (!opened.ok) {
      setRecordDetail({ status: "unavailable", runId: selectedRunId, message: opened.message });
      return;
    }
    if (opened.run === null) {
      setRecordDetail({ status: "missing", runId: selectedRunId });
      return;
    }
    setRecordDetail({ status: "ready", run: opened.run });
  }, []);

  const openRecord = useCallback(async (runId: string) => {
    selectedRecordId.current = runId;
    setRecordDetail({ status: "loading", runId });
    const opened = await window.runloom.getRun(runId);
    if (!opened.ok) {
      setRecordDetail({ status: "unavailable", runId, message: opened.message });
      return;
    }
    if (opened.run === null) {
      setRecordDetail({ status: "missing", runId });
      return;
    }
    setRecordDetail({ status: "ready", run: opened.run });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stop = (): void => undefined;

    const onMessage = (message: MainToRenderer): void => {
      switch (message.type) {
        case "state":
          setState(message.state);
          if (message.state.kind === "running" && message.state.runId === null && message.state.phase === "primary") {
            shellBuffer.current.clear();
            setLive(emptyLiveRun);
            setLastResult(null);
            setFinalRecord(null);
            latestPrimaryId.current = null;
            latestCompletedPrimaryId.current = null;
            historyRequest.current += 1;
          }
          if (message.state.kind === "running" && message.state.phase === "primary" && message.state.runId !== null) latestPrimaryId.current = message.state.runId;
          if (message.state.kind === "idle") {
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
          return;
        case "approval-cleared":
          setApproval((current) => (current?.approvalId === message.approvalId ? null : current));
          return;
        case "event":
          if (message.phase !== "primary") return;
          setLive((previous) => applyEvent(previous, message.event));
          return;
        case "result": {
          setContextRefresh((value) => value + 1);
          if (message.phase !== "primary") return;
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
          shellBuffer.current.apply(message.progress);
          setLive((previous) => applyShellProgress(previous, message.progress.toolCallId, shellBuffer.current));
          return;
        case "memory-updated":
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
        await loadRecords();
        const homeResult = await window.runloom.home();
        if (!homeResult.ok && !cancelled) setError(commandError(homeResult));
      } catch (cause: unknown) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [applySnapshot, reloadHistory, loadRecords, loadFinalRun]);

  useEffect(() => {
    const area = conversationScroll.current;
    if (!area) return;
    if (followConversation.current) { area.scrollTop = area.scrollHeight; setUnreadOutput(false); }
    else setUnreadOutput(true);
  }, [history, live, lastResult]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing) {
        if (detailsOpen) setDetailsOpen(false); else void window.runloom.hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen]);

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
    const line = input.trim();
    if (line.length === 0 || sendInFlight.current) return;
    setError(null);
    if (approval !== null) {
      setError("请先处理上方确认");
      return;
    }
    if (state.kind !== "idle") { setError("当前忙，输入未排队"); return; }
    sendInFlight.current = true;
    setSending(true);
    try {
      if (line.startsWith("/")) {
        const response = await window.runloom.command(line);
        if (!response.ok) { setError(commandError(response)); return; }
        setInput("");
        return;
      }
      const response = await window.runloom.run(line);
      if (!response.ok) {
        setError(response.reason === "empty" ? "输入为空" : `当前忙（${response.reason}），未排队`);
        return;
      }
      setSubmittedInput(line);
      setInput("");
    } catch { setError("未收到启动结果。请核对当前状态，不会自动重发。"); }
    finally { sendInFlight.current = false; setSending(false); }
  }, [input, approval, state]);

  const busy = state.kind !== "idle";
  const running = state.kind === "running";
  const activePrimary = running && state.phase === "primary";
  const visibleRows: ConversationRow[] = [...history, ...(activePrimary ? [
    ...(submittedInput ? [{ kind: "text" as const, key: "submitted-input", role: "user" as const, text: submittedInput, committed: false }] : []),
    ...live.rows,
  ] : [])];
  const rows = [...(!activePrimary && finalRecord ? overlayExecutionReceipts(visibleRows, finalRecord.tools, { reuseHistory: canReuseReceiptHistory(finalRecord, storedHistory.runId) }) : visibleRows),
    ...(!activePrimary && lastResult ? [lastResult] : [])];
  const delivered = deliveredReplyKeys(rows);
  const homeView = parseHome(home);
  const unknownRuns = records.status === "ready" ? unreconciledRuns(records.runs, workTasks.tasks) : [];
  const reviewTask = workTasks.tasks.find(task => task.status === "needs_review");
  const openDetails = (tab: typeof detailTab) => { setDetailTab(tab); setDetailsOpen(true); };

  const attention = attentionKind({ approval: approval !== null, unknownRuns: unknownRuns.length || (reviewTask ? 1 : 0), pendingMemory: pendingMemory.count, idle: !busy });
  const status = headerStatus(state, attention);
  const stageLabel = info ? status.label : error ? "连接失败" : "正在连接";
  const pendingLabel = loadedCountLabel(pendingMemory.count, pendingMemory.hasMore);
  const refreshMemory = useCallback(() => setMemoryRefresh(value => value + 1), []);
  const pageTitle = !detailsOpen ? "对话" : ({ home: "工作区", records: "执行记录", memory: "记忆", context: "上下文与压缩", pomodoro: "番茄钟", modules: "模块能力" })[detailTab];
  const pageDescription = ({ home: "查看保存的进度、本地任务和当前配置。", records: "核对每次执行的工具结果，区分完成、失败和未知效果。", memory: "查看当前正式记忆，或审核当前对话的候选记录。", context: "查看压缩记录和本次准备结果；需要时手动压缩。", pomodoro: "专注计时，直接操作，不必发消息。", modules: "了解助手支持什么，以及当前启用了什么。" })[detailTab];
  const prepareInput = (text: string) => { setInput(text); inputRef.current?.focus(); };
  const scrollToLatest = () => {
    followConversation.current = true;
    if (conversationScroll.current) conversationScroll.current.scrollTop = conversationScroll.current.scrollHeight;
    setUnreadOutput(false);
  };

  return (
    <div className="app">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand"><RunloomMark /><span>Runloom</span></div>
        <div className="sidebar-nav-scroll">
        <nav className="primary-nav" aria-label="对话">
          <button className={!detailsOpen ? "selected" : ""} onClick={() => setDetailsOpen(false)} title="当前对话" aria-current={!detailsOpen ? "page" : undefined}>
            <Icon name="chat" /><span>对话</span>
          </button>
        </nav>
        <div className="sidebar-section">查阅</div>
        <nav className="primary-nav" aria-label="查阅">
          {([["home", "工作区", "home"], ["records", "执行记录", "activity"], ["memory", "记忆审核", "memory"]] as const).map(([tab, label, icon]) =>
            <button key={tab} className={detailsOpen && detailTab === tab ? "selected" : ""} title={label} aria-current={detailsOpen && detailTab === tab ? "page" : undefined} onClick={() => openDetails(tab)}>
              <Icon name={icon as IconName} /><span>{label}</span>{tab === "records" && unknownRuns.length ? <span className="nav-count" aria-label={`${unknownRuns.length} 条已加载执行尚待核对`}>{unknownRuns.length}</span> : tab === "memory" && pendingLabel ? <span className="nav-count" title={pendingMemory.hasMore ? "待审候选数量至少为此数" : "当前 Thread 待审候选"} aria-label={`${pendingLabel} 条待审记忆`}>{pendingLabel}</span> : null}
            </button>)}
        </nav>
        <div className="sidebar-section">工具</div>
        <nav className="primary-nav" aria-label="工具"><button className={detailsOpen && detailTab === "pomodoro" ? "selected" : ""} aria-current={detailsOpen && detailTab === "pomodoro" ? "page" : undefined} title="番茄钟" onClick={() => openDetails("pomodoro")}><Icon name="timer" /><span>番茄钟</span></button></nav>
        </div>
        <div className="sidebar-section maintenance-label">维护</div>
        <nav className="primary-nav" aria-label="维护">
          <button className={detailsOpen && detailTab === "modules" ? "selected" : ""} aria-current={detailsOpen && detailTab === "modules" ? "page" : undefined} title="模块能力" onClick={() => openDetails("modules")}><Icon name="modules" /><span>模块能力</span></button>
          <button className={detailsOpen && detailTab === "context" ? "selected" : ""} aria-current={detailsOpen && detailTab === "context" ? "page" : undefined} title="上下文与压缩" onClick={() => openDetails("context")}><Icon name="context" /><span>上下文与压缩</span></button>
        </nav>
        <button className="workspace-switch" onClick={() => openDetails("home")} title={info?.workspaceRoot ?? "尚未配置工作区"}>
          <span className="workspace-avatar">{info?.workspaceRoot ? baseName(info.workspaceRoot).slice(0, 1).toUpperCase() : "R"}</span>
          <span className="workspace-copy"><strong>{info?.workspaceRoot ? baseName(info.workspaceRoot) : "当前会话"}</strong><small>{info?.workspaceRoot ? "本地工作区" : "未配置工作区"}</small></span>
          <Icon name="chevron" size={14} />
        </button>
      </aside>
      <div className="main-shell">
        <header className="header">
          <span className={`run-state ${status.tone}`} role="status"><span className={`state-dot ${status.tone}`} />{stageLabel}</span>
          <span className="spacer" />
          {busy ? <button className="cancel-button" onClick={() => void window.runloom.cancel().catch(() => setError("取消结果未收到，请核对当前状态。"))}><Icon name="stop" size={14} />停止</button> : null}
        </header>
        {isMockModel(info?.modelAlias) ? <div className="model-mode-notice" role="status">当前使用模拟模型，只用于界面测试。日用任务请配置真实模型并重启；不会自动切换。</div> : null}
        <div className="attention-region" hidden={(attention === "none" && !pendingMemory.error) || (attention === "memory" && detailsOpen)}>
          {attention === "approval" && approval ? <ApprovalCard approval={approval} deciding={decidingId === approval.approvalId} onDecision={decision => void decide(decision)} /> : null}
          {attention === "unknown" ? <div className="review-notice" role="status"><Icon name="shield" size={16} /><span>有执行效果还没核对，不会自动重做。</span><button className="ghost" onClick={() => { if (reviewTask) { workTasks.select(reviewTask.id); openDetails("home"); } else { openDetails("records"); const run = unknownRuns[0]; if (run) void openRecord(run.runId); } }}>{reviewTask ? "核对工作任务" : "查看回执"}<Icon name="chevron" size={14} /></button></div> : null}
          {info ? <PendingMemory memory={info.memory} controllerIdle={!busy} refreshToken={memoryRefresh} visible={attention === "memory" && !detailsOpen} onStatus={setPendingMemory} onReviewed={refreshMemory} /> : null}
          {pendingMemory.error && attention === "none" ? <div className="attention-summary"><span>记忆候选暂不可用，不能据此判断没有待审项。</span><button className="ghost" onClick={() => openDetails("memory")}>查看原因</button></div> : null}
          {attention === "approval" && (unknownRuns.length > 0 || pendingLabel) ? <div className="attention-summary">{unknownRuns.length > 0 ? <button className="ghost" onClick={() => openDetails("records")}>另有执行效果待核对</button> : null}{pendingLabel ? <button className="ghost" onClick={() => openDetails("memory")}>待审记忆 {pendingLabel}</button> : null}</div> : null}
          {attention === "unknown" && pendingLabel ? <div className="attention-summary"><button className="ghost" onClick={() => openDetails("memory")}>还有待审记忆 {pendingLabel}</button></div> : null}
        </div>
        <div className="workbench">
          <main className="workspace-pane" hidden={detailsOpen}>
            <section className="conversation" aria-label="对话">
              <CurrentTask view={workTasks} onOpen={() => openDetails("home")} />
              <div className="rows" ref={conversationScroll} onScroll={() => {
                const area = conversationScroll.current;
                if (!area) return;
                followConversation.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
                if (followConversation.current) setUnreadOutput(false);
              }}>
                {rows.length === 0 && !live.streaming ? <div className="conversation-empty">
                  <h1>你想完成什么？</h1>
                </div> : null}
                <div className="conversation-thread">
                  {rows.map(row => <Row key={row.key} row={row} delivered={delivered.has(row.key)} />)}
                  {info?.memory.enabled ? <MemoryReferences refreshToken={contextRefresh} runId={state.kind === "running" && state.phase === "primary" ? state.runId : latestPrimaryId.current} starting={state.kind === "running" && state.phase === "primary" && state.runId === null} /> : null}
                  {activePrimary && live.streaming ? <div className="row row-text role-assistant live">
                    <span className="role"><RunloomMark size={20} /> Runloom <span className="streaming-label">正在回复</span></span>
                    <MessageContent text={live.streaming} />
                  </div> : null}
                  {activePrimary && !live.streaming ? <div className="working-indicator" role="status"><span /><span /><span /><small>{approval ? "等待你的确认" : "正在处理"}</small></div> : null}
                  <div ref={conversationEnd} />
                </div>
              </div>
              {unreadOutput ? <button className="latest-button" onClick={scrollToLatest}><Icon name="arrow" size={14} style={{ transform: "rotate(180deg)" }} />最新消息</button> : null}
              {showOutput ? <div className="system-output"><div><Icon name="terminal" size={16} /><span>系统输出 · 仅供诊断</span><button className="icon-button" aria-label="关闭系统输出" onClick={() => setShowOutput(false)}><Icon name="close" size={16} /></button></div><pre className="output">{output || "暂无输出"}</pre></div> : null}
            </section>
          </main>
          <section className="inspector" hidden={!detailsOpen} aria-label={pageTitle}>
            <div className="inspector-header"><div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><button className="ghost" onClick={() => setDetailsOpen(false)}><Icon name="chat" size={16} />回到对话</button></div>
            <div className="inspector-pane">
              <div hidden={detailTab !== "home"}>
                <WorkTasksPanel view={workTasks} createRequest={createTaskRequest} onRun={runId => { openDetails("records"); void openRecord(runId).catch(() => setError("执行回执读取失败")); }} />
                <RssPanel enabled={!!info?.workspaceRoot && info.modules?.some(m => m.id === "task" && m.enabled) === true} busy={busy} />
                <section className="card home">
                  <div className="card-head"><span>工作区概览</span><button className="ghost" disabled={busy} onClick={() => void window.runloom.home().then(response => {
                    if (!response.ok) setError(commandError(response));
                  }).catch(() => setError("概览读取失败"))}>刷新</button></div>
                  <p className="hint">项目进度来自保存的 checkpoint；本地任务来自任务存储。这里不检查 Git 或文件现状。</p><HomeBody view={homeView} />
                </section>
                {info ? <section className="card session-card"><div className="card-head">会话与配置</div><Identity info={info} />
                  <dl className="session-facts">
                    <dt>模型</dt><dd>{info.modelId ?? info.modelAlias}<small>配置值，不代表已联网验证</small></dd>
                    <dt>工作区</dt><dd>{info.workspaceRoot ?? "未配置"}</dd>
                    <dt>记录目录</dt><dd>{info.directory}</dd>
                    <dt>本机控制</dt><dd>{info.computer.enabled ? info.computer.allowedBundleIds.join("、") : "未启用"}{info.computer.enabled ? <small>仅显示配置，驱动尚未验证</small> : null}</dd>
                  </dl>
                </section> : null}
              </div>
              <div hidden={detailTab !== "records"}>
                {recordDetail.status === "ready" && recordDetail.run.workTaskId && workTasks.tasks.some(task => task.id === recordDetail.run.workTaskId) ? <button className="ghost" onClick={() => { if (recordDetail.run.workTaskId) workTasks.select(recordDetail.run.workTaskId); openDetails("home"); }}>回到工作任务</button> : null}
                <RecordsPanel records={records} detail={recordDetail}
                onRefresh={() => void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行记录读取失败"))}
                onOpen={runId => void openRecord(runId).catch(() => setError("执行回执读取失败"))} /></div>
              <div hidden={detailTab !== "memory"}>{info ? <MemoryPanel memory={info.memory} temporaryThread={info.temporaryThread}
                controllerIdle={!busy} refreshToken={memoryRefresh} /> : null}</div>
              <div hidden={detailTab !== "context"}>{info ? <ContextPanel controllerIdle={!busy} refreshToken={contextRefresh}
                hasCompaction={info.hasCompaction} /> : null}</div>
              <div hidden={detailTab !== "modules"}>{info ? <CapabilitiesPanel info={info} /> : null}</div>
              <div hidden={detailTab !== "pomodoro"}>{info ? <PomodoroPanel enabled={info.commands.includes("pomodoro")} busy={busy} output={output} /> : null}</div>
            </div>
          </section>
        </div>
        <div className="action-dock">
          {error ? <div className="error error-banner" role="alert"><span>{error}</span>{info ? <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><Icon name="close" size={16} /></button> : null}</div> : null}
          <footer className="composer" hidden={detailsOpen}>
            <textarea ref={inputRef} aria-label="消息输入" rows={3} value={input}
              disabled={sending || info === null}
              placeholder={approval ? "可先写下一条；发送前请确认上方操作…" : busy ? "可先写下一条，结束后再发送…" : "描述你想完成的事…"}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (!busy && shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
                  event.preventDefault(); followConversation.current = true; void submit();
                }
              }} />
            <div className="composer-controls">
              {info?.workTasks ? <button className="ghost" disabled={busy || workTasks.acting} onClick={() => { openDetails("home"); setCreateTaskRequest(value => value + 1); }}>创建工作任务</button> : null}
              {info && info.commands.length > 0 ? <details className="commands-menu"><summary>／<span>命令</span></summary><div className="commands">
                <div className="command-caption">填入命令后发送，不会立即执行</div>
                {info.commands.map(name => <button key={name} className="chip" disabled={busy} onClick={() => prepareInput(`/${name} `)}>/{name}</button>)}
              </div></details> : null}
              <span className="spacer" />
              <button className="icon-button" aria-label={showOutput ? "隐藏系统输出" : "查看系统输出"} title="系统输出" aria-pressed={showOutput} onClick={() => setShowOutput(value => !value)}><Icon name="terminal" size={17} /></button>
              <button className="send-button" aria-label="发送消息" title="发送 · Enter" disabled={busy || sending || !input.trim() || !info} onClick={() => { followConversation.current = true; void submit(); }}><Icon name="arrow" size={19} /></button>
            </div>
          </footer>
          <div className="composer-hint" hidden={detailsOpen}><span>Enter 发送<span className="shortcut-divider">·</span>Shift + Enter 换行</span></div>
        </div>
      </div>
    </div>
  );
}
