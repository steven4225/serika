/* WorkspaceSidebar/WorkspaceSidebarFooter presentation adapted from zai-org/ZCode
 * 29628c9acdb81b703bbd4080c207a0e7ce5e276e, Apache-2.0.
 * Serika owns history, navigation and settings; no upstream account/RPC. */
import React, { useEffect, useRef, useState } from "react";
import { Search, Clock3, Blocks, Settings2, Sun, Moon, ChevronDown, ListTodo, BookOpen, PanelLeft } from "lucide-react";
import type { ThreadSummary } from "../../../shared/ui-contract.js";
import { Icon, SerikaMark, type IconName } from "../icons.js";
import { baseName } from "../home.js";
import { threadTitle, visibleThreads } from "../thread-list-data.js";
import { Button } from "./upstream/button.js";
import { NewTaskButton } from "./upstream/new-task-button.js";
import type { ZCodeAppearance } from "./appearance.js";

export type DetailTab = "threads" | "tasks" | "home" | "records" | "memory" | "context" | "pomodoro" | "modules";

export function ZCodeSidebar({ threads, currentId, drafts, workspaceRoot, loading, error, busy, selected,
  pendingMemory, unknownRuns, onNew, onSelect, onOpen, onConversation, appearance = "dark", onAppearance }: {
  threads: readonly ThreadSummary[]; currentId: string; drafts: ReadonlyMap<string, string>;
  workspaceRoot: string | null; loading: boolean; error: string | null; busy: boolean;
  selected: DetailTab | null; pendingMemory: string | null; unknownRuns: number;
  onNew: () => void; onSelect: (id: string) => void; onOpen: (tab: DetailTab) => void; onConversation: () => void;
  appearance?: ZCodeAppearance; onAppearance?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const settings = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !settings.current?.contains(event.target)) settings.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && settings.current?.open) {
        event.preventDefault(); event.stopPropagation(); settings.current.open = false;
        settings.current.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  const rows = visibleThreads(threads, currentId, drafts).filter(thread =>
    threadTitle(thread, drafts.get(thread.threadId)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const nav = (tab: DetailTab, label: string, icon: IconName, count?: string) => <Button variant="ghost" size="lg"
    className={`zcode-nav-item${selected === tab ? " selected" : ""}`}
    aria-current={selected === tab ? "page" : undefined} aria-label={label} title={label} onClick={() => onOpen(tab)}>
    <Icon name={icon} size={16} /><span>{label}</span>{count ? <small className="zcode-nav-count">{count}</small> : null}
  </Button>;
  return <aside className="zcode-sidebar flex h-full min-h-0 flex-col" aria-label="主导航" data-zcode-source="WorkspaceSidebar">
    <div className="zcode-window-spacer h-12 shrink-0" />
    <nav className="zcode-navigation flex flex-col gap-1 px-2.5" aria-label="主功能">
      <NewTaskButton onCreateTask={onNew} disabled={busy} />
      <Button variant="ghost" size="lg" className="zcode-nav-item" aria-label="搜索对话" title="搜索对话" aria-expanded={searchOpen}
        onClick={() => { if (window.innerWidth <= 800) onOpen("threads"); else setSearchOpen(value => !value); }}><Search size={16} /><span>搜索</span></Button>
      <Button variant="ghost" size="lg" className={`zcode-nav-item${selected === "home" ? " selected" : ""}`} aria-label="自动化与工作区" title="定时任务、订阅和工作区" onClick={() => onOpen("home")}><Clock3 size={16} /><span>自动化与工作区</span></Button>
      <Button variant="ghost" size="lg" className={`zcode-nav-item${selected === "modules" ? " selected" : ""}`} aria-label="模块能力" title="模块能力" onClick={() => onOpen("modules")}><Blocks size={16} /><span>模块能力</span></Button>
    </nav>
    <section className="zcode-history" aria-label="最近对话">
      <div className="zcode-history-heading"><span>最近对话</span><Button variant="ghost" size="icon-sm" aria-label="全部对话" title="全部对话、搜索正文或登记旧记录" onClick={() => onOpen("threads")}><ChevronDown /></Button></div>
      {searchOpen ? <label className="zcode-history-search"><span className="zcode-sr-only">筛选已登记的对话标题</span>
        <input type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSearchOpen(false); setQuery(""); } }} placeholder="搜索对话标题…" /></label> : null}
      <div className="zcode-thread-list">
        {loading ? <p role="status">正在读取对话…</p> : error ? <div role="status"><p>对话读取失败，旧记录未删除。</p><Button variant="ghost" onClick={() => onOpen("threads")}>查看原因／重新读取</Button></div> : <>
          {rows.slice(0, 40).map(thread => <Button key={thread.threadId} variant="ghost" size="lg"
            className={`zcode-thread${selected === null && thread.threadId === currentId ? " selected" : ""}`}
            title={thread.error ?? threadTitle(thread, drafts.get(thread.threadId))}
            aria-current={selected === null && thread.threadId === currentId ? "true" : undefined}
            disabled={busy || !!thread.error} onClick={() => onSelect(thread.threadId)}>
            <span>{threadTitle(thread, drafts.get(thread.threadId))}</span>
            {thread.error ? <small>记录不可读</small> : drafts.has(thread.threadId) ? <small>草稿</small> : thread.taskCount ? <small>任务</small> : null}
          </Button>)}
          {rows.length === 0 ? <p>{query ? "没有匹配的对话标题" : "还没有已登记的对话"}</p> : null}
          {rows.length > 40 ? <Button variant="ghost" onClick={() => onOpen("threads")}>查看其余对话</Button> : null}
        </>}
      </div>
      {busy ? <p className="zcode-busy-note">处理结束后可切换对话</p> : null}
    </section>
    <nav className="zcode-utilities" aria-label="查阅">
      {nav("tasks", "工作任务", "activity")}
      {nav("memory", "记忆", "memory", pendingMemory ?? undefined)}
      {nav("records", "执行记录", "terminal", unknownRuns ? String(unknownRuns) : undefined)}
    </nav>
    <footer className="zcode-sidebar-footer" data-zcode-source="WorkspaceSidebarFooter">
      <Button variant="ghost" size="icon" aria-label="回到当前对话" title="回到当前对话" className="zcode-return" onClick={onConversation}><PanelLeft /></Button>
      <Button variant="ghost" className="zcode-profile" title={workspaceRoot ?? "尚未配置工作区"} aria-label="查看当前工作区" onClick={() => onOpen("home")}><SerikaMark size={27} /><span><strong>Serika</strong><small>{workspaceRoot ? baseName(workspaceRoot) : "当前工作区"}</small></span></Button>
      {onAppearance ? <Button variant="ghost" size="icon" title={appearance === "dark" ? "切换浅色外观" : "切换深色外观"} aria-label={appearance === "dark" ? "切换浅色外观" : "切换深色外观"} onClick={onAppearance}>{appearance === "dark" ? <Sun /> : <Moon />}</Button> : null}
      <details ref={settings} className="zcode-settings"><summary aria-label="更多工具与设置" title="更多工具与设置"><Settings2 size={16} /></summary>
        <div className="zcode-settings-menu">{([["pomodoro", "番茄钟", Clock3], ["context", "上下文与压缩", BookOpen], ["threads", "全部对话与旧记录", ListTodo]] as const).map(([tab, label, Glyph]) => <Button key={tab} variant="ghost" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onOpen(tab); }}><Glyph />{label}</Button>)}</div>
      </details>
    </footer>
  </aside>;
}
