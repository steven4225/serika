#!/bin/zsh
set -eu
unsetopt XTRACE
serika_eval_repo="${0:A:h:h:h}"
cd "$serika_eval_repo"
pnpm build:runtime
print '本次仅跑隔离后端：11 个记忆场景 × 3 变体，8 个12K压缩场景 × 3 变体。会产生模型费用。'
print '不读取日用数据，不启动桌面、worker 或 Telegram；Key 不写入文件或命令历史。'
read -r -s 'COMMAND_CODE_API_KEY?Command Code API Key（隐藏输入，粘贴后按 Enter）: '
print
if [[ -z "$COMMAND_CODE_API_KEY" ]]; then
  print -u2 'Key 为空，没有启动模型评测。'
  exit 1
fi
export COMMAND_CODE_API_KEY
trap 'unset COMMAND_CODE_API_KEY' EXIT
export SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code
export COMMAND_CODE_MODEL_ID=deepseek/deepseek-v4.1-flash-fast
unset SERIKA_EVAL_BASELINE
pnpm --filter @aisdk-agent/eval e2e --suite reliability --repeat 3
