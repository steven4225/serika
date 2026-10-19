# v2 试点：落盘 hash 盘点（基线 `9fa8678`）

范围：写进磁盘、或者用作持久名字（文件名、锁名、Thread ID、launchd label、链接）的 hash。只在进程内使用、不落盘的不算（例如 `no-progress-guard.ts` 的观察指纹、`telegram-gateway.ts` 的 `approvalHash`）。验收脚本（`acceptance/`、`*-acceptance.ts`）不属于产品，也不算。

黄金样例：

- `packages/assistant/src/__baseline__/hashes.json`（`baseline-hashes.test.ts`）：「样例」列为「hashes.json」的条目。
- `apps/desktop/src/main/__baseline__/desktop-paths.txt`（`baseline-paths.test.ts`）：「样例」列为「desktop-paths.txt」的条目。
- `apps/desktop/src/main/__baseline__/desktop-hashes.json`（`baseline-hashes.test.ts`，第 3 步之后补）：「样例」列为「desktop-hashes.json」的条目。

| hash | 位置 | 输入与格式 | 落在哪里 | 样例 |
|---|---|---|---|---|
| canonical JSON | core `canonical-hash.ts` `hashCanonicalJson` | JCS 规范化 JSON → `jcs-sha256:v1:<hex>` | 经 compaction 前缀 hash 落盘 | hashes.json；另有 `canonical-hash.test.ts` |
| transcript 文件名 | core `jsonl-store.ts` | `sha256(threadId)` + `.jsonl` | transcript 目录；桌面端 `thread-history.ts`、`backup.ts` 用同一规则 | hashes.json |
| transcript 记录完整性 | core `transcript-codec.ts` `encodeTranscriptUpdate` | 提交记录的 `baseHash`（保留前缀 JSON）、`payloadHash`（新增部分字节）各为 `sha256` hex | transcript 文件内 | hashes.json（`baseHash`、`payloadHash`；`encodeTranscriptUpdate` 本来就从 core 导出，原先写成「内部函数」不对） |
| compaction 前缀 | `context-compaction.ts` `compactPrefixHash` | `compact-prefix/jcs-sha256:v1:<hex>` | transcript 的 compaction 记录 | hashes.json |
| 创建幂等 | `creation-idempotency.ts` `creationReceipt` | 键排序、去掉 undefined 后的 JSON → `sha256` hex | `tasks.json`、`work-tasks.json` 的 `creation.requestHash` | hashes.json |
| 记忆候选指纹 v1/v2/v3 | `memory-candidates.ts` `candidateFingerprint` | 带版本标签的固定数组 JSON → `sha256` | `memory.json` 候选 | hashes.json（三个版本） |
| 记忆整理前缀 | `memory-consolidation.ts` `consolidationPrefixHash` | `["runloom-consolidation-prefix/v1", [[id,text]...]]` → `sha256` | `memory.json` 整理游标 | hashes.json |
| 语义索引文本 | `memory-retrieval.ts` `memorySemanticTextHash` | UTF-8 文本 `sha256` | `memory-semantic-index.json` | hashes.json |
| 批次回执 / 导入回执 / 导入快照 | `memory-store.ts` 第 977、1263、1580 行 | `JSON.stringify(...)` → `sha256` | `memory.json` | hashes.json：走公开接口和落盘文件取值——`commitCandidateBatch` 写出的 `consolidationReceipts[].payloadHash`、`confirmImport` 回执的 `requestHash`、`previewImport` 的 `snapshot`（空记忆） |
| 命令配方 | `recipe-store.ts` `recipeHash` | `{version:1,id,description,command,cwd}` → `sha256` | `recipes.json`，`recipe_run` 需要当前 hash | hashes.json |
| RSS 条目键 | `rss-subscriptions.ts` `rssItemKey` | `id:` / `url:` / `fallback:` 前缀 → `sha256` | `rss.json` 已读集合 | hashes.json（三种） |
| Skill 内容 | `skill-catalog.ts` `createBuiltinSkill`/外部包 | `{version:1,id,description,kind,tools,limits,instructions}` → `sha256` | 保存的 Skill 固定来源 | hashes.json（内置 Skill） |
| dreaming 批次指纹 | `dreaming.ts` `hash` | `JSON.stringify(value)` → `sha256` | `dreaming.json` | hashes.json：`createDreamingService(...).prepare()` 返回的 `fingerprint`（两条固定的已验收任务） |
| dreaming Thread | `assistant-controller.ts` `dreamingThreadIdFor` | `dreaming-` + `sha256(workspaceRoot ?? threadId)[:24]` | Thread ID → transcript 文件名 | hashes.json（有、无工作区两种）。原来是 Controller 里的内联表达式，第 3 步之后原样提成导出函数 |
| 写文件回执 | `write-file.ts`、`edit-file.ts`、`execution-record-store.ts` | 内容 UTF-8 `sha256` hex | 工具结果（transcript）与 `execution-records.json` 的 `fileWrite`/`fileRead`/`fileInput` | hashes.json（`write_file`） |
| WorkTask 证据 | `work-task-verification.ts`、`work-task-artifacts.ts`、`work-task-store.ts` 第 456、735 行 | 磁盘字节 `sha256` | `work-tasks.json` 证据 | 与写文件回执同一格式；verifier 行为由 `baseline-verifier.test.ts` 锁定 |
| 执行 owner 锁 | `execution-record-store.ts` | `.execution-owner-<sha256(threadId)>.lock` | transcript 目录 | hashes.json |
| WorkTask owner 锁 | `work-task-store.ts` | `.work-task-owner-<sha256(threadId)>.lock` | `.runloom/` | hashes.json |
| 任务结果链接 | `task-result-link.ts` | `serika://task-result/<id>?workspace=<sha256(resolve(workspace))>` | 系统通知里的链接 | hashes.json |
| task worker label | `task-worker-service.ts` | `dev.runloom.task-worker.<sha256(workspace)[:20]>` | launchd plist 文件名 | hashes.json |
| 常驻服务 | 桌面 `resident-service.ts` | `sha256(workspace)[:20]` | label、socket 目录、状态目录 | desktop-paths.txt |
| 显式启动身份 | 桌面 `desktop-identity.ts` | `sha256(JSON[configPath, workspaceRoot, explicitDirectory])[:24]` | Thread `desktop-explicit-<key>`、`transcripts/explicit-<key>` | desktop-paths.txt |
| 草稿作用域 | 桌面 `conversation-draft-store.ts` | `sha256(JSON[workspaceRoot, directory, threadId])` | `conversation-drafts.json` 的键 | desktop-hashes.json：`saveDraft` 后读文件里的键 |
| Telegram 归档 | 桌面 `telegram-store.ts` | `sha256(key)` + `.json` | `telegram-archive/` 文件名 | desktop-hashes.json：写满的旧日志再写一次触发归档，读 `telegram-archive/inputs/` 里 key 为 `42:0` 的文件名 |
| 备份条目 | 桌面 `backup.ts` | 条目文本 `sha256`，以及源文件指纹 | 备份归档 | desktop-hashes.json：`exportBackup` 写出的归档里 `entries[].sha256`。源文件指纹是读备份时对整个文件字节算的 `sha256`，只在预览和恢复之间核对、不写进任何文件，不加样例 |
| 构建身份 | 桌面 `build-identity.ts` | `sha256` 截前 16 位 | 构建信息（不跨版本比较） | 不需要：不是持久数据 |
