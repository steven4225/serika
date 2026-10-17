import { EntryCardContent } from "./personal/entry-card.js";
import { useRef, useState } from "react";
import type { MemoryImportEntry, MemoryImportPreview, MemoryImportReceipt } from "@serika/example-cli/dist/memory-import.js";
import { submitCreation } from "./creation-operation.js";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const kinds = { note: "笔记", fact: "事实", preference: "偏好", event: "事件" } as const;
export function splitImportText(text: string): MemoryImportEntry[] {
  if (bytes(text) > 64 * 1024) throw new Error("文本最多 64 KiB，请分批导入。");
  const entries = text.split(/\r?\n\s*\r?\n/).map(text => text.trim()).filter(Boolean).map(text => ({ text, kind: "note" as const }));
  if (!entries.length || entries.length > 32) throw new Error("每批需要 1–32 条，请先调整段落。");
  return entries;
}

export function MemoryImport({ enabled, busy, identity, onSaved, recoveryOnly = false }: { recoveryOnly?: boolean; enabled: boolean; busy: boolean; identity: string; onSaved: () => void }) {
  const key = `serika:memory-import:${identity}`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Array<MemoryImportEntry & { selected: boolean }>>([]);
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null);
  const [receipt, setReceipt] = useState<MemoryImportReceipt | null>(null);
  const [pending, setPending] = useState<string | null>(() => window.localStorage.getItem(key));
  const [checkedMissing, setCheckedMissing] = useState(false);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const act = async (operation: () => Promise<void>) => {
    if (busy || inFlight.current) return;
    inFlight.current = true; setWorking(true); setNotice("");
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作未确认，请核对保存回执。"); }
    finally { inFlight.current = false; setWorking(false); }
  };
  const saved = (value: MemoryImportReceipt) => {
    setReceipt(value); setPending(null); window.localStorage.removeItem(key); setPreview(null); onSaved();
  };
  const confirm = async () => {
    if (!preview || pending) return;
    const input = { entries: preview.entries.map(({ text, kind }) => ({ text, kind })), snapshot: preview.snapshot };
    await act(async () => {
      const result = await submitCreation(window.localStorage, `${identity}:memory`, input, async operationId => {
        window.localStorage.setItem(key, operationId); setPending(operationId);
        return window.runloom.confirmMemoryImport({ ...input, operationId });
      });
      if (result.ok) saved(result.value);
      else if (result.error.code === "MEMORY_COMMIT_UNCERTAIN" || result.error.code === "WRITE_FAILED") setNotice("保存结果待核对。请查询回执，不要重新提交。");
      else { window.localStorage.removeItem(key); setPending(null); setPreview(null); setNotice(result.error.message); }
    });
  };
  const edit = (index: number, value: Partial<typeof entries[number]>) => { setPreview(null); setEntries(entries.map((entry, i) => i === index ? { ...entry, ...value } : entry)); };
  if (recoveryOnly && !pending && !receipt) return null;
  return <section className="memory-import">
    <button type="button" className="personal-entry-card" aria-expanded={open} disabled={!enabled || busy || working} onClick={() => setOpen(!open)}><EntryCardContent title={recoveryOnly ? "旧导入记录" : "导入记忆"} description={recoveryOnly ? "核对之前尚未确认的保存结果。" : "粘贴或选择文本，预览后保存。"} /></button>
    {pending && !open ? <p className="error" role="status">有一批导入需要核对。<button className="ghost" onClick={() => setOpen(true)}>查看保存回执</button></p> : null}
    {open ? <div className="card" aria-label="导入记忆">
      <p className="hint">粘贴文本或选择 .txt / .md 文件，按空行拆分。预览确认后保存到当前工作区。</p>
      {!pending && !receipt ? <>
        <label className="memory-import-file">选择文本文件<input type="file" accept=".txt,.md,text/plain,text/markdown" disabled={working || busy} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          void act(async () => { if (!/\.(txt|md)$/i.test(file.name) || file.size > 64 * 1024) throw new Error("请选择不超过 64 KiB 的 .txt 或 .md 文件。"); setText(await file.text()); setEntries([]); setPreview(null); });
        }} /></label>
        <textarea aria-label="待导入文本" value={text} disabled={working} placeholder="在这里粘贴要记住的内容，每条之间空一行" onChange={event => { setText(event.target.value); setPreview(null); }} />
        <button className="ghost" disabled={busy || working || !text.trim()} onClick={() => void act(async () => { setEntries(splitImportText(text).map(entry => ({ ...entry, selected: true }))); setPreview(null); })}>按段落整理</button>
        {entries.map((entry, index) => <div className="import-entry" key={index}>
          <label><input type="checkbox" checked={entry.selected} disabled={working} onChange={event => edit(index, { selected: event.target.checked })} />保存第 {index + 1} 条</label>
          <textarea aria-label={`第 ${index + 1} 条记忆`} value={entry.text} disabled={working} onChange={event => edit(index, { text: event.target.value })} />
          <div className="memory-actions"><select aria-label={`第 ${index + 1} 条类型`} value={entry.kind} disabled={working} onChange={event => edit(index, { kind: event.target.value as MemoryImportEntry["kind"] })}>{Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select><span className={bytes(entry.text) > 2048 ? "error" : "hint"}>{bytes(entry.text)} / 2048 字节</span>
            <button className="ghost" disabled={working} onClick={() => { setEntries(entries.filter((_, i) => i !== index)); setPreview(null); }}>删除</button>
            <button className="ghost" disabled={working || index === 0} onClick={() => { setEntries(entries.flatMap((value, i) => i === index - 1 ? [{ ...value, text: `${value.text}\n\n${entry.text}` }] : i === index ? [] : [value])); setPreview(null); }}>合并到上一条</button>
            <button className="ghost" disabled={working || !entry.text.includes("\n")} onClick={() => { const parts = entry.text.split(/\n+/).map(text => text.trim()).filter(Boolean); setEntries(entries.flatMap((value, i) => i === index ? parts.map(text => ({ ...entry, text })) : [value])); setPreview(null); }}>按换行拆开</button>
          </div>
        </div>)}
        {entries.length ? <button disabled={busy || working || entries.filter(entry => entry.selected).length === 0} onClick={() => void act(async () => {
          const result = await window.runloom.previewMemoryImport(entries.filter(entry => entry.selected).map(({ text, kind }) => ({ text, kind })));
          if (!result.ok) throw new Error(result.error.message); setPreview(result.value);
        })}>预览选中内容</button> : null}
        {preview ? <div className="memory-setup-preview"><strong>确认保存到当前工作区</strong><p className="hint">已保存 {preview.stored} 条，还可新增 {preview.available} 条。完全相同的有效记忆会跳过；不同内容不会覆盖，已停用或撤回的记忆不会重新启用。</p><ul>{preview.entries.map((entry, index) => <li key={index}><strong>{entry.existingId ? "已存在，跳过" : "新增"}</strong> · {entry.text}</li>)}</ul><button disabled={busy || working} onClick={() => void confirm()}>确认导入 {preview.entries.length} 条</button></div> : null}
        <button className="ghost" disabled={working} onClick={() => { setOpen(false); setText(""); setEntries([]); setPreview(null); setNotice(""); }}>取消导入</button>
      </> : null}
      {pending ? <div role="status"><p>这批导入的保存结果尚未确认。只查询回执，不会重复写入。</p><button className="ghost" disabled={busy || working} onClick={() => void act(async () => {
        const result = await window.runloom.getMemoryImportReceipt(pending);
        if (!result.ok) throw new Error(result.error.message);
        if (result.value) saved(result.value); else { setCheckedMissing(true); setNotice("当前操作已结束，未查到这批保存回执。可结束核对后重新预览；不会自动提交。"); }
      })}>查询保存回执</button>{checkedMissing ? <button className="ghost" disabled={busy || working} onClick={() => { window.localStorage.removeItem(key); setPending(null); setCheckedMissing(false); setPreview(null); setNotice(""); }}>结束核对，重新预览</button> : null}</div> : null}
      {receipt ? <div role="status"><strong>已导入：新增 {receipt.items.filter(item => item.status === "saved").length} 条，跳过 {receipt.items.filter(item => item.status === "existing").length} 条</strong><p className="hint">这是当次保存回执。之后的编辑、停用或删除以当前记忆列表为准。</p><button className="ghost" onClick={() => { setReceipt(null); setEntries([]); setText(""); }}>继续导入</button></div> : null}
      {notice ? <p className="error" role="alert">{notice}</p> : null}
    </div> : null}
  </section>;
}
