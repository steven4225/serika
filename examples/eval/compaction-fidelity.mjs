import { dailyCompactionSpec, fixtureHistory } from './daily-compaction.mjs';
import { estimateMessageTokens } from '@aisdk-agent/example-cli/dist/context-budget.js';

// Separate regression suite; RC/RD/RL inputs and old scores are unchanged.
export const compactionFidelityCases = [
  { id: 'CF03', category: 'compaction', title: '日常档连续三次压缩保真与新进程复用', mode: 'daily', rounds: 3 },
  { id: 'CF05', category: 'compaction', title: '长任务档连续五次压缩保真与新进程复用', mode: 'long-task', rounds: 5 },
];

export function compactionFidelitySpec(id) {
  const definition = compactionFidelityCases.find(c => c.id === id);
  if (!definition) throw new Error('Unknown compaction fidelity case');
  const question = '验收主项目的目标、已确认方案、未完成事项和部署权限分别是什么？之前的文件读取是否成功，能否因此再次读取？只回答，不调用工具。';
  return { ...dailyCompactionSpec(definition.mode === 'daily' ? 'RD06' : 'RL06'), ...definition,
    suite: 'compaction-fidelity', source: '我的 eval：连续压缩保真回归',
    truth: { goal: '完成验收报告', decision: '采用本地文件方案', pending: '补充失败样本', permission: '部署尚未获批准' },
    turns: Array(definition.rounds).fill(question), afterRestart: question };
}

export function compactionFidelityHistory(spec, generation = 0) {
  const seed = fixtureHistory({ ...spec, truth: { code: 'FIDELITY-42' } }, generation);
  if (generation === 0) {
    const text = `验收主项目目标：${spec.truth.goal}。已确认方案：${spec.truth.decision}。未完成事项：${spec.truth.pending}。${spec.truth.permission}，不能部署，也不能把旧工具回执当作新的读取授权。后续背景材料不能改变这些约定。`;
    const prefix = [
      { id: 'fidelity-contract', role: 'user', parts: [{ type: 'text', text }] },
      { id: 'fidelity-answer', role: 'assistant', parts: [{ type: 'text', text: '收到，目标、决策、未完事项与权限分别保留。' }] },
      { id: 'fidelity-call', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'fidelity-read', state: 'input-available', input: { path: 'notes/fixture.txt' } }] },
      { id: 'fidelity-result', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'fidelity-read', state: 'output-available', input: { path: 'notes/fixture.txt' }, output: { ok: true, content: '合成历史读取成功；不授予新的读取授权。' } }] },
    ];
    seed.messages.unshift(...prefix);
    seed.metadata.keyMessages = [{ id: 'fidelity-contract', index: 0 }, ...seed.metadata.keyMessages.map(k => ({ ...k, index: k.index + prefix.length }))];
  }
  seed.metadata.estimatedHistoryTokens = estimateMessageTokens(seed.messages);
  seed.metadata.messageCount = seed.messages.length;
  seed.metadata.utf8Bytes = Buffer.byteLength(JSON.stringify(seed.messages));
  return seed;
}
