import { ComputerConnectionSetting } from "./computer-connection-setting.js";
import { HerdrTargetSetting } from "./herdr-target-setting.js";
import type { AppInfo } from "../../shared/ui-contract.js";
import { useState } from "react";
import { memoryAutomationLabel } from "./memory-copy.js";

const labels: Record<string, [string, string]> = {
  pomodoro: ["番茄钟", "开始、查看和取消专注计时。"],
  "read-file": ["工作区文件", "读取、创建和编辑工作区文件，操作受现有权限约束。"],
  memory: ["长期记忆", "记住你的偏好与事实，在之后的对话中按需引用。"],
  checkpoint: ["项目快照", "保存工作意图，通过 /resume 核对 Git 现状。"],
  task: ["定时任务", "创建提醒与定期安排，由独立后台服务处理到期事项。"],
  todoist: ["Todoist", "查询外部任务；还需要有效的服务凭据。"],
  terminal: ["本地终端控制", "调用本机 CLI 或操作已选择的 Herdr 终端；桌面和 Telegram 每次都确认。"],
  shell: ["命令执行", "运行 Shell，展示进度与执行回执。"],
  web: ["网页与信息来源", "获取公开网页，搜索与 RSS 另有配置开关。"],
  computer: ["本机应用控制", "仅控制配置允许的应用；需要驱动与系统权限。"],
};

const moduleName = (id: string) => labels[id]?.[0] ?? "这项能力";

function AutonomySetting({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info.autonomy || typeof window === "undefined" || !window.runloom.setAutonomyEnabled) return null;
  const enabled = info.autonomy.enabled;
  const apply = async () => {
    setSaving(true); setError(null);
    try {
      await window.runloom.setAutonomyEnabled!({ enabled: !enabled, expectedEnabled: enabled });
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const locked = busy || saving || !!info.runtimeRecovery || !info.autonomy.directory;
  return <section className="capability-row" aria-label="本机自主执行">
    <div><strong>本机自主执行 · {enabled ? "已开启" : "已关闭"}</strong>
      <p>桌面聊天与任务可连续操作授权目录；自主命令使用 macOS Seatbelt，无需逐条确认。Telegram 和后台任务不继承此授权。</p>
      <small>当前工作区：{info.autonomy.directory ?? "未选择"}</small>
      {confirming ? <div className="capability-confirm" role="group" aria-label="确认自主执行变更">
        <strong>{enabled ? "关闭本机自主执行？" : "信任此工作区并开启本机自主执行？"}</strong>
        <p>Seatbelt 默认断网，仅授权目录和私密临时目录可写，运行时依赖只读，敏感路径不可访问。后端不可用会拒绝执行。需要联网或不支持的命令，请关闭自主执行，使用逐条确认的 host Shell。</p>
        <p>授权重启后仍有效，直到关闭。仅空闲时可更改；执行中可先停止。Telegram 和后台任务不继承此授权，其他工具保留原权限。</p>
        <p>开启后每轮最多 128 步、30 分钟，单条命令最长 10 分钟。未启用的工具不会自动开启。</p>
        <div className="actions"><button disabled={locked} onClick={() => void apply()}>{saving ? "正在应用…" : enabled ? "关闭并恢复逐次确认" : "信任并开启"}</button><button className="ghost" disabled={saving} onClick={() => setConfirming(false)}>取消</button></div>
      </div> : <button className="ghost" disabled={locked} onClick={() => { setConfirming(true); setError(null); }}>{enabled ? "关闭自主执行" : "开启自主执行"}</button>}
      {busy ? <p className="hint">执行结束或停止后才能更改授权。</p> : null}
      {error ? <p role="alert" className="error">{error}</p> : null}
    </div>
  </section>;
}

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
    <AutonomySetting info={info} busy={busy} />
    <ComputerConnectionSetting info={info} busy={busy} />
    {info.modules?.some(module => module.id === "terminal" && module.enabled) ? <HerdrTargetSetting key={JSON.stringify(info.terminalTarget ?? null)} info={info} busy={busy} /> : null}
    <p className="hint">{intro ?? "选择助手可以使用的内置功能。保存后重新加载当前对话，操作按当前授权执行。"}</p>
    {busy ? <p className="hint" role="status">当前正在处理，结束后才能更改能力。</p> : null}
    {unavailable ? <p className="error" role="status">连接未恢复。以下是上次连接的配置，不能当作当前生效状态；重新连接后再更改能力。</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {selection ? <div className="capability-confirm" role="group" aria-label="确认能力变更">
      <strong>{selection.enabled ? "开启" : "关闭"}{moduleName(selection.id)}？</strong>
      {selection.id !== "pomodoro" ? <p className="hint">空闲时重新加载助手能力。番茄钟和已有后台安排继续，当前对话和未发送草稿保留。</p> : null}
      <p>{selection.id === "task" ? "只更改助手创建和查询安排的能力；已保存的安排和后台服务继续运行。暂停安排请到任务页的定时安排中操作。" : selection.id === "memory" ? "关闭后不再引用记忆或整理记忆，已保存的记忆和候选不会删除。重新开启沿用原来的写入策略。" : selection.id === "pomodoro" ? (selection.enabled ? "重新开启计时能力，不恢复之前已经结束的计时。" : "关闭并结束当前计时；重新开启不会恢复原计时。") : "下一次对话将使用新的能力配置。已保存的数据保留，操作按当前授权执行。"}</p>
      <div className="actions"><button disabled={busy || unavailable || saving} onClick={() => void apply()}>{saving ? "正在应用…" : "保存并应用"}</button><button className="ghost" disabled={saving} onClick={() => { setSelection(null); setError(null); }}>取消</button></div>
    </div> : null}
    <div className="capability-list">{info.modules?.map(module => {
      const [name, description] = labels[module.id] ?? ["这项能力", "当前配置里的一项能力。"];
      return <div className="capability-row" key={module.id}>
        <div><strong>{name}</strong><p>{description}</p><details className="capability-technical"><summary>技术详情</summary><code>{module.id}</code></details>
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
