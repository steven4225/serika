import type { AppInfo } from "../../shared/ui-contract.js";

const labels: Record<string, [string, string]> = {
  pomodoro: ["番茄钟", "开始、查看和取消专注计时。"],
  "read-file": ["工作区文件", "读取、创建和编辑工作区文件，操作受现有权限约束。"],
  memory: ["长期记忆", "检索正式记忆，提取候选并由你审核。"],
  checkpoint: ["项目快照", "保存工作意图，通过 /resume 核对 Git 现状。"],
  task: ["定时任务", "一次性与重复排期、改期、结果 inbox；执行需要 worker。"],
  todoist: ["Todoist", "查询外部任务；还需要有效的服务凭据。"],
  shell: ["命令执行", "运行 Shell，展示进度与执行回执。"],
  web: ["网页与信息来源", "获取公开网页，搜索与 RSS 另有配置开关。"],
  computer: ["本机应用控制", "仅控制配置允许的应用；需要驱动与系统权限。"],
};

export function CapabilitiesPanel({ info }: { info: AppInfo }) {
  return <section className="capability-page">
    <p className="hint">这里展示项目内置模块及本进程的配置，不代表工具已授权、外部服务可用或后台正在运行。</p>
    <div className="capability-list">{info.modules?.map(module => {
      const [name, description] = labels[module.id] ?? [module.id, "内置模块"];
      return <div className="capability-row" key={module.id}>
        <div><strong>{name}</strong><p>{description}</p><small>{module.id}</small>
          {module.id === "memory" && module.enabled ? <small>自动提取候选：{info.moduleOptions?.autoConsolidate ? "已开启" : "未开启"}</small> : null}
          {module.id === "web" && module.enabled ? <small>搜索：{info.moduleOptions?.webSearch ? "已开启" : "未开启"} · RSS：{info.moduleOptions?.webFeed ? "已开启" : "未开启"}</small> : null}
        </div><span className={`capability-status ${module.enabled ? "enabled" : ""}`}>{module.enabled ? "本次已启用" : "未启用"}</span>
      </div>;
    }) ?? <p>未收到模块配置，请重新连接。</p>}</div>
    <p className="hint">配置文件：{info.configPath ?? "未指定"}。修改配置后需重启；此页不会替你开启模块。</p>
  </section>;
}
