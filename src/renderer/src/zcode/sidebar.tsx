import React, { useState } from "react";
import type { ThreadSummary } from "../../../shared/ui-contract.js";
import { Icon, SerikaMark, type IconName } from "../icons.js";
import { baseName } from "../home.js";
import { threadTitle, visibleThreads } from "../thread-list-data.js";

export type DetailTab = "threads" | "tasks" | "home" | "records" | "memory" | "context" | "pomodoro" | "modules";

/** Runloom-owned navigation using ZCode's workspace/list layout, not its store. */
export function ZCodeSidebar({ threads, currentId, drafts, workspaceRoot, loading, error, busy, selected,
  pendingMemory, unknownRuns, onNew, onSelect, onOpen, onConversation }: {
  threads: readonly ThreadSummary[]; currentId: string; drafts: ReadonlyMap<string, string>;
  workspaceRoot: string | null; loading: boolean; error: string | null; busy: boolean;
  selected: DetailTab | null; pendingMemory: string | null; unknownRuns: number;
  onNew: () => void; onSelect: (id: string) => void; onOpen: (tab: DetailTab) => void; onConversation: () => void;
}) {
  const [query, setQuery] = useState("");
  const rows = visibleThreads(threads, currentId, drafts).filter(thread =>
    threadTitle(thread, drafts.get(thread.threadId)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const nav = (tab: DetailTab, label: string, icon: IconName, count?: string) => <button
    className={`zcode-nav-item${selected === tab ? " selected" : ""}`}
    aria-current={selected === tab ? "page" : undefined} aria-label={label} title={label} onClick={() => onOpen(tab)}>
    <Icon name={icon} size={17} /><span>{label}</span>{count ? <small className="zcode-nav-count">{count}</small> : null}
  </button>;
  return <aside className="zcode-sidebar" aria-label="主导航">
    <div className="zcode-brand"><SerikaMark size={28} /><strong>Serika</strong>
      <button className="icon-button" title="回到当前对话" aria-label="回到当前对话" onClick={onConversation}><Icon name="panel" size={16} /></button>
    </div>
    <button className="zcode-new-chat" aria-label="新对话" title="开始新对话；保留当前未发送草稿" disabled={busy} onClick={onNew}>
      <Icon name="new-chat" size={17} /><span>新对话</span>
    </button>
    <nav className="zcode-navigation" aria-label="工作与记忆">
      {nav("tasks", "工作任务", "activity")}
      {nav("memory", "记忆", "memory", pendingMemory ?? undefined)}
      {nav("records", "执行记录", "terminal", unknownRuns ? String(unknownRuns) : undefined)}
    </nav>
    <section className="zcode-history" aria-label="最近对话">
      <div className="zcode-history-heading"><span>对话</span><button className="ghost" onClick={() => onOpen("threads")} title="查看全部对话、搜索正文或登记旧记录">全部</button></div>
      <label className="zcode-history-search"><span className="zcode-sr-only">筛选已登记的对话标题</span>
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找对话…" />
      </label>
      <div className="zcode-thread-list">
        {loading ? <p role="status">正在读取对话…</p> : error ? <div role="status"><p>对话读取失败，旧记录未删除。</p><button className="ghost" onClick={() => onOpen("threads")}>查看原因／重新读取</button></div> : <>
          {rows.slice(0, 40).map(thread => <button key={thread.threadId}
            className={`zcode-thread${selected === null && thread.threadId === currentId ? " selected" : ""}`}
            title={thread.error ?? threadTitle(thread, drafts.get(thread.threadId))}
            aria-current={selected === null && thread.threadId === currentId ? "true" : undefined}
            disabled={busy || !!thread.error} onClick={() => onSelect(thread.threadId)}>
            <span>{threadTitle(thread, drafts.get(thread.threadId))}</span>
            {thread.error ? <small>记录不可读</small> : drafts.has(thread.threadId) ? <small>草稿</small> : thread.taskCount ? <small>任务</small> : null}
          </button>)}
          {rows.length === 0 ? <p>{query ? "没有匹配的对话标题" : "还没有已登记的对话"}</p> : null}
          {rows.length > 40 ? <button className="ghost" onClick={() => onOpen("threads")}>查看其余对话</button> : null}
        </>}
      </div>
      {busy ? <p className="zcode-busy-note">处理结束后可切换对话</p> : null}
    </section>
    <nav className="zcode-utilities" aria-label="工具与设置">
      {nav("pomodoro", "番茄钟", "timer")}
      {nav("modules", "模块能力", "modules")}
      {nav("context", "上下文与压缩", "context")}
    </nav>
    <button className="zcode-workspace" aria-label="工作区、订阅与设置" title={workspaceRoot ?? "尚未配置工作区"} onClick={() => onOpen("home")}>
      <Icon name="home" size={17} /><span><strong>{workspaceRoot ? baseName(workspaceRoot) : "当前工作区"}</strong><small>工作区、订阅与设置</small></span><Icon name="chevron" size={13} />
    </button>
  </aside>;
}
