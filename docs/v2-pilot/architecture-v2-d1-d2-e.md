# d1+d2+e：隔离导入与旧配置清理

## 1. 改了什么

本轮相对 `a138c53`，源码提交按顺序为 `03f1a7a`（批准的冒烟输入迁移）、`1c3d326`（批准的检查器单行输入迁移）、`aefef90`（d1+d2+e 实现）。只在实验 worktree 工作，交付后停下等审核。

- `packages/assistant/scripts/home-import.mjs` 接受显式静态源、完整清单、scope 映射和新 H。默认 dry-run；显式执行后产生完整私密备份、迁移演练、实际回滚核对、原子发布与成功回执。导入器保留到真正切日用，届时另获授权，对新的一致快照重导。
- 外部配置统一为 `authorizedDirectory`、`desktopAutonomy.authorizedDirectory` 和 `telegramAutonomy.authorizedDirectory`。迁完 CLI、桌面、恢复配置、worker、Skill、示例与测试调用者后，删配置边界旧字段转换。运行时遇旧字段明确要求离线导入。
- 删除无效 `writePolicy` / `MemoryWritePolicy`、review/automatic 选项、桌面启动修补、policy-only UI 和无生产者的事件值。后台抽取只由 `autoConsolidate` 控制；WorkTask、TG 和 unknown 的人工核对语义保留。

## 2. 逐条对照验收项

| 要求 | 结果及证据 |
|---|---|
| 完整备份、演练、回滚三项核对 | 已做。导入器第一项测试及实际静态副本均核对文件清单、SHA、逻辑条数、权限模式、无多余文件；备份来自全源枚举，不把产品六-store 导出叫完整备份。符号链接只存链接值，不跟随读取 |
| 默认预览、幂等、冲突和中断恢复 | 已做。4 项 importer 测试全部通过；覆盖 8 个持久化边界，以及真实子进程在发布后退出 73。普通重跑拒绝未完成状态，显式 `--recover` 才恢复；成功回执先写临时文件再 fsync/rename。同源重复导入无内容或 mtime 变化，源变化/目标冲突停止 |
| 新隔离 H，只读已确认源 | 已做。最终目标为私密临时 `H-final`，不是日用 H。完整原副本清单前后相同，包含 v6-review 及原备份；源 memory SHA 与目标一致。首次演练 H 和最终 H 均保留，原副本未删除。见 [d2-final-checks.json](evidence/architecture-v2-d1-d2-e/d2-final-checks.json) |
| 三条偏好、三份项目文档暂在 user | 已做。6 条 entry、3 个 library document 均在导入回执中逐项记 `scope=user`、`暂时在 user`，保留 document 类型。当前仍是 v6，存储字段保持 workspace 原字节；c2 才升级格式和按用户提供路径归项目。本轮没有提前引入 v7 运行时 |
| 类别、正文、ID、来源、Thread 和回执 | 已做。preference 3、document 3、note 0，library document 3；Memory 全文件字节相等，含来源、ID、进度与已有回执。41 个注册 Thread ID 保留；19 份 transcript / 1436 条提交消息及 41 份 execution-records / 138 个 Run 的原样复制项全部 SHA 一致。源有 22 个注册 Thread 无已提交 transcript，逐个记录在私密回执，不编造消息 |
| 冷启动可读、不自动执行 | 已做。新进程用生产 Memory/JSONL reader 读全部已提交历史；桌面生产函数恢复 41 个注册 Thread、已保存的当前 Thread、13 份草稿。CLI `--home H-final --check` 退出 0；仅静态预检，不声明模型连通或 worker 存活。见 [desktop-cold-check.json](evidence/architecture-v2-d1-d2-e/desktop-cold-check.json) |
| 未完成任务和旧运行状态 | 已做。复用既有 `restoreTaskDocument`：scheduled 取消，running 标 interrupted，周期安排暂停，清掉待重试/待通知意图；原历史保留在备份。RSS 不启用，运行锁/token/服务配置仅归档，execution 回执原样留给原核对流程。源无业务 work-tasks.json；非空 WorkTask 源未显式映射目录时拒绝导入，防止隐藏核对记录。checkpoint 留备份待 c1 项目映射 |
| e 删除残留且不改写入语义 | 已做。`tui-module-config` 旧字段拒绝测试、`app.test` 自动整理开/关测试，以及现有记忆写入、uncertain、撤回、权限、crash 测试通过。无记忆审核模式运行入口；旧字段只由离线工具消费，内部项目 `workspaceRoot` 和持久 TG 数据字段不混改 |
| b0 逐字节不变 | 已做，SHA `b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670`。宿主工具与权限实际输出继续逐项比较；只剔除已退休的配置 mode 元数据，细节见 §5。原权限表亦未变 |
| 统一验证 | 已做，退出 0；两时区全套均 1762 通过 / 0 失败 / 7 跳过，eval 101/101，Electron 8/8。离线 32K/日用窗口用例包含其中；真实模型调用 0、费用 $0。实测 macOS，真实 Electron 加假模型脚本，未作 Linux/云端新 SHA 独立复现 |

