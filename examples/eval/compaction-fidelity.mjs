import { dailyCompactionSpec, fixtureHistory } from './daily-compaction.mjs';
import { effectiveContextBudget, estimateMessageTokens } from '@aisdk-agent/example-cli/dist/context-budget.js';

// Separate regression suite; RC/RD/RL inputs and old scores are unchanged.
export const compactionFidelityCases = [
  { id: 'CF03', category: 'compaction', title: '日常档连续三次压缩保真与新进程复用', mode: 'daily', rounds: 3 },
  { id: 'CF05', category: 'compaction', title: '长任务档连续五次压缩保真与新进程复用', mode: 'long-task', rounds: 5 },
];
// A separately named capped-window regression, never reported as a 256K/400K run.
export const effectiveCompactionFidelityCases = compactionFidelityCases.map(c => ({ ...c,
  id: c.id.replace('CF', 'CE'), title: `32K有效窗口：${c.title}` }));

export const isCompactionFidelity = spec => ['compaction-fidelity', 'compaction-fidelity-effective'].includes(spec.suite);

export function effectiveCompactionFidelitySpec(id) {
  const definition = effectiveCompactionFidelityCases.find(c => c.id === id);
  if (!definition) throw new Error('Unknown effective compaction fidelity case');
  const original = compactionFidelitySpec(id.replace('CE', 'CF'));
  const capacity = { provider: 'openai-compatible.chat', modelId: 'deepseek/deepseek-v4.1-flash-fast',
    contextWindowTokens: 32768, source: 'configuration' };
  return { ...original, ...definition, suite: 'compaction-fidelity-effective',
    source: '我的 eval：32K有效预算连续压缩保真回归（配置上限，不是供应商容量证明）',
    requestedContextBudget: original.contextBudget, contextBudget: effectiveContextBudget(original.contextBudget, capacity),
    modelContextWindows: [{ provider: capacity.provider, modelId: capacity.modelId, contextWindowTokens: capacity.contextWindowTokens }] };
}

export function compactionFidelitySpec(id) {
  const definition = compactionFidelityCases.find(c => c.id === id);
  if (!definition) throw new Error('Unknown compaction fidelity case');
  const question = '验收主项目的目标、已确认方案、未完成事项和部署权限分别是什么？之前的文件读取是否成功，能否因此再次读取？之前写入 uncertain.txt 的结果是否确定，能否自动重试？只回答，不调用工具。';
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
      { id: 'fidelity-write-call', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'write_file', toolCallId: 'fidelity-write', state: 'input-available', input: { path: 'notes/uncertain.txt', content: '合成历史写入' } }] },
      { id: 'fidelity-write-result', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'write_file', toolCallId: 'fidelity-write', state: 'output-error', input: { path: 'notes/uncertain.txt', content: '合成历史写入' }, errorText: 'TOOL_OUTCOME_UNKNOWN: dispatched write lost its receipt; effect unknown, must not retry automatically.' }] },
    ];
    seed.messages.unshift(...prefix);
    seed.metadata.keyMessages = prefix.map((m, index) => ({ id: m.id, index })).concat(seed.metadata.keyMessages.map(k => ({ ...k, index: k.index + prefix.length })));
  }
  seed.metadata.estimatedHistoryTokens = estimateMessageTokens(seed.messages);
  seed.metadata.messageCount = seed.messages.length;
  seed.metadata.utf8Bytes = Buffer.byteLength(JSON.stringify(seed.messages));
  seed.metadata.fidelityScale = spec.suite === 'compaction-fidelity-effective' ? 'configured-32K-effective' : 'full-mode-target';
  return seed;
}
