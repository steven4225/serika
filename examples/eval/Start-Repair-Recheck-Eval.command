#!/bin/zsh
set -eu
unsetopt XTRACE
serika_recheck_repo="${0:A:h:h:h}"
cd "$serika_recheck_repo"
pnpm build:runtime
print '本轮共 13 次：RM03／RM05／RM09／RM11 各 3 变体＋日常 256K 压缩 RD08 一次。'
print '固定 Command Code deepseek/deepseek-v4.1-flash-fast；真实调用会产生费用。'
print '隔离数据、新报告、不整案重试；不启动日用桌面／worker／TG，不修改旧报告。'
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
pnpm eval:e2e --suite daily-compaction --cases RD08 --repeat 1 || serika_compaction_exit=$?
print "记忆批退出码：$serika_memory_exit；RD08 退出码：$serika_compaction_exit（失败证据仍保留）。"
if (( serika_memory_exit != 0 || serika_compaction_exit != 0 )); then exit 1; fi
