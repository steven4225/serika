# Electron 隔离冒烟证据

验证方式：真实 Electron + 假模型；macOS 实测。结果不是抽取质量或真实模型验收。

```sh
pnpm --filter @serika/desktop smoke
# Linux（已具备 Electron 系统依赖与 Xvfb）
xvfb-run -a pnpm --filter @serika/desktop smoke
```

`RUNLOOM_SMOKE_DAILY_CONFIG` 可指定日用配置 JSON 的受信任绝对路径，脚本只在临时目录生成脱敏副本；不读取日用 env、TG 文件或数据树。未指定时使用平台默认路径；只有 ENOENT 时改用仓库 `apps/desktop/scripts/fixtures/retired-config.json`，证据注明“样例”，其他读取／解析错误仍失败。可把该环境变量指向不存在的路径来复现样例分支。Linux 的新脚本尚未本地实测。

- `result.json`：八项检查（含聊天成功回执和撤销按钮）、进程身份、源码／脚本／构建产物 hash、截图 hash、重启 pid／记忆 hash、配置副本的生产解析器诊断。sourceCommit 是执行时的 HEAD；启动前强制 sourceWorktreeDirty=false，脏工作区直接失败且不写证据。每项检查记录 unexpectedErrors=0；日用目录拒写、退役配置校验各只允许一条明确预期的错误。
- `verification.json`：命令退出码、可相加的测试计数、日志 hash、失败过程说明。全套计数按 commands[].counts 分组相加；既有 skip = 11。
- `cleanup.json`：仅本轮遗留测试身份的清理摘要；无身份文件内容。
- 每项 `.png` 是对应原生 Electron renderer 截图，不拍设置／配置页；配置副本截图仅是聊天主页面的启动失败提示。

脚本单次执行失败即退出 1，不重试、不补样。缺任何必需证据或清理失败均为失败。撤销通过普通聊天触发实际 memory_write，重启使用完整退出后的新 Electron 进程，preload／IPC 未替换。所有运行数据在 finally 清理。

本次纠正：旧七项脚本未检查聊天回执告警，不能据其结果认定回执正常。新增 `remember-success-receipt` 捕捉该问题，重启后点击回执“撤销”并检查文档消失。正式 result.json 只保留干净提交的完整运行。