## 3. 前后数字

相对 `a138c53`，按 Git numstat；当前 JSON 配置计产品，acceptance/eval/冒烟/统一验证脚本与 test runner 输入计测试。文档及证据不计代码，完整文件归类见 [line-changes.json](evidence/architecture-v2-d1-d2-e/line-changes.json)。

| 类别 | 增 | 删 | 净 |
|---|---:|---:|---:|
| 产品 | 53 | 101 | −48 |
| 迁移工具 | 258 | 0 | +258 |
| 测试及验证 | 298 | 275 | +23 |

迁移工具处于 d1+d2 合计估计范围 +220～380 内；测试净增小于合计估计，因为 e 同步删除退休模式断言，未删除测试文件。产品净减 48，比合计预估 −180～−50 的上界多 2 行；物理数据路径已由 a/b1 完成，本轮产品剩余多数为字段迁移和删参数，统计还包含当前 JSON 配置。

| 实测 macOS | 通过 | 失败 | 跳过 | 总数 |
|---|---:|---:|---:|---:|
| UTC 全套 | 1762 | 0 | 7 | 1769 |
| 上海全套 | 1762 | 0 | 7 | 1769 |
| eval | 101 | 0 | 0 | 101 |
| 真实 Electron + 假模型脚本 | 8 | 0 | 0 | 8 |

人工核对了保存回执与重启后记忆截图，前者显示“已保存/撤销”，后者保留同一条记忆；8 张截图及逐文件 SHA 一并保留。

## 4. 实际命令与退出码

下面 `SOURCE` 只代表用户指定静态副本中的 v6-review，`H` 代表全新私密临时 H，`PLAN` 是受限私密清单。导入私密日志仅本机保留；[command-evidence.json](evidence/architecture-v2-d1-d2-e/command-evidence.json) 保存命令结果摘要与日志 SHA，公开 d2 证据不含用户正文、来源 Thread ID 或私密路径。

| 命令 | 退出码 / 结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `node --check apps/desktop/scripts/electron-smoke.mjs`，`node --check packages/assistant/scripts/cm-step6-verify.mjs`，`node --check examples/eval/cm-step6-live.mjs` | 均 0 |
| `node --test packages/assistant/scripts/home-import.test.mjs` | 0，4/4 |
| `node --test --test-name-pattern='actual Controller archives' examples/eval/cm-step6-live.test.mjs` | 0，实际 Controller 测试 1/1 |
| `node packages/assistant/scripts/home-import.mjs --source SOURCE --home H --manifest PLAN` | 最终 0，dry-run |
| 同上加 `--execute` | 0，passed；备份/回滚五项全 true |
| 本机冷读取核对脚本，均显式 `--home H` | 0；Memory/JSONL/桌面 reader，重复导入及源前后清单一致 |
| `node apps/cli/dist/index.js --home H --check` | 0；静态预检，无网络、Run 或 worker |
| `SERIKA_CM6_VERIFY_OUTPUT=<checkout 外目录> node packages/assistant/scripts/cm-step6-verify.mjs` | **0**，typecheck、两时区全套、eval、Electron 冒烟、离线审计全部退出 0 |
| `git diff --check` | 0 |

统一验证绑定干净源码 `aefef90`；完整命令、退出码、日志 SHA 和源码 hash 见 [verification.json](evidence/architecture-v2-d1-d2-e/unified/verification.json)。`unified/live.json` 是离线审计读取已提交的旧实模证据后产生的投影，内含原日期/费用，不是本轮新调用；本轮以 verification.json 的 0 调用/$0 为准。所有产品子进程显式传临时 `--home`；编译器/Node 测试 runner 无 home 参数，进程内夹具显式指定数据路径。

### 获批的冻结输入变更

两项均单独提交；完整 diff 附在报告证据中，8 项冒烟检查和判定、检查器评分/断言逻辑未改。统一脚本只更新期望 smoke hash 常量。

