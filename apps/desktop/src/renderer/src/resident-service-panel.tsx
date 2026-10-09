import React, { useRef, useState } from "react";
import type { ResidentServiceState } from "../../shared/resident-service.js";

export function residentServiceLabel(state: ResidentServiceState | null): string {
  if (!state) return "尚未查询";
  if (!state.ok) return "状态未确认";
  if (!state.registered) return "未启用 · 退出桌面会结束助手";
  if (!state.compatible) return "配置不匹配 · 请处理后再使用";
  return state.running ? "常驻进程运行中" : "已注册 · 当前进程未运行";
}

/** Main owns service authority; this panel sends only an explicit boolean decision. */
export function ResidentServicePanel({ status, busy, refresh, setEnabled }: {
  status: ResidentServiceState | null;
  busy: boolean;
  refresh: () => Promise<ResidentServiceState>;
  setEnabled: (enabled: boolean) => Promise<ResidentServiceState>;
}) {
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const act = async (enabled?: boolean) => {
    if (inFlight.current || (enabled !== undefined && busy)) return;
    inFlight.current = true; setWorking(true); setNotice("");
    try {
      const result = enabled === undefined ? await refresh() : await setEnabled(enabled);
      setNotice(result.ok ? enabled === undefined ? "状态已刷新。" : enabled
        ? "已请求启用；进程状态与助手连接就绪分别核对。"
        : "常驻助手已停止。任务、对话和记忆保留；独立后台提醒不受影响。"
        : result.message ?? "操作未确认，请刷新状态。");
      if (result.ok) setPreview(null);
    } catch { setNotice("操作结果未确认，请刷新状态；不会自动重试。"); }
    finally { inFlight.current = false; setWorking(false); }
  };
  const registered = status?.ok === true && status.registered;
  return <section className="card" aria-label="退出桌面后继续工作">
    <div className="card-head"><span>退出桌面后继续工作</span><button className="ghost" disabled={working} onClick={() => void act()}>刷新状态</button></div>
    <p role="status">{residentServiceLabel(status)}</p>
    {status?.message ? <p className="hint">{status.message}</p> : null}
    <p className="hint">显式启用后，助手在本机独立运行；关闭窗口或退出桌面不结束已批准的操作。首次切换常驻模式或停止服务前，请先结束番茄钟，不会自动结束或转移计时。新的工具请求仍需确认，不会自动扩大权限。Mac 需保持运行与联网；这不保证崩溃后计时恢复或睡眠期间准点提醒。</p>
    <div className="memory-actions">
      <button className="ghost" disabled={busy || working || status?.ok !== true || registered || !status.compatible} onClick={() => setPreview(true)}>启用常驻助手…</button>
      <button className="ghost" disabled={busy || working || !registered} onClick={() => setPreview(false)}>停止常驻助手…</button>
    </div>
    {busy ? <p className="hint">请先结束当前执行、确认或整理，再切换常驻模式。</p> : null}
    {preview !== null ? <div className="memory-setup-preview" role="group" aria-label="常驻助手授权预览">
      <strong>{preview ? "启用当前工作区的常驻助手" : "停止当前工作区的常驻助手"}</strong>
      <p>{preview ? "请先结束当前番茄钟。允许助手退出桌面后继续运行，并由 macOS 登录服务启动。已有模型、工具权限和预算保持不变，网络与模型使用可能产生费用。不会自动注册 Telegram 或更改后台提醒服务。" : "请先结束当前番茄钟和执行，再停止常驻助手；不会替你结束计时。停止成功后界面恢复桌面内运行。未知副作用不会自动重做，任务、历史、记忆和独立后台安排不会删除。"}</p>
      <div className="memory-actions"><button disabled={busy || working} onClick={() => void act(preview)}>确认{preview ? "启用" : "停止"}</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>取消</button></div>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
