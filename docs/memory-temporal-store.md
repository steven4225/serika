# Memory v4：存储层操作与边界

本批只升级 workspace 本地 `.runloom/memory.json`。没有引入外部服务、向量数据库、后台整理进程、新模型工具或桌面按钮；候选生成、确认、检索仍沿用现有路径。

## 可以调用什么

`createMemoryStore(workspace)` 返回兼容旧 CRUD 的 `TemporalWorkspaceMemoryStore`：

| 接口 | 用途与约束 |
| --- | --- |
| `list(signal?, options?)` / `get(id, signal?, options?)` | 当前内容的兼容投影；不把所有断言塞进模型。`options.now` 固定选择时间。旧 `history` 仍带各版本 scope，模型模块会过滤其它 Thread。 |
| `inspectMemory(id, signal?, options?)` | 明确读取有界断言、版本引用与历史覆盖标记；`boundThreadId` 限制私有 Thread 历史。 |
| `queryMemory(id, { validAt?, knownAt?, includeDisabled? }, signal?, options?)` | 分开查询事实适用时间和系统当时认知；默认是现在。禁用或过期内容默认排除，明确历史检查可选择 `includeDisabled: true`。 |
| `reviseMemory({ id, expectedRevision, operation, ... }, signal?, options?)` | `change` 表示真实状态转变，必须给 `effectiveAt`；`correct` 表示旧认知有误，可给新的 `validTime`；`retract` 撤回认知，不删除审计历史。 |
| `restoreMemory({ id, expectedRevision, targetAssertionId, status?, expiresAt? }, signal?, options?)` | 以新 revision 恢复所选内容，默认从本次恢复时间起适用；不是倒退版本或恢复整条旧时间线。 |
| `update(id, { expectedRevision, ... }, signal?, options?)` | 保留旧的显式编辑入口；正文编辑按纠错处理，程序不会从一句新正文自动猜测真实迁移日期。pin、禁用、scope、TTL 是管理操作。 |
| `delete(id, signal?, options?)` | 永久移除该条全部断言、历史，以及按目标 ID 或接受回执关联的候选内容。不提供恢复保证。 |
| `deleteMemory({ id, expectedRevision }, signal?, options?)` | 带 revision CAS 的永久删除；过期的删除预览不会删除新版。旧 ID-only 接口仍保留兼容。 |

时间输入必须是带时区的 ISO 日期时间。`validTime` 使用左闭右开区间；`expiresAt` 是使用期限，不是事实失效时间。没有证据的起始时间保持未知。`validTimeUncertain` / `systemTimeUncertain` 与 `historyCoverage` 必须一起读，不能把未知起点或不完整旧历史说成可靠的过去事实。

断言 ID、系统时间和 revision 由程序生成，来源原话由可信调用者核验；本地存储验证格式，不代替“用户真的说过”或“归纳正确”的检查。记忆永远不恢复工具授权。

## 旧文件、容量和恢复

v1–v3 只读时在内存中归一化，不改文件；只有成功的实际写入才迁成 v4。旧文本、已保留的来源和版本继续保存；不补造日期、来源，已被旧版本裁掉的历史也不会重建。迁移记录标为 `legacy_partial`。

一个 workspace 最多 512 条、文件最多 16 MiB；每条最多 64 个断言和 64 个版本引用。每个断言正文最多 2048 UTF-8 字节、最多 3 个短召回词和 4 个来源。容量满时拒绝新修改，不悄悄裁剪时间历史；这不改变最终模型引用的现有 8 KiB 预算。

写操作复用同一把 flock，编辑、时间变更和恢复在锁内核对调用者提供的 revision。过期预览不会覆盖新版，时间倒退会拒绝写入。兼容的 `delete` 接口按 ID 删除，不要求 expectedRevision。恢复禁用条目必须明确选择 `status`；恢复过期条目必须明确选择 `expiresAt`，不能默认启用或沿用已经过期的 TTL。成功编辑、撤回或恢复会让关联待审更新候选失效。

## 写失败如何处理

新文件先写临时文件并同步，然后原子 rename，再同步目录。rename 前失败不会替换旧文件；损坏、超限和 symlink 都失败，不会拿空文件覆盖。

`MEMORY_COMMIT_UNCERTAIN` 表示 rename 已发生，但持久化或清理回执不完整。不能解释成“没有写入”。先读当前条目或候选接受回执核对：非幂等的 add/update/delete 工具会以 `TOOL_OUTCOME_UNKNOWN` 停住当前 Run；候选接受仍可按原 candidate ID、原 expected revision 精确重放，返回原回执、不重复创建断言。程序不会自动重试存储写入。

永久删除不清理 transcript、历史模型回复、外部备份或已经发出的上下文；本文件也不是全盘隐私擦除承诺。恢复不会复活已永久删除的条目。

`SIGKILL` 在 rename 前可能留下未安装的临时文件；它不参与任何读取、恢复或候选重放。磁盘清理和全盘隐私擦除不是本接口的保证。commit-boundary 观察器仅供测试进程使用，不来自模型参数或配置。

## 本批验证

在后端仓库运行 `pnpm typecheck`、`pnpm test` 和 `git diff --check`。离线测试核对时间线、来源、CAS、容量、flock 等待后的单一时间戳，以及写入边界；不调用真实模型，也不代表桌面点击链或断电耐久性实测。
