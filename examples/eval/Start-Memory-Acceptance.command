#!/bin/zsh
set -eu
unsetopt XTRACE
serika_memory_repo="${0:A:h:h:h}"
cd "$serika_memory_repo"
pnpm build:runtime
print '本轮仅测真实 embedding 召回：原 MR 12 题＋独立 MH 验证 4 题，各执行一次。'
print '固定 DashScope qwen3.7-text-embedding-flash；实际调用会产生费用。'
print '使用隔离合成记忆，新报告；不读日用数据，不启动桌面／worker／TG，不重试。'
read -r -s 'DASHSCOPE_API_KEY?百炼 API Key（隐藏输入，粘贴后按 Enter）: '
print
if [[ -z "$DASHSCOPE_API_KEY" ]]; then
  print -u2 'Key 为空，未启动。'
  exit 1
fi
export DASHSCOPE_API_KEY
trap 'unset DASHSCOPE_API_KEY' EXIT
node --input-type=module <<'NODE'
import { runMemoryRecall, formatRecallResult } from './examples/eval/memory-recall.mjs';
let failed = false;
try {
  for (const suite of ['regression', 'validation']) {
    const result = await runMemoryRecall({ live: true, suite,
      provider: 'dashscope', modelId: 'qwen3.7-text-embedding-flash' });
    console.log(JSON.stringify(formatRecallResult(result), null, 2));
    if (result.summary.environmentFailure) {
      console.error('评测环境失败，保留证据并停止；后续套件未执行，不自动重试。');
      failed = true;
      break;
    }
    if (result.summary.hybrid.passed !== result.summary.hybrid.planned) failed = true;
  }
} catch {
  console.error('评测未完成，请检查服务配置或专用 Key；不输出凭据或原始异常，不自动重试。');
  failed = true;
}
if (failed) {
  console.error('未达到全部通过门槛；退出码 1 可能是质量未达标，请按报告 status 区分，不是统一的接口故障。');
  process.exitCode = 1;
}
NODE
