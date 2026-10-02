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
  resultRow,
  rowsFromHistory,
  rowsFromToolActivity,
  type ConversationRow,
  type LiveRun,
  type ToolRowStatus,
} from "./conversation.js";
import { baseName, parseHome, shortId, type HomeView } from "./home.js";
import { MemoryPanel } from "./memory.js";
import { ContextPanel } from "./context.js";
import { RecordsPanel, type RecordDetailState, type RecordsState } from "./records.js";
import { ApprovalCard } from "./approval.js";
import { shouldSubmitComposer } from "../../shared/composer.js";

const OUTPUT_MAX_CHARS = 64 * 1024;

function stateLabel(state: UiState): string {
  switch (state.kind) {
    case "idle":
      return "空闲";
    case "running":
      if (state.runId === null) return "启动中";
      return state.phase === "consolidation" ? "整理记忆" : "运行中";
    case "compacting":
      return "压缩上下文";
    case "resuming":
      return "核对 Git";
    case "command":
      return state.name === "memory-review" ? "审核记忆" : `/${state.name}`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

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

function Row({ row }: { row: ConversationRow }) {
  switch (row.kind) {
    case "text":
      return (
        <div className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
          <span className="role">{row.role === "user" ? "你" : row.role === "assistant" ? "助手" : "系统"}</span>
          <pre>{row.text}</pre>
        </div>
      );
    case "tool":
      return (
        <div className={`row row-tool status-${row.status}`}>
          <span className="dot" />
          <code>{row.toolName}</code>
          <span className="tool-status">{toolStatusLabel(row.status)}</span>
          {row.detail ? <span className="tool-detail">{row.detail}</span> : null}
          {row.stdout ? <pre className="shell-stream stdout">{row.stdout}</pre> : null}
          {row.stderr ? <pre className="shell-stream stderr">{row.stderr}</pre> : null}
          {row.progressTruncated ? <span className="truncated">输出已截断</span> : null}
        </div>
      );
    case "step":
      return <div className="row row-step">step {row.step}</div>;
    case "result":
      return (
        <div className={`row row-result status-${row.status}`}>
          {row.status === "completed" ? "主 Run 已结束 · 不代表任务已验收" : row.status === "timed_out" ? "主 Run 超时" : `Run ${row.status}`}
          {row.detail ? <span className="tool-detail"> · {row.detail}</span> : null}
        </div>
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function toolStatusLabel(status: ToolRowStatus): string {
  switch (status) {
    case "requested":
      return "调用中";
    case "ok":
      return "ok";
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
    <div className="identity">
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
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [live, setLive] = useState<LiveRun>(emptyLiveRun);
  const [lastResult, setLastResult] = useState<ConversationRow | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [records, setRecords] = useState<RecordsState>({ status: "loading" });
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [recordDetail, setRecordDetail] = useState<RecordDetailState>({ status: "idle" });
  const [finalRecord, setFinalRecord] = useState<ExecutionRunRecord | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const decisionInFlight = useRef<string | null>(null);
  const latestPrimaryId = useRef<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1000);
  const [detailTab, setDetailTab] = useState<"home" | "records" | "memory" | "context">("home");
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const homeBuffer = useRef("");
  const shellBuffer = useRef(new ShellProgressBuffer());
  const conversationEnd = useRef<HTMLDivElement | null>(null);
  const selectedRecordId = useRef<string | null>(null);

  const applySnapshot = useCallback((snapshot: UiSnapshot) => {
    setState(snapshot.state);
    setApproval(snapshot.pendingApproval);
    setOutput(snapshot.recentOutput);
    shellBuffer.current.clear();
    for (const chunk of snapshot.shellProgress) shellBuffer.current.apply(chunk);
    const activePrimary = snapshot.state.kind === "running" && snapshot.state.phase === "primary";
    latestPrimaryId.current = snapshot.state.kind === "running" && snapshot.state.phase === "primary"
      ? snapshot.state.runId : snapshot.lastPrimaryResult?.runId ?? null;
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
    const messages = await window.runloom.history();
    setHistory(overlayShellProgress(rowsFromHistory(messages), shellBuffer.current));
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
          }
          if (message.state.kind === "running" && message.state.phase === "primary" && message.state.runId !== null) latestPrimaryId.current = message.state.runId;
          if (message.state.kind === "idle") {
            setContextRefresh((value) => value + 1);
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
          void loadFinalRun(message.result.runId).catch((cause: unknown) => setError(String(cause)));
          const rows = finishRun(emptyLiveRun, message.result);
          setLastResult(rows.find((row) => row.kind === "result") ?? null);
          setLive((previous) => ({ rows: finishRun(previous, message.result), streaming: "" }));
          return;
        }
        case "shell-progress":
          if (message.phase !== "primary") return;
          shellBuffer.current.apply(message.progress);
          setLive((previous) => applyShellProgress(previous, message.progress.toolCallId, shellBuffer.current));
          return;
        case "memory-updated":
          setMemoryRefresh((value) => value + 1);
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
    conversationEnd.current?.scrollIntoView({ block: "end" });
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

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1000px)");
    const update = () => setDetailsOpen(wide.matches);
    wide.addEventListener("change", update);
    return () => wide.removeEventListener("change", update);
  }, []);

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
      if (!response.ok) setError(commandError(response));
      setInput("");
      return;
    }
    const response = await window.runloom.run(line);
    if (!response.ok) {
      setError(response.reason === "empty" ? "输入为空" : `当前忙（${response.reason}），未排队`);
      return;
    }
    setInput("");
    } catch { setError("未收到启动结果。请核对当前状态，不会自动重发。"); }
    finally { sendInFlight.current = false; setSending(false); }
  }, [input, approval, state]);

  const busy = state.kind !== "idle";
  const running = state.kind === "running";
  const activePrimary = running && state.phase === "primary";
  const visibleRows = [...history, ...(activePrimary ? live.rows : [])];
  const rows = [...(!activePrimary && finalRecord ? overlayExecutionReceipts(visibleRows, finalRecord.tools) : visibleRows),
    ...(!activePrimary && lastResult ? [lastResult] : [])];
  const homeView = parseHome(home);
  const unknownRuns = records.status === "ready" ? records.runs.filter(run => run.tools.some(tool => tool.status === "unknown")) : [];
  const openDetails = (tab: typeof detailTab) => { setDetailTab(tab); setDetailsOpen(true); };

  return (
    <div className="app">
      <header className="header">
        <span className={`state-dot ${state.kind}${running && state.runId === null ? " starting" : ""}`} />
        <span className="title">Runloom <span className="hint">个人工作助手</span></span>
        <span className="spacer" />
        <span className="state">{approval ? "等待你确认" : info ? stateLabel(state) : error ? "启动失败" : "正在连接后端"}</span>
        <button className="ghost" aria-label="工作区详情" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? "收起详情" : "详情"}</button>
        {busy ? (
          <button className="ghost" onClick={() => void window.runloom.cancel()}>
            取消
          </button>
        ) : null}
      </header>
      {info ? <Identity info={info} /> : null}
      {unknownRuns.length > 0 ? <div className="review-notice" role="status">
        有 {unknownRuns.length} 次执行包含未知效果，请核对应用；不会自动重试。
        <button className="ghost" onClick={() => openDetails("records")}>查看回执</button>
      </div> : null}
      <div className="workbench">
      <main className="workspace-pane">
      <section className="card conversation">
        <div className="card-head">
          <span>对话</span>
          {info ? <span className="hint">已提交 {history.filter((row) => row.kind === "text" && row.committed).length} 条</span> : null}
          <button className="ghost" onClick={() => setShowOutput((value) => !value)}>
            {showOutput ? "隐藏输出" : "系统输出"}
          </button>
        </div>
        <div className="rows">
          {rows.length === 0 && !live.streaming ? <div className="conversation-empty">
            <h2>从一件具体的事开始</h2>
            <p>说清目标、范围和要交付的结果。工具执行前会逐次征求你的确认。</p>
            <p className="hint">输入 / 可使用现有命令；本机控制只允许配置中的应用。</p>
          </div> : null}
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
          {activePrimary && live.streaming ? (
            <div className="row row-text role-assistant live">
              <span className="role">助手</span>
              <pre>{live.streaming}</pre>
            </div>
          ) : null}
          <div ref={conversationEnd} />
        </div>
        {showOutput ? <pre className="output">{output || "（无）"}</pre> : null}
      </section>
      </main>
      {detailsOpen ? <button className="inspector-shade" aria-label="关闭详情抽屉" onClick={() => setDetailsOpen(false)} /> : null}
      <aside className="inspector" hidden={!detailsOpen} aria-label="工作区详情面板">
        <div className="inspector-header"><strong>工作区详情</strong><button className="ghost" aria-label="关闭工作区详情" onClick={() => setDetailsOpen(false)}>关闭</button></div>
        <nav className="detail-tabs" aria-label="详情分类">
          {([['home', '概览'], ['records', '记录'], ['memory', '记忆'], ['context', '上下文']] as const).map(([tab, label]) =>
            <button key={tab} className={detailTab === tab ? "selected" : ""} aria-pressed={detailTab === tab} onClick={() => setDetailTab(tab)}>{label}</button>)}
        </nav>
        <div className="inspector-pane">
          <div hidden={detailTab !== "home"}>
            {info ? <div className="computer-config hint">本机控制：{info.computer.enabled ? `已配置（驱动未验证） · ${info.computer.allowedBundleIds.join("、")}` : "未启用"}</div> : null}
            <section className="card home">
              <div className="card-head"><span>概览</span><span className="hint">参考快照，不是当前磁盘</span>
                <button className="ghost" disabled={busy} onClick={() => void window.runloom.home().then(response => {
                  if (!response.ok) setError(commandError(response));
                }).catch(() => setError("概览读取失败"))}>刷新</button>
              </div>
              <HomeBody view={homeView} />
            </section>
          </div>
          <div hidden={detailTab !== "records"}><RecordsPanel records={records} detail={recordDetail}
            onRefresh={() => void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行记录读取失败"))}
            onOpen={runId => void openRecord(runId).catch(() => setError("执行回执读取失败"))} /></div>
          <div hidden={detailTab !== "memory"}>{info ? <MemoryPanel memory={info.memory} temporaryThread={info.temporaryThread}
            controllerIdle={!busy} refreshToken={memoryRefresh} /> : null}</div>
          <div hidden={detailTab !== "context"}>{info ? <ContextPanel controllerIdle={!busy} refreshToken={contextRefresh}
            hasCompaction={info.hasCompaction} /> : null}</div>
        </div>
      </aside>
      </div>
      <div className="action-dock">
      {approval ? <ApprovalCard approval={approval} deciding={decidingId === approval.approvalId} onDecision={decision => void decide(decision)} /> : null}
      {error ? <div className="error" role="alert">{error}{info ? <button className="ghost" aria-label="关闭错误提示" onClick={() => setError(null)}>关闭提示</button> : null}</div> : null}
      <footer className="composer">
        <textarea
          aria-label="消息输入"
          rows={3}
          value={input}
          disabled={busy || sending || info === null}
          placeholder={
            approval
              ? "先处理上方确认"
              : busy
                ? "运行中，输入会被拒绝"
                : "输入目标或问题；Shift+Enter 换行"
          }
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-controls">
        {info && info.commands.length > 0 ? (
          <details className="commands-menu"><summary>命令</summary><div className="commands">
            {info.commands.map((name) => (
              <button
                key={name}
                className="chip"
                disabled={busy}
                onClick={() => {
                  setInput(`/${name} `);
                }}
              >
                /{name}
              </button>
            ))}
          </div></details>
        ) : null}
        <span className="hint">Enter 发送 · Shift+Enter 换行</span>
        <button className="allow" disabled={busy || sending || !input.trim() || info === null} onClick={() => void submit()}>{sending ? "正在提交…" : "发送"}</button>
        </div>
      </footer>
      </div>
    </div>
  );
}
