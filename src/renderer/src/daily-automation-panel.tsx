import { useEffect, useRef, useState } from "react";
import type { NotificationReadinessStatus, RssWorkerResponse } from "../../shared/ui-contract.js";
import { backgroundServiceLabel, notificationPermissionLabel } from "./daily-automation.js";

/** Explicit setup in the user's workspace, not an automatic service on app launch. */
export function DailyAutomation({ enabled, busy }: { enabled: boolean; busy: boolean }) {
  const [worker, setWorker] = useState<RssWorkerResponse | null>(null);
  const [permission, setPermission] = useState<NotificationReadinessStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const refresh = async () => {
    const request = ++generation.current;
    const [service, notifications] = await Promise.all([
      window.runloom.rssWorkerStatus().catch(() => ({ ok: false as const, message: "后台服务查询失败，不代表服务不存在。" })),
      window.runloom.notificationStatus().catch(() => ({ helperConfigured: false, authorization: "unknown" as const, message: "通知状态查询失败。" })),
    ]);
    if (request !== generation.current) return;
    setWorker(service); setPermission(notifications);
  };
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  const act = async (action: "test" | "enable" | "disable") => {
    if (working || busy || (action !== "test" && !enabled)) return;
    setWorking(true); setNotice("");
    try {
      if (action === "test") setNotice((await window.runloom.testNotification()).message);
      else {
        const result = await window.runloom.setRssWorkerEnabled(action === "enable");
        setNotice(result.ok ? action === "enable" ? "已请求启用；以刷新后的后台状态为准。" : "后台服务已停用，已有结果保留。" : result.message);
      }
      setPreview(null); await refresh();
    } catch { setNotice("操作结果未确认，请刷新状态；不会自动重试或重建服务。"); }
    finally { setWorking(false); }
  };
  return <section className="card" aria-label="后台提醒与系统通知">
    <div className="card-head"><span>关窗口后继续提醒</span><button className="ghost" disabled={working} onClick={() => void refresh()}>刷新状态</button></div>
    <dl className="session-facts"><dt>后台</dt><dd>{backgroundServiceLabel(worker)}</dd><dt>系统通知</dt><dd>{notificationPermissionLabel(permission)}</dd></dl>
    {permission ? <p className="hint">{permission.message}</p> : null}
    <div className="memory-actions">
      <button className="ghost" disabled={busy || working || permission?.helperConfigured !== true} onClick={() => void act("test")}>{working ? "正在处理…" : "发送测试通知"}</button>
      <button className="ghost" disabled={busy || working || !enabled || worker?.ok !== true || worker.registered} onClick={() => setPreview(true)}>启用后台提醒…</button>
      <button className="ghost" disabled={busy || working || worker?.ok !== true || !worker.registered} onClick={() => setPreview(false)}>停用后台提醒…</button>
    </div>
    {!enabled ? <p className="hint">当前配置未启用任务模块，不能安排后台提醒。</p> : null}
    <p className="hint">测试只发送固定文案，不执行任务。首次可能出现 macOS 权限提示，请你自行允许；看到测试通知后，再在对话中说“两分钟后提醒我喝水”。通知是否可见也受专注模式影响。</p>
    {preview !== null ? <div className="memory-setup-preview" role="group" aria-label="后台提醒授权预览">
      <strong>{preview ? "启用当前工作区的独立后台服务" : "停用当前工作区的后台服务"}</strong>
      <p>{preview ? "允许它在关窗口或退出应用后处理当前工作区的到期任务并提交系统通知；已绑定的 RSS 和已配置的只读 Todoist 任务可能请求网络与模型、产生费用。不获得 Shell 或文件写入权限。" : "停止当前工作区的提醒、日报和 RSS 后台执行；已有结果不删除。"}</p>
      <div className="memory-actions"><button disabled={busy || working} onClick={() => void act(preview ? "enable" : "disable")}>确认{preview ? "启用" : "停用"}</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>取消</button></div>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
