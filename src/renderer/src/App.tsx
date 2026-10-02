import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppInfo,
  CommandResponse,
  MainToRenderer,
  PendingApproval,
  UiSnapshot,
  UiState,
} from "../../shared/ui-contract.js";
import { ShellProgressBuffer } from "../../shared/shell-progress.js";
import {
  applyEvent,
  applyShellProgress,
  emptyLiveRun,
  finishRun,
  overlayShellProgress,
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
          {row.status === "timed_out" ? "主 Run 超时" : `Run ${row.status}`}
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
      <span className="pill" title={`模型：${info.modelAlias}（配置值，不代表已联网验证）`}>
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
    if (snapshot.state.kind === "idle") {
      setLive(emptyLiveRun);
      setLastResult(null);
    } else {
      setLive({
        rows: overlayShellProgress(rowsFromToolActivity(snapshot.toolActivity), shellBuffer.current),
        streaming: "",
      });
      setLastResult(snapshot.lastPrimaryResult ? resultRow(snapshot.lastPrimaryResult) : null);
    }
  }, []);

  const reloadHistory = useCallback(async () => {
    const messages = await window.runloom.history();
    setHistory(overlayShellProgress(rowsFromHistory(messages), shellBuffer.current));
    setLive(emptyLiveRun);
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
          }
          if (message.state.kind === "idle") {
            setContextRefresh((value) => value + 1);
            void reloadHistory().catch((cause: unknown) => setError(String(cause)));
            void loadRecords(selectedRecordId.current ?? undefined).catch((cause: unknown) => setError(String(cause)));
            setLastResult(null);
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
        const nextInfo = await window.runloom.info();
        if (cancelled) return;
        setInfo(nextInfo);
        const first = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(first);
        stop = window.runloom.onMessage(onMessage);
        const second = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(second);
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
  }, [applySnapshot, reloadHistory, loadRecords]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: "end" });
  }, [history, live, lastResult]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void window.runloom.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const decide = useCallback(async (decision: "allow" | "deny") => {
    if (approval === null) return;
    setError(null);
    const { accepted } = await window.runloom.confirm({ approvalId: approval.approvalId, decision });
    if (!accepted) setError("这次确认未生效");
  }, [approval]);

  const submit = useCallback(async () => {
    const line = input.trim();
    if (line.length === 0) return;
    setError(null);
    if (approval !== null) {
      setError("请先处理上方确认");
      return;
    }
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
  }, [input, approval]);

  const busy = state.kind !== "idle";
  const running = state.kind === "running";
  const rows = [...history, ...live.rows, ...(live.rows.length === 0 && lastResult ? [lastResult] : [])];
  const homeView = parseHome(home);

  return (
    <div className="app">
      <header className="header">
        <span className={`state-dot ${state.kind}${running && state.runId === null ? " starting" : ""}`} />
        <span className="title">Runloom</span>
        <span className="spacer" />
        <span className="state">{stateLabel(state)}</span>
        {running ? (
          <button className="ghost" onClick={() => void window.runloom.cancel()}>
            取消
          </button>
        ) : null}
      </header>
      {info ? <Identity info={info} /> : null}

      <section className="card home">
        <div className="card-head">
          <span>Home</span>
          <span className="hint">
            {homeView.time ? `${homeView.time} · ` : ""}参考快照，不是当前磁盘
          </span>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => {
              void window.runloom.home().then((response) => {
                if (!response.ok) setError(commandError(response));
              });
            }}
          >
            刷新
          </button>
        </div>
        <HomeBody view={homeView} />
      </section>

      <RecordsPanel
        records={records}
        detail={recordDetail}
        onRefresh={() => void loadRecords(selectedRecordId.current ?? undefined)}
        onOpen={(runId) => void openRecord(runId)}
      />

      {info ? (
        <ContextPanel controllerIdle={!busy} refreshToken={contextRefresh} hasCompaction={info.hasCompaction} />
      ) : null}

      {info ? (
        <MemoryPanel
          memory={info.memory}
          temporaryThread={info.temporaryThread}
          controllerIdle={!busy}
          refreshToken={memoryRefresh}
        />
      ) : null}

      <section className="card conversation">
        <div className="card-head">
          <span>对话</span>
          {info ? <span className="hint">已提交 {history.filter((row) => row.kind === "text" && row.committed).length} 条</span> : null}
          <button className="ghost" onClick={() => setShowOutput((value) => !value)}>
            {showOutput ? "隐藏输出" : "系统输出"}
          </button>
        </div>
        <div className="rows">
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
          {live.streaming ? (
            <div className="row row-text role-assistant live">
              <span className="role">助手</span>
              <pre>{live.streaming}</pre>
            </div>
          ) : null}
          <div ref={conversationEnd} />
        </div>
        {showOutput ? <pre className="output">{output || "（无）"}</pre> : null}
      </section>

      {approval ? (
        <section className="card approval">
          <div className="card-head">
            <span>等待确认</span>
            <span className="hint">
              {approval.toolName} · 同一时刻只有一项 · 不会记住选择
            </span>
          </div>
          <pre className="prompt">{approval.preview.length > 0 ? approval.preview : "正在生成预览…"}</pre>
          <div className="actions">
            <button className="deny" onClick={() => void decide("deny")}>
              拒绝
            </button>
            <button className="allow" onClick={() => void decide("allow")}>
              允许
            </button>
          </div>
        </section>
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      <footer className="composer">
        <input
          value={input}
          disabled={busy}
          placeholder={
            approval
              ? "先处理上方确认"
              : busy
                ? "运行中，输入会被拒绝"
                : "输入消息，/ 开头是命令"
          }
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {info && info.commands.length > 0 ? (
          <div className="commands">
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
          </div>
        ) : null}
      </footer>
    </div>
  );
}
