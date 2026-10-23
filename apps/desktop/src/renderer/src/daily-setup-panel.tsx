import React, { useState } from "react";
import type { AppInfo } from "../../shared/ui-contract.js";
import { memorySetupChanges, memorySetupNeeded } from "./daily-setup.js";

export function MemorySetup({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [preview, setPreview] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  if (!memorySetupNeeded(info)) return <p className="hint">自动整理已开启。保存后可查看来源和撤回。</p>;
  const confirm = async () => {
    if (busy || working || !preview) return;
    setWorking(true); setError("");
    try { await window.runloom.enableMemory(); setPreview(false); }
    catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };
  return <div className="memory-setup">
    {!preview ? <button disabled={busy || !info.workspaceRoot || !info.configPath} onClick={() => setPreview(true)}>设置日用记忆</button> : <div className="memory-setup-preview" role="group" aria-label="记忆配置变更预览">
      <strong>确认修改当前配置</strong>
      <p className="hint">配置文件：<code>{info.configPath}</code></p>
      <ul>{memorySetupChanges(info).map(change => <li key={change}>{change}</li>)}</ul>
      <p className="hint">记忆整理会使用当前模型，产生费用。</p>
      <p className="hint">只从已提交的用户原话沉淀，保留来源与版本。模型会筛选长期信息；有歧义或冲突时仍需要你判断。程序会拦截已识别的凭据与拒绝保存表达，但无法保证识别所有敏感信息；敏感消息请勾选“本条不整理为记忆”。写入后可以查看和撤回。</p>
      <p className="hint">可选择本条消息“不参与记忆”；不会搬动旧对话或修改其他模块；启用后重新加载当前会话。</p>
      <div className="memory-actions"><button disabled={busy || working} onClick={() => void confirm()}>{working ? "正在应用…" : "确认启用"}</button><button className="ghost" disabled={working} onClick={() => { setPreview(false); setError(""); }}>暂不修改</button></div>
    </div>}
    {!info.workspaceRoot ? <p className="hint">请先在当前配置中设置 authorizedDirectory，再重启。不会自动换到另一个工作区。</p> : null}
    {!info.configPath ? <p className="hint">当前没有可修改的配置文件。</p> : null}
    {error ? <p className="error" role="alert">{error}。请核对当前配置后重试。</p> : null}
  </div>;
}
