import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, FileText, Folder, FolderOpen, MoreHorizontal, Plus, RotateCw, Upload } from "lucide-react";
import type { MemoryLibraryAction, MemoryLibraryDocument, MemoryLibraryView } from "@serika/assistant";
import { MessageContent } from "./markdown.js";

type Draft = { id: string; title: string; folderId: string | null; text: string; entries: { id: string; revision: number }[]; expectedRevision: number };
type FolderDraft = { id: string; name: string; expectedRevision: number; operation: "create-folder" | "rename-folder" };
export async function readMemoryFile(file: File): Promise<{ title: string; text: string }> {
  if (!/\.(txt|md)$/i.test(file.name)) throw new Error("请选择 TXT 或 MD 文件");
  if (file.size > 64 * 1024) throw new Error("文档最多 64 KiB，请拆分后导入");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  if (!text.trim() || text.includes("\0")) throw new Error("请选择包含正文的 UTF-8 文本文件");
  return { title: file.name.replace(/\.(txt|md)$/i, "").slice(0, 160) || "未命名文档", text };
}
export function MemoryFolders({ library, onOpen }: { library: MemoryLibraryView; onOpen: (id: string | null) => void }) {
  return <div className="memory-library-grid">
    {[...library.folders, { id: null, name: "未归档" }].map((folder, index) => <button type="button" className="memory-folder-tile" key={folder.id ?? "unfiled"} onClick={() => onOpen(folder.id)}>
      <span className={`memory-folder-art memory-folder-color-${index % 4}`} aria-hidden="true"><Folder size={36} strokeWidth={1.4} /></span>
      <strong>{folder.name}</strong><small>{library.documents.filter(document => document.folderId === folder.id && document.active).length} 篇</small>
    </button>)}
  </div>;
}

