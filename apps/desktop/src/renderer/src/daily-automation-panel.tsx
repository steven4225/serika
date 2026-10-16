import { useEffect, useRef, useState } from "react";
import type { NotificationReadinessStatus, RssWorkerResponse } from "../../shared/ui-contract.js";
import { backgroundActionAllowed, backgroundServiceLabel, notificationPermissionLabel } from "./daily-automation.js";
import { NotificationSettingsButton } from "./notification-settings-button.js";

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
    if (!backgroundActionAllowed(action, enabled, busy, working)) return;
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
  return <><section className="card" aria-label="系统通知">
    <div className="card-head"><span>系统通知</span><button className="ghost" disabled={working} onClick={() => void refresh()}>刷新状态</button></div>
    <p role="status">{notificationPermissionLabel(permission)}</p>
    <div className="memory-actions">
      <button className="ghost" disabled={busy || working || permission?.helperConfigured !== true} onClick={() => void act("test")}>{working ? "正在处理…" : "发送测试通知"}</button>
      <NotificationSettingsButton />
    </div>
    {permission && permission.authorization !== "authorized" ? <p className="hint">{permission.helperConfigured ? "可在 macOS 通知设置中核对权限。" : "通知组件尚未就绪，请查看配置诊断。"}结果也可在「任务 → 提醒」查看。</p> : null}
    {permission?.message && permission.authorization !== "authorized" ? <details><summary>通知配置诊断</summary><p className="hint">{permission.message}</p></details> : null}
    <details><summary>收不到弹窗？</summary><p className="hint">检查 macOS 通知设置和专注模式。通知提交只表示系统接受请求，不能证明你已看到。</p></details>
  </section><section className="card" aria-label="后台提醒">
    <div className="card-head"><span>后台提醒</span></div>
    <p role="status">{backgroundServiceLabel(worker)}</p>
    <p className="hint">处理已经保存的到期提醒和定期安排。独立服务运行时，关闭窗口或退出桌面仍可处理；Mac 需保持运行。</p>
    {worker?.ok && worker.setupReady === false ? <div className="background-recovery" role="status"><strong>定时提醒尚未就绪</strong><p>后台服务配置与当前应用不匹配，已保存的提醒、规划和 RSS 检查可能无法按时执行。</p><p>先点击“停用后台提醒”并确认，确认已停用后再点击“启用后台提醒”。这不会删除安排；如果操作失败，请查看下方配置诊断。</p></div> : null}
    {worker && (!worker.ok || worker.configurationMessage) ? <details><summary>配置诊断</summary><p className="hint">{worker.ok ? worker.configurationMessage : worker.message}</p></details> : null}
    <div className="memory-actions">
      <button className="ghost" disabled={busy || working || !enabled || worker?.ok !== true || worker.registered} onClick={() => setPreview(true)}>启用后台提醒…</button>
      <button className="ghost" disabled={busy || working || worker?.ok !== true || !worker.registered} onClick={() => setPreview(false)}>停用后台提醒…</button>
    </div>
    {!enabled ? <p className="hint">当前任务模块关闭，不能创建新安排。已保存的安排与后台服务不会因此停用；仍可在这里显式停用服务。</p> : null}
    {enabled && worker?.ok === true && !worker.registered ? <p className="hint">任务模块开启只允许保存安排，不会自动开启后台执行。请点击“启用后台提醒”并确认，再依赖关窗后的提醒。</p> : null}
    {preview !== null ? <div className="memory-setup-preview" role="group" aria-label="后台提醒授权预览">
      <strong>{preview ? "启用当前工作区的独立后台服务" : "停用当前工作区的后台服务"}</strong>
      <p>{preview ? "允许它在关窗口或退出应用后处理当前工作区的到期任务并提交系统通知；已绑定的 RSS 和已配置的只读 Todoist 任务可能请求网络与模型、产生费用。不获得 Shell 或文件写入权限。" : "停止当前工作区的提醒、日报和 RSS 后台执行；已有结果不删除。"}</p>
      <div className="memory-actions"><button disabled={busy || working} onClick={() => void act(preview ? "enable" : "disable")}>确认{preview ? "启用" : "停用"}</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>取消</button></div>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section></>;
}
