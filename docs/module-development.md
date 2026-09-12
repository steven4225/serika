# 内置模块接入约定

本文是 Runloom 当前 CLI 模块的短指南，不是插件 SDK，也不是第二份数据契约。接口和行为以源码为准：

- [module-host.ts](../examples/cli/src/module-host.ts)：模块生命周期与注册上下文
- [tui-module-config.ts](../examples/cli/src/tui-module-config.ts)：TUI 配置解析
- [index.ts](../examples/cli/src/index.ts)：TUI 应用层装配、确认链与 `/modules`
- [task-worker-entry.ts](../examples/cli/src/task-worker-entry.ts)：后台 worker 的显式工具清单
- [read-file-module.ts](../examples/cli/src/modules/read-file-module.ts) 和 [todoist-module.ts](../examples/cli/src/modules/todoist-module.ts)：现有接入实例

## 一条接入路径

新增或调整内置模块时，沿着这一条路径检查：

```text
工厂注入依赖
  -> setup(context) 注册工具/命令
  -> TUI 配置启用，或 worker 显式列入清单
  -> 工具/命令在实际调用时执行
  -> host.dispose() 逆序释放资源
```

### 1. 工厂注入

模块工厂只接收它实际需要的依赖。例如：

- `createReadFileModule(workspaceRoot)` 把工作区传给文件工具；
- `createTodoistModule({ apiToken, timeZone, ... })` 把凭据、时区和可选 HTTP/时钟依赖传给 Todoist 模块。

凭据由入口从环境变量读取，不放进模型工具参数、配置示例或 transcript。不需要统一依赖容器。

### 2. `setup` 注册

工厂返回 `AgentModule`，由 `createModuleHost` 调用 `setup`：

```ts
const host = createModuleHost(
  [createReadFileModule(workspaceRoot), createTodoistModule(todoistOptions)],
  { notify: (moduleId, message) => output.write(`[${moduleId}] ${message}`) },
);
```

`setup` 只完成注册和初始化准备，不调用模型，也不在启动阶段查询 Todoist。模块通过 `context.registerTool` 注册 `RegisteredTool`，通过 `context.registerCommand` 注册空闲态命令，需要显示信息时使用 `context.notify`。

注册窗口在 `setup` 返回后关闭；重复模块 ID 和命令名由 host 拒绝，重复工具名由现有 `ToolRegistry` 拒绝。不要在模块外再复制一套重复校验。

如果模块持有计时器、AbortController 或其他资源，`setup` 返回同步清理函数。host 会按注册逆序调用 `dispose`，且 `dispose` 可重复调用；在 `setup` 返回清理函数前抛错时，模块自己负责清理已经创建的资源。

### 3. 选择入口

TUI 的模块选择由 [tui-module-config.ts](../examples/cli/src/tui-module-config.ts) 的严格 `version: 1` 配置和入口装配决定。配置启用模块不会自动授权 worker；配置变更需要重启。

worker 不读取 TUI `--config`。后台能力只由 [task-worker-entry.ts](../examples/cli/src/task-worker-entry.ts) 的显式清单决定：当前 `--todoist` 只开放已经检查过的 `todoist_list_tasks`。不要按元数据 `risk: "read"` 自动开放其他工具，也不要把新增 TUI 模块默认为后台能力。

### 4. 工具与命令执行

工具继续使用各自的输入 schema 和输出结构。`todoist_list_tasks` 与 `write_file` 的成功形状不同，不要为整齐引入统一的 `Result<T>`，也不要新建类型文件复制现有契约。

命令的 `execute(args)` 是本地空闲态入口；它不自动创建 Run，也不自动写入 transcript。`/todoist list` 会联网，因此不能笼统宣称所有命令都是只读。`/modules` 和计算器 `add` 是 CLI 入口直接装配的能力，不是 `AgentModule`。

`RegisteredTool` 依赖当前 AI SDK adapter，模块属于 `examples/cli` 的应用层组合，不是跨运行时的插件 SDK。`ToolRisk`、`idempotent` 等元数据用于现有运行路径的描述，不自动形成沙箱或 Exactly Once 保证。

## 必须保留的边界

- TUI 的工具确认是 `y/n`；worker 使用启动时的白名单，不等待交互确认。
- 工具返回 `ok: false` 仍可能让 Run 以 `completed` 结束；这表示 Run 已结束，不等于业务成功。
- 工具注册不是安全隔离。模块只能获得入口传入的依赖，不能据此宣称权限边界已经建立。
- 文件副作用和 transcript 不是同一个事务；不要把“文件已写入”与“对话已记录”当成原子提交。
- 生产代码不做动态模块加载、包发现/安装或插件 manifest。确有外部模块需求时，另行冻结范围。

## 完成与验收口径

7-5 的完成证据是：本指南能从现有源码找到接入点，README 提供入口，相关已有检查有明确结果。它不代表 7-3、7-4 的真实 Todoist/模型验收已经完成。

真实验收缺凭据或独立目录时标记为“待验收”，不编造证据；若验收暴露运行时 bug，先记录复现和最小修复范围，再单独确认是否修改业务代码。
