import { useEffect, useState } from "react";
import type { RestorePreview, RestoreResult } from "../../shared/backup.js";
export function BackupPanel({ busy }: { busy: boolean }) {
  const [working, setWorking] = useState(false), [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null), [restored, setRestored] = useState<RestoreResult | null>(null);
  const [originalWorkspace, setOriginalWorkspace] = useState<string | null>(null), [activatePreview, setActivatePreview] = useState<"activate" | "return" | null>(null);
  useEffect(() => { void window.runloom.info().then(info => setOriginalWorkspace(info.recoveryWorkspace?.originalWorkspace ?? null)).catch(() => {}); }, []);
  const perform = async (action: "backup" | "preview" | "restore" | "activate" | "return") => {
    if (busy || working) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      if (action === "preview") {
        if (!window.runloom.previewRestoreData) throw new Error("请重启应用加载恢复预览入口");
        const next = await window.runloom.previewRestoreData();
        if (next) { setPreview(next); setRestored(null); setActivatePreview(null); }
      } else if (action === "activate" || action === "return") {
        if (!window.runloom.activateRestoreData) throw new Error("恢复接回入口尚未加载，请重启");
        // This button explicitly consents to stopping the foreground resident
        // owner. Timers/busy state are still rechecked by the real host.
        const service = await window.runloom.residentStatus?.();
        if (service && !service.ok) throw new Error(service.message ?? "常驻状态未确认，未切换");
        if (service?.registered) {
          const stopped = await window.runloom.setResidentEnabled!(false);
          if (!stopped.ok || stopped.registered) throw new Error(stopped.message ?? "常驻助手尚未停止，未切换");
        }
        await window.runloom.activateRestoreData(action === "return" ? null : preview!.id);
      } else {
        const result = action === "restore" ? await window.runloom.restoreData(preview!.id) : await window.runloom.backupData();
        if (result) {
          if (action === "restore") setRestored(result as RestoreResult);
          setMessage(`${action === "restore" ? "恢复副本已保存，原数据未覆盖、旧任务未启动" : "备份已保存"}：${result.path}（${result.threads} 个对话，${result.files} 个数据文件）`);
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，未确认备份或恢复成功"); }
    finally { setWorking(false); }
  };
  return <section aria-label="数据备份与恢复">
    <h3>数据备份与恢复</h3>
    <p className="hint">备份当前工作区的对话、记忆、快照、任务和回执；不包含项目文件、配置、API key 或 Telegram 凭据文件。正文仍可能含有你写过的敏感信息，请保存在可信位置。</p>
    <p className="hint">备份时锁住相关存储写入；若正在写入则请稍后重试，不导出部分备份。恢复先预览，再创建新副本；旧单次排期取消、重复排期暂停，不恢复授权或连接。项目文件仍需另外备份。</p>
    {originalWorkspace ? <div className="memory-setup-preview"><strong>当前是恢复工作区</strong><p>原工作区仍在：{originalWorkspace}。独立后台安排不会因界面切换自动停止；恢复区默认未接通后台服务和 Telegram。</p><button className="ghost" disabled={busy || working} onClick={() => setActivatePreview("return")}>返回原工作区…</button></div> : null}
    <div className="actions"><button className="ghost" disabled={busy || working} onClick={() => void perform("backup")}>导出备份</button><button className="ghost" disabled={busy || working} onClick={() => void perform("preview")}>选择备份恢复…</button></div>
    {preview && !restored ? <div className="memory-setup-preview"><strong>核对恢复范围</strong><p>来源工作区：{preview.originWorkspace}</p><p>{preview.createdAt} · {preview.threads} 个对话 · {preview.files} 个数据文件</p><p className="hint">包含：{preview.stores.map(name => ({ "memory.json": "记忆", "tasks.json": "安排", "work-tasks.json": "工作任务", "checkpoint.json": "快照", "rss.json": "RSS", "dreaming.json": "经验方法" })[name] ?? name).join("、") || "已保存的对话与回执"}。不会覆盖原数据，也不带入凭据。</p><button className="ghost" disabled={busy || working} onClick={() => void perform("restore")}>确认范围并选择保存位置</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>取消</button></div> : null}
    {restored ? <button className="ghost" disabled={busy || working} onClick={() => setActivatePreview("activate")}>打开恢复工作区…</button> : null}
    {activatePreview ? <div className="memory-setup-preview"><strong>{activatePreview === "return" ? "返回原工作区？" : "接回恢复后的对话和记忆？"}</strong><p>当前主助手将停止并在所选工作区重新连接；若有番茄钟或执行则拒绝切换。已有独立后台 worker 不随此切换停止；恢复区不会自动连接 Telegram 或开启服务。原对话和已保存草稿保留。</p><button className="ghost" disabled={busy || working} onClick={() => void perform(activatePreview)}>{activatePreview === "return" ? "确认返回原工作区" : "确认停止主常驻助手并接回"}</button><button className="ghost" disabled={working} onClick={() => setActivatePreview(null)}>取消</button></div> : null}
    {working ? <p role="status">正在处理，请勿退出…</p> : null}
    {message ? <p role="status">{message}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
