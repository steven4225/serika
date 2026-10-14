#!/bin/zsh
set -eu
unsetopt XTRACE
serika_daily_eval_repo="${0:A:h:h:h}"
cd "$serika_daily_eval_repo"
pnpm build:runtime
print '本轮共 28 次：12 次记忆回归＋16 次日用体量压缩（256K／400K），使用真实模型，会产生费用。'
print '不读取日用数据，不启动桌面／worker／TG；失败不整案重试，不改旧报告。'
read -r -s 'COMMAND_CODE_API_KEY?Command Code API Key（隐藏输入，粘贴后按 Enter）: '
print
if [[ -z "$COMMAND_CODE_API_KEY" ]]; then
  print -u2 'Key 为空，未启动。'
  exit 1
fi
export COMMAND_CODE_API_KEY
trap 'unset COMMAND_CODE_API_KEY' EXIT
export SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code
export COMMAND_CODE_MODEL_ID=deepseek/deepseek-v4.1-flash-fast
unset SERIKA_EVAL_BASELINE
serika_memory_exit=0
pnpm eval:e2e --suite reliability --cases RM03,RM05,RM09,RM11 --repeat 3 || serika_memory_exit=$?
serika_compaction_exit=0
pnpm eval:e2e --suite daily-compaction --repeat 1 || serika_compaction_exit=$?
print "记忆批退出码：$serika_memory_exit；日用压缩批退出码：$serika_compaction_exit（失败证据仍保留）。"
if (( serika_memory_exit != 0 || serika_compaction_exit != 0 )); then exit 1; fi
