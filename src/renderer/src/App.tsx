import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo, MainToRenderer, UiState } from "../../shared/ui-contract.js";
import {
  applyEvent,
  emptyLiveRun,
  finishRun,
  rowsFromHistory,
  type ConversationRow,
  type LiveRun,
  type ToolRowStatus,
} from "./conversation.js";
import { baseName, parseHome, shortId, type HomeView } from "./home.js";

const OUTPUT_MAX_CHARS = 64 * 1024;

function stateLabel(state: UiState): string {
  switch (state.kind) {
    case "idle":
      return "空闲";
    case "running":
      return "运行中";
    case "compacting":
      return "压缩上下文";
    case "resuming":
      return "核对 Git";
    default: {
      const exhaustive: never = state;
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
        </div>
      );
    case "step":
      return <div className="row row-step">step {row.step}</div>;
    case "result":
      return (
        <div className={`row row-result status-${row.status}`}>
          Run {row.status}
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
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const homeBuffer = useRef("");
  const conversationEnd = useRef<HTMLDivElement | null>(null);

  // After a Run settles, the Store is the source of truth: replace the live
  // projection with committed rows so nothing is shown twice.
  const reloadHistory = useCallback(async () => {
    const messages = await window.runloom.history();
    setHistory(rowsFromHistory(messages));
    setLive(emptyLiveRun);
  }, []);

  useEffect(() => {
    void window.runloom.info().then(setInfo).catch((cause: unknown) => setError(String(cause)));
    void reloadHistory().catch((cause: unknown) => setError(String(cause)));
    const stop = window.runloom.onMessage((message: MainToRenderer) => {
      switch (message.type) {
        case "state":
          setState(message.state);
          if (message.state.kind === "idle") {
            void reloadHistory().catch((cause: unknown) => setError(String(cause)));
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
        case "confirmation":
          setConfirmation(message.prompt);
          return;
        case "confirmation-cleared":
          setConfirmation(null);
          return;
        case "event":
          setLive((previous) => applyEvent(previous, message.event));
          return;
        case "result": {
          const rows = finishRun(emptyLiveRun, message.result);
          setLastResult(rows.find((row) => row.kind === "result") ?? null);
          setLive((previous) => ({ rows: finishRun(previous, message.result), streaming: "" }));
          return;
        }
        case "error":
          setError(message.message);
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    });
    return stop;
  }, [reloadHistory]);

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

  const submit = useCallback(async () => {
    const line = input.trim();
    if (line.length === 0) return;
    setError(null);
    // While a confirmation is pending the line belongs to it, as in the TUI:
    // y allows, n denies, anything else keeps waiting.
    if (confirmation !== null) {
      if (line === "y" || line === "n") {
        await window.runloom.confirm(line);
        setInput("");
      } else {
        setError("请输入 y 或 n");
      }
      return;
    }
    if (line.startsWith("/")) {
      const response = await window.runloom.command(line);
      if (!response.ok) setError(`命令未执行：${response.reason}`);
      setInput("");
      return;
    }
    setLive(emptyLiveRun);
    setLastResult(null);
    const response = await window.runloom.run(line);
    if (!response.ok) {
      setError(response.reason === "empty" ? "输入为空" : `当前忙（${response.reason}），未排队`);
      return;
    }
    setInput("");
  }, [input, confirmation]);

  const busy = state.kind !== "idle";
  const rows = [...history, ...live.rows, ...(live.rows.length === 0 && lastResult ? [lastResult] : [])];
  const homeView = parseHome(home);

  return (
    <div className="app">
      <header className="header">
        <span className={`state-dot ${state.kind}`} />
        <span className="title">Runloom</span>
        <span className="spacer" />
        <span className="state">{stateLabel(state)}</span>
        {busy && state.kind === "running" ? (
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
          <button className="ghost" disabled={busy} onClick={() => void window.runloom.home()}>
            刷新
          </button>
        </div>
        <HomeBody view={homeView} />
      </section>

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

      {confirmation ? (
        <section className="card approval">
          <div className="card-head">
            <span>等待确认</span>
            <span className="hint">同一时刻只有一项 · 不会记住选择</span>
          </div>
          <pre className="prompt">{confirmation}</pre>
          <div className="actions">
            <button className="deny" onClick={() => void window.runloom.confirm("n")}>
              拒绝 N
            </button>
            <button className="allow" onClick={() => void window.runloom.confirm("y")}>
              允许 Y
            </button>
          </div>
        </section>
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      <footer className="composer">
        <input
          value={input}
          disabled={busy && confirmation === null}
          placeholder={
            busy ? (confirmation ? "先处理上方确认" : "运行中，输入会被拒绝") : "输入消息，/ 开头是命令"
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