export function MemoryLibraryPanel({ enabled, controllerIdle, refreshToken, onManage }: { enabled: boolean; controllerIdle: boolean; refreshToken: number; onManage?: (() => void) | undefined }) {
  const [library, setLibrary] = useState<MemoryLibraryView | null>(null);
  const [location, setLocation] = useState<{ kind: "home" } | { kind: "folder"; id: string | null }>({ kind: "home" });
  const [document, setDocument] = useState<MemoryLibraryDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [folderDraft, setFolderDraft] = useState<FolderDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [changed, setChanged] = useState(false);
  const live = useRef(true), mutation = useRef(false), listRequest = useRef(0), detailRequest = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const initialRefresh = useRef(refreshToken);
  const folderId = location.kind === "folder" ? location.id : null;
  const folderName = folderId === null ? "未归档" : library?.folders.find(folder => folder.id === folderId)?.name ?? "文件夹";
  const blocked = !controllerIdle || saving || !enabled;
  const load = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const result = await window.runloom.getMemoryLibrary();
      if (!live.current || request !== listRequest.current) return;
      if (result.ok) { setLibrary(result.value); return result.value; }
      setError(result.error.message);
    } catch { if (live.current && request === listRequest.current) setError("记忆读取失败，请重新加载"); }
    return undefined;
  }, []);
  useEffect(() => { live.current = true; if (enabled) void load(); return () => { live.current = false; ++listRequest.current; ++detailRequest.current; }; }, [enabled, load]);
  useEffect(() => {
    if (initialRefresh.current === refreshToken) return;
    initialRefresh.current = refreshToken;
    if (mutation.current || !enabled) return;
    void load();
  }, [refreshToken, enabled, load]);

  const open = async (id: string) => {
    const request = ++detailRequest.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await window.runloom.readMemoryDocument(id);
      if (!live.current || request !== detailRequest.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setDocument(result.value); setDraft(null); setChanged(false);
    } catch { if (live.current && request === detailRequest.current) setError("文档读取失败，请重试"); }
    finally { if (live.current && request === detailRequest.current) setLoading(false); }
  };
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const beginDocument = (title = "", text = "") => {
    if (!library || blocked) return;
    ++detailRequest.current; setLoading(false); setDocument(null); setFolderDraft(null);
    setDraft({ id: crypto.randomUUID(), title, text, folderId, entries: [], expectedRevision: library.revision });
    setError(""); setNotice(""); setChanged(false); closeMenu();
  };
  const beginFolder = () => {
    if (!library || blocked) return;
    setFolderDraft({ id: crypto.randomUUID(), name: "", expectedRevision: library.revision, operation: "create-folder" });
    setError(""); setNotice(""); closeMenu();
  };
  const importFile = async (file: File) => {
    const request = ++detailRequest.current;
    setLoading(true); setError("");
    try {
      const content = await readMemoryFile(file);
      if (live.current && request === detailRequest.current) beginDocument(content.title, content.text);
    } catch (error) { if (live.current && request === detailRequest.current) setError(error instanceof Error ? error.message : "文件读取失败"); }
    finally { if (live.current) setLoading(false); }
  };
  const change = async (action: MemoryLibraryAction): Promise<boolean> => {
    if (mutation.current || blocked || uncertain) return false;
    mutation.current = true; setSaving(true); setError(""); setNotice(""); ++listRequest.current;
    try {
      const result = await window.runloom.changeMemoryLibrary(action);
      if (!live.current) return false;
      if (!result.ok) {
        setError(result.error.message);
        setUncertain(["MEMORY_COMMIT_UNCERTAIN", "WRITE_FAILED"].includes(result.error.code));
        if (result.error.code === "MEMORY_REVISION_CONFLICT") setChanged(true);
        return false;
      }
      setLibrary(result.value); setChanged(false); setNotice("已保存"); return true;
    } catch {
      if (live.current) { setError("保存结果未确认，请先核对保存结果"); setUncertain(true); }
      return false;
    } finally { mutation.current = false; if (live.current) setSaving(false); }
  };
  const save = async () => {
    if (!draft || !draft.title.trim() || !draft.text.trim()) return;
    const current = draft;
    if (await change({ operation: "save-document", ...current })) {
      setDraft(null); await open(current.id); setNotice("已保存");
    }
  };
  const saveFolder = async () => {
    if (!folderDraft) return;
    const current = folderDraft;
    if (await change(current)) { setFolderDraft(null); setLocation({ kind: "folder", id: current.id }); }
  };
  const verify = async () => {
    setError("");
    const view = await load();
    if (!view || !live.current) return;
    if (draft) {
      if (view.documents.some(document => document.id === draft.id)) {
        const result = await window.runloom.readMemoryDocument(draft.id).catch(() => null);
        if (!live.current) return;
        if (!result?.ok) { setError("正文仍未核实，请稍后重新核对"); return; }
        setDocument(result.value);
        if (result.value.text === draft.text && result.value.title === draft.title.trim() && result.value.folderId === draft.folderId) {
          setDraft(null); setNotice("已核对，文档已保存");
        } else { setError("已读取已存正文；草稿仍保留。请对照下方正文后，选择使用已存版本或继续编辑草稿。"); setDraft({ ...draft, expectedRevision: result.value.libraryRevision, entries: result.value.entries }); }
      } else { setDraft({ ...draft, expectedRevision: view.revision }); setNotice("已核对，文档尚未保存，草稿仍保留"); }
    } else if (folderDraft) {
      const saved = view.folders.find(folder => folder.id === folderDraft.id);
      if (saved?.name === folderDraft.name.trim()) { setFolderDraft(null); setNotice("已核对，文件夹已保存"); }
      else { setFolderDraft({ ...folderDraft, expectedRevision: view.revision }); setNotice("已重新读取文件夹，输入仍保留"); }
    } else if (document) await open(document.id);
    setUncertain(false); setChanged(false);
  };
  const back = () => {
    if (saving || uncertain) return;
    ++detailRequest.current; setLoading(false); setError(""); setNotice(""); setChanged(false);
    if (draft || document) { setDraft(null); setDocument(null); }
    else if (folderDraft) setFolderDraft(null);
    else setLocation({ kind: "home" });
  };
  if (!enabled) return <p>记忆未启用，请在设置中开启。</p>;
  const items = library?.documents.filter(item => item.folderId === folderId && (item.active || item.missing)) ?? [];
  return <div className="memory-library">
    <div className="memory-library-toolbar">
      <div className="memory-back-row">
        {location.kind !== "home" || draft || document || folderDraft ? <button type="button" className="memory-back" aria-label="返回文件夹" disabled={saving || uncertain} onClick={back}><ChevronLeft size={20} /></button> : null}
        <h1>{draft ? document ? "编辑文档" : "新建文档" : document ? document.title : folderDraft ? folderDraft.operation === "create-folder" ? "新建文件夹" : "重命名文件夹" : location.kind === "home" ? "记忆" : folderName}</h1>
      </div>
      {!draft && !document && !folderDraft ? <details className="memory-library-menu" ref={menu}>
        <summary aria-label="记忆操作"><MoreHorizontal size={21} /></summary>
        <div role="group" aria-label="记忆操作">
          <button disabled={blocked || !library} onClick={() => { closeMenu(); picker.current?.click(); }}><Upload size={16} />导入文件</button>
          <button disabled={blocked || !library} onClick={() => beginDocument()}><FileText size={16} />新建文档</button>
          <button disabled={blocked || !library} onClick={beginFolder}><Plus size={16} />新建文件夹</button>
          {folderId && library ? <button disabled={blocked} onClick={() => { setFolderDraft({ operation: "rename-folder", id: folderId, name: folderName, expectedRevision: library.revision }); closeMenu(); }}>重命名文件夹</button> : null}
        </div>
      </details> : document && !draft ? <div className="actions"><button className="ghost" aria-label="重新读取文档" disabled={blocked} onClick={() => void open(document.id)}><RotateCw size={16} /></button><button className="ghost" disabled={blocked || document.missing || changed} onClick={() => setDraft({ id: document.id, title: document.title, text: document.text, folderId: document.folderId, entries: document.entries, expectedRevision: document.libraryRevision })}>编辑</button></div> : null}
    </div>
    <input ref={picker} type="file" accept=".txt,.md,text/plain,text/markdown" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importFile(file); }} />
    {error ? <p role="alert" className="memory-library-error">{error}</p> : null}
    {notice ? <p role="status" className="memory-library-notice">{notice}</p> : null}
    {changed || uncertain ? <div className="memory-library-refresh"><span>{uncertain ? "先核对保存结果，再进行下一步。" : "记忆已变化，草稿仍保留。"}</span><button disabled={saving} onClick={() => void verify()}>{uncertain ? "核对保存结果" : "读取最新版本"}</button></div> : null}
    {loading ? <p role="status">正在读取文档…</p> : null}
    {folderDraft ? <form className="memory-document-editor" onSubmit={event => { event.preventDefault(); void saveFolder(); }}>
      <label>文件夹名称<input autoFocus maxLength={80} value={folderDraft.name} disabled={saving || uncertain} onChange={event => setFolderDraft({ ...folderDraft, name: event.target.value })} /></label>
      <div className="actions"><button type="submit" disabled={blocked || uncertain || changed || !folderDraft.name.trim()}>{saving ? "保存中…" : "保存文件夹"}</button><button type="button" className="ghost" disabled={saving || uncertain} onClick={back}>取消</button></div>
    </form> : draft ? <form className="memory-document-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>文档标题<input autoFocus maxLength={160} value={draft.title} disabled={saving || uncertain} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>所在文件夹<select value={draft.folderId ?? ""} disabled={saving || uncertain} onChange={event => setDraft({ ...draft, folderId: event.target.value || null })}><option value="">未归档</option>{library?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
      <label>正文<textarea rows={16} value={draft.text} disabled={saving || uncertain} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      <small>支持 TXT / MD，每篇最多 64 KiB。保存后可供助手按相关内容引用。</small>
      <div className="actions"><button type="submit" disabled={blocked || uncertain || changed || !draft.title.trim() || !draft.text.trim()}>{saving ? "保存中…" : "保存文档"}</button><button type="button" className="ghost" disabled={saving || uncertain} onClick={back}>取消编辑</button></div>
      <details><summary>预览正文</summary><MessageContent text={draft.text} /></details>
    </form> : document ? <article className="memory-document-body"><MessageContent text={document.text || "正文暂不可用。"} /></article> : !folderDraft && !loading ? library ? location.kind === "home" ? <MemoryFolders library={library} onOpen={id => { closeMenu(); setLocation({ kind: "folder", id }); setError(""); setNotice(""); }} /> : <div className="memory-library-grid memory-document-grid">
      {items.length === 0 ? <div className="memory-library-empty"><FolderOpen size={32} /><p>还没有文档</p><button className="ghost" disabled={blocked} onClick={() => picker.current?.click()}>导入文件</button><button className="ghost" disabled={blocked} onClick={() => beginDocument()}>新建文档</button></div> : items.map(item => <button type="button" className="memory-document-tile" key={item.id} onClick={() => void open(item.id)}><FileText size={26} /><strong>{item.title}</strong>{item.updatedAt ? <small>更新于 {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</small> : null}<p>{item.preview}</p>{item.missing ? <small>部分内容已删除</small> : null}</button>)}
    </div> : <p>{error ? <button className="ghost" onClick={() => void load()}>重新加载</button> : "正在读取记忆…"}</p> : null}
    {draft && document ? <details className="memory-document-compare"><summary>已保存的正文</summary><h2>{document.title}</h2><MessageContent text={document.text} /><button disabled={saving || uncertain} onClick={() => setDraft(null)}>使用已存版本</button></details> : null}
    {document && !draft && onManage ? <details className="memory-document-details"><summary>来源</summary><p>{document.scope.kind === "thread" ? "仅当前对话使用" : "当前工作区可用"}{!document.active ? " · 当前未引用" : ""}</p><button className="ghost" onClick={onManage}>编辑或删除</button></details> : null}
  </div>;
}
