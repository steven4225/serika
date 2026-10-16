import type { AppInfo } from "../../shared/ui-contract.js";
import { useState } from "react";
import { memoryAutomationLabel } from "./memory-copy.js";

const labels: Record<string, [string, string]> = {
  pomodoro: ["番茄钟", "开始、查看和取消专注计时。"],
  "read-file": ["工作区文件", "读取、创建和编辑工作区文件，操作受现有权限约束。"],
  memory: ["长期记忆", "记住你的偏好与事实，在之后的对话中按需引用。"],
  checkpoint: ["项目快照", "保存工作意图，通过 /resume 核对 Git 现状。"],
  task: ["定时任务", "一次性与重复排期、改期、结果 inbox；执行需要 worker。"],
  todoist: ["Todoist", "查询外部任务；还需要有效的服务凭据。"],
  shell: ["命令执行", "运行 Shell，展示进度与执行回执。"],
  web: ["网页与信息来源", "获取公开网页，搜索与 RSS 另有配置开关。"],
  computer: ["本机应用控制", "仅控制配置允许的应用；需要驱动与系统权限。"],
};

const moduleName = (id: string) => labels[id]?.[0] ?? "这项能力";

export function CapabilitiesPanel({ info, busy = false, initialError = null, intro }: { info: AppInfo; busy?: boolean; initialError?: string | null; intro?: string }) {
  const unavailable = info.runtimeRecovery !== undefined;
  const [selection, setSelection] = useState<{ id: string; enabled: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError ? `未应用：${initialError}` : null);
  const apply = async () => {
    if (!selection || busy || unavailable || saving || !window.runloom.setModuleEnabled) return;
    setSaving(true); setError(null);
    try {
      await window.runloom.setModuleEnabled({ ...selection, expectedEnabled: !selection.enabled });
    } catch (cause) { setError(`未应用：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setSaving(false); }
  };
    return <section className="capability-page">
    <p>{intro ?? "选择这位助手可以使用的能力。更改会保存到当前配置，并在空闲时应用，当前对话不会删除。"}</p>
    {busy ? <p className="hint" role="status">当前正在处理，结束后才能更改能力。</p> : null}
    {unavailable ? <p className="error" role="status">连接未恢复。以下是上次连接的配置，不能当作当前生效状态；重新连接后再更改能力。</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {selection ? <div className="capability-confirm" role="group" aria-label="确认能力变更">
      <strong>{selection.enabled ? "开启" : "关闭"}{moduleName(selection.id)}？</strong>
      {selection.id !== "pomodoro" ? <p className="hint">空闲时重新加载助手能力。番茄钟和已有后台安排继续，当前对话和未发送草稿保留。</p> : null}
      <p>{selection.id === "task" ? "只更改助手创建和查询安排的能力；已保存的安排和后台服务继续运行。暂停安排请到工作区的自动安排中操作。" : selection.id === "memory" ? "关闭后不再引用记忆或整理记忆，已保存的记忆和候选不会删除。重新开启沿用原来的写入策略。" : selection.id === "pomodoro" ? (selection.enabled ? "重新开启计时能力，不恢复之前已经结束的计时。" : "关闭并结束当前计时；重新开启不会恢复原计时。") : "下一次对话将使用新的能力配置。已保存的数据保留，工具操作仍按原权限逐次确认。"}</p>
      <div className="actions"><button disabled={busy || unavailable || saving} onClick={() => void apply()}>{saving ? "正在应用…" : "保存并应用"}</button><button className="ghost" disabled={saving} onClick={() => { setSelection(null); setError(null); }}>取消</button></div>
    </div> : null}
    <div className="capability-list">{info.modules?.map(module => {
      const [name, description] = labels[module.id] ?? ["这项能力", "当前配置里的一项能力。"];
      return <div className="capability-row" key={module.id}>
        <div><strong>{name}</strong><p>{description}</p><details className="capability-technical"><summary>内部标识</summary><code>{module.id}</code></details>
          {module.id === "memory" ? <small>{memoryAutomationLabel(info.memory)}</small> : null}
          {module.id === "web" && module.enabled ? <small>搜索：{info.moduleOptions?.webSearch ? "已开启" : "未开启"} · RSS：{info.moduleOptions?.webFeed ? "已开启" : "未开启"}</small> : null}
          {module.id === "task" ? <small>开启这里不会注册后台服务；关窗提醒请到“设置 → 通知 → 关窗口后继续提醒”显式启用，并单独核对通知授权。</small> : null}
          {module.id === "todoist" && !module.enabled ? <small>当前无法查询 Todoist。开启前需在可信环境文件中设置 TODOIST_API_TOKEN；应用不会替你创建凭据。</small> : null}
          {module.id === "computer" ? <small>{!module.enabled ? "当前不会控制本机应用。" : "驱动和 macOS 权限仍需就绪。"}允许的应用：{info.computer.allowedBundleIds.length} 个；能力开关不会自动增添应用或申请系统权限。</small> : null}
          {info.capabilities ? <details className="capability-technical"><summary>实际工具与就绪情况</summary>
            <p>当前注册：{info.capabilities.modules.find(item => item.id === module.id)?.registeredTools.join("、") || "未注册对话工具"}</p>
            {module.id === "computer" ? <p>驱动连接和系统权限尚未实际检查；不会自动启动驱动、申请权限或读取其他应用。</p> : null}
            {module.id === "shell" ? <p>{info.capabilities.shell.warning} 命令配方可通过 /recipes 查看，执行仍需本次批准。</p> : null}
          </details> : null}
        </div><div className="capability-control"><span className={`capability-status ${module.enabled ? "enabled" : ""}`}>{module.enabled ? "已开启" : "已关闭"}</span>
          <button className="ghost" disabled={busy || unavailable || saving || !info.configPath || typeof window === "undefined" || !window.runloom.setModuleEnabled} aria-label={`${module.enabled ? "关闭" : "开启"}${name}`} onClick={() => { setSelection({ id: module.id, enabled: !module.enabled }); setError(null); }}>{module.enabled ? "关闭" : "开启"}</button>
        </div>
      </div>;
    }) ?? <p>未收到模块配置，请重新连接。</p>}{info.modules?.length === 0 ? <p>这里没有可开关的项目。</p> : null}</div>
    <p className="hint">开启能力不等于授权执行。尚未配置的外部能力需要先设置凭据、驱动或允许的应用，不会自动安装或申请系统权限。</p>
    <details><summary>配置位置</summary><p className="hint">{info.configPath ?? "未指定"}</p></details>
  </section>;
}