| 脚本 / 提交 | 旧 SHA-256 | 新 SHA-256 / 完整 diff |
|---|---|---|
| 冒烟 / `03f1a7a` | `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f` | `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34`；[完整 diff](evidence/architecture-v2-d1-d2-e/smoke-input.diff) |
| 检查器单行配置 / `1c3d326` | `f45f10aa5f644fdc450d9e8ffef81d45d48f53f38d7455cca00c611b4e43c46a` | `6a5572c3a0a37bb0979e2badcbc3cdbd16cda0849683c716f096a43815de1546`；[完整 diff](evidence/architecture-v2-d1-d2-e/checker-input.diff) |

| 证据 | SHA-256 |
|---|---|
| [unified/verification.json](evidence/architecture-v2-d1-d2-e/unified/verification.json) | `8e8cbd5443e5d7841327f34c896b98dac220116c78fbfb1454c06535bf622049` |
| [d2-final-checks.json](evidence/architecture-v2-d1-d2-e/d2-final-checks.json) | `5b6b3280f2d06e9c8faff0e09fdf73b42c49bf2abf5ac0d706e0112cec03c847` |
| [desktop-cold-check.json](evidence/architecture-v2-d1-d2-e/desktop-cold-check.json) | `cce7d86c65438818317d9f53379aad5ebf08fe2d3a3a00e85236680eaf480253` |
| [line-changes.json](evidence/architecture-v2-d1-d2-e/line-changes.json) | `fe412efa5223c621262637d0a0ab67865122ffde435cc04cbd7a9930806984c1` |
| [command-evidence.json](evidence/architecture-v2-d1-d2-e/command-evidence.json) | `65e6dc8a65990779b7b382c318a038b032c6d56234b196757f8911cab4b75150` |
| [final-checks.json](evidence/architecture-v2-d1-d2-e/final-checks.json) | `2c81e087175b49a0ff997580231d055ba4200d7b91a3f17efc9fb640a02e7778` |


## 5. 与计划不符的地方及理由

- 两处冻结输入都仍用旧配置，与“删除运行时旧字段兼容”冲突。用户先后批准冒烟输入及显式临时 `--home`、检查器仅一行配置迁移；各自独立提交。新 smoke SHA 的 Linux/云端独立复现未做，交审核时须以新 SHA 复现。
- 第一次真实静态源 dry-run 退出 1，原因是把“注册 Thread”误当成“一定有已提交 transcript”。检查源后确认 22 个只有历史执行记录等内容；改为保留其 ID/回执并显式记录缺 transcript，第二次及最终 dry-run/execute 都退出 0。
- 首轮 `pnpm test` 退出 1：1133 项中 1124 通过、2 失败、7 跳过，桌面尚未运行。一个 CLI 断言绑定退休的 automatic 模式，另一个 crash fixture 仍读 config.workspace；改完分别定向验证 8/8，并在最终统一验证中重跑。此前局部检查还暴露两处旧类型调用、3 个错误文案、1 个桌面旧字段，均修复；机械替换误改持久 TelegramData.workspace 已恢复，最终数据字段未动。TS7 旧 JS API 与一次 Python 编码命令失败均为本地操作错误，未当成验证成功。一次测试名筛选未匹配实际 Controller 测试，已用精确名称重跑 1/1，不把空筛选当证据。
- 没有删除测试文件。退休用例为 desktop-config 的 3 个 review 升级/修补测试、daily-setup 的 2 个 policy-only UI 测试；tui-module-config 的模式默认值测试替换为旧字段拒绝测试；failure-copy 删无调用者候选空态断言；CLI 删 policy 专属退出码断言但保留无授权/不读旧存储检查；app 两项 writer 测试改为 autoConsolidate 开/关并检查后台抽取开关，保留写入断言。
- b0 快照文件逐字节未改。比较时只投影移除 `config/{inside,outside}/{automatic,review}` 四个已退休配置 case 及其余配置行的 `policy` 元数据；其余宿主权限行、工具输出、文件路径、worker 行仍完整比较，不重新合成输出。旧配置拒绝由独立配置测试覆盖。
- 三份文档的 user 映射按批准写在导入回执，v6 文件不改格式；c2 才完成真实 user/project 存储语义。真实内容本轮沿用第 7 步已确认裁决，只核对完整性，不重新进行语义裁决。未读取当前日用源，因而不声称对日用源做了内容 SHA 扫描；本轮前后 SHA 证明针对授权静态原副本。

采用“迁完调用者就删除旧 API”消除配置双名字；“构建可重复工具”落实为保留导入器；“幂等恢复”要求未知发布状态显式核对；“验证实际路径”用于生产 reader、子进程中断和真实 Electron 冒烟。本轮未实现 S0–S1、c1/c2 或切日用；未碰 main、日用数据、真实模型、服务注册或 TG 外发。
