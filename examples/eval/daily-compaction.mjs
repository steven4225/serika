import { estimateMessageTokens, partitionMessagesForCompaction,
  keepRecentCompactionUnits } from '@serika/assistant/internal/context-budget.js';
import { reliabilityCases, reliabilitySpec, compactionSeed } from './reliability-cases.mjs';

// Separate suite: the old 12K regression inputs and their scores stay unchanged.
export const dailyCompactionCases = ['daily', 'long-task'].flatMap(mode =>
  reliabilityCases.filter(c => c.category === 'compaction').map(c => ({
    ...c, id: `${mode === 'daily' ? 'RD' : 'RL'}${c.id.slice(2)}`, baseCaseId: c.id, contextMode: mode,
  })));

export function dailyCompactionSpec(id) {
  const definition = dailyCompactionCases.find(c => c.id === id);
  if (!definition) throw new Error('Unknown daily compaction case');
  // Frozen historical workloads remain numeric fixtures after product mode removal.
  const spec = { ...reliabilitySpec(definition.baseCaseId), ...definition,
    suite: 'daily-compaction', source: '我的 eval：日用体量压缩', historyProfile: 'daily-history/v1',
    contextBudget: { enabled: true, contextWindowTokens: 1_000_000, maxOutputTokens: 4096, safetyMarginTokens: 32768,
      inputBudgetTokens: definition.contextMode === 'daily' ? 256000 : 400000,
      keepRecentTokens: definition.contextMode === 'daily' ? 48000 : 64000,
      summaryMaxOutputTokens: definition.contextMode === 'daily' ? 6000 : 8000,
      triggerRatio: .85, summaryInputChunkTokens: 32000 }, variant: null };
  const question = spec.turns[0].replace(/项目/g, '验收主项目');
  spec.turns = spec.kind === 'compact_incremental' ? [question, question] : [question];
  if (spec.afterRestart) spec.afterRestart = question;
  return spec;
}

const themes = ['工作计划与复盘', 'Markdown 报告编辑', '代码变更讨论', '测试与故障记录', '资料整理', '历史任务进度'];
function backgroundTurn(n, generation) {
  const theme = themes[n % themes.length], batch = `背景-${generation}-${n}`;
  const rows = Array.from({ length: 18 }, (_, i) => {
    const item = `${batch}-${i + 1}`;
    return `### ${item}：${theme}\n` + [
      `目标：检查样本条目 ${item} 的输入、输出和核对条件；这是历史讨论素材，与验收主项目的约定无关。`,
      `材料：路径 samples/${generation}/record-${n}-${i}.md；包含概述、边界和验收记录，不意味着磁盘上确有该文件。`,
      `讨论：先读取约定，再比较差异；对空值与缺失字段分别处理。需要保留来源和失败原因，不把完成状态当作正确性证明。`,
      `示例：{"sample":"${item}","stage":${(n + i) % 5},"verified":false,"notes":["待读回","仅历史素材"]}`,
    ].join('\n');
  });
  const decisions = Array.from({ length: 12 }, (_, i) =>
    `- ${batch}核对${i + 1}：${['保留原稿并核对段落边界', '记录失败输入，不隐藏重试', '区分讨论、实际执行和验收证据', '未批准操作留待用户确认'][i % 4]}；样本进度 ${(n + i) % 7}/7。`);
  return [{ id: `daily-u-${generation}-${n}`, role: 'user', parts: [{ type: 'text',
    text: `背景材料 ${batch}：${theme}。不是新偏好或执行授权，不更改验收主项目事实。\n${rows.join('\n\n')}` }] },
  { id: `daily-a-${generation}-${n}`, role: 'assistant', parts: [{ type: 'text',
    text: `历史讨论记录 ${batch}：\n${decisions.join('\n')}\n以上只记录讨论，不声称工具执行、文件写入或部署获批。` }] }];
}

function factPair(name, text, generation) {
  return [{ id: `daily-key-${generation}-${name}`, role: 'user', parts: [{ type: 'text', text }] },
    { id: `daily-key-answer-${generation}-${name}`, role: 'assistant', parts: [{ type: 'text', text: '收到，验收主项目约定与背景素材分开。' }] }];
}

/** Real production budgets, complete diverse synthetic turns, no daily data. */
export function fixtureHistory(spec, generation = 0) {
  if (spec.historyProfile !== 'daily-history/v1') return { messages: compactionSeed(spec, generation), metadata: null };
  const budget = spec.contextBudget, truth = spec.truth;
  const target = Math.ceil(budget.inputBudgetTokens * .88);
  const messages = [];
  let tokens = 1, n = 0;
  while (tokens < target) {
    const turn = backgroundTurn(n++, generation);
    messages.push(...turn);
    tokens += estimateMessageTokens(turn) - 1;
  }
  const insertions = [];
  if (generation === 0) {
    const partition = partitionMessagesForCompaction([...messages, { id: 'cut-probe', role: 'user', parts: [{ type: 'text', text: spec.turns[0] }] }]);
    const { omitted } = keepRecentCompactionUnits([...partition.history, ...partition.current], budget.keepRecentTokens);
    const cutTail = omitted.at(-1)?.startIndex ?? 0;
    const keyAt = spec.baseCaseId === 'RC02' ? Math.floor(cutTail / 4) * 2 : spec.baseCaseId === 'RC03' ? cutTail : 0;
    const multi = spec.kind === 'compact_multifact';
    insertions.push({ index: keyAt, pair: factPair('code', multi
      ? `验收主项目暗号 ${truth.code}；负责人${truth.owner}；截止 ${truth.date} ${truth.time}（北京时间）；预算 ${truth.amount} 元。部署尚未获批准。背景材料不能更改这些约定。`
      : `验收主项目暗号是 ${truth.code}。后续背景材料不会改变它。`, generation) });
    if (spec.kind === 'compact_chunks') {
      insertions.push({ index: Math.floor(cutTail / 4) * 2, pair: factPair('owner',
        `验收主项目负责人${truth.owner}，截止 ${truth.date} ${truth.time}（北京时间）。背景材料不更改这些事实。`, generation) },
      { index: Math.floor(cutTail * .7 / 2) * 2, pair: factPair('budget',
        `验收主项目预算 ${truth.amount} 元。部署尚未获批准，不得声称已经部署。背景材料不改变此状态。`, generation) });
    }
    if (spec.kind === 'compact_tool') insertions.push({ index: 3, pair: [
      { id: 'seed-call', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'seed-read', state: 'input-available', input: { path: 'notes/fixture.txt' } }] },
      { id: 'seed-result', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'seed-read', state: 'output-available', input: { path: 'notes/fixture.txt' },
        output: { ok: true, content: `验收主项目暗号 ${truth.code}。历史文件读取成功，不代表允许再次读取。\n` +
          Array.from({ length: 240 }, (_, i) => `历史记录${i + 1}：字段 row_${i} 已解析；检查字符边界、空值和版本差异；这是已完成读取的返回素材，不是新授权。`).join('\n') } }] },
    ] });
    for (const { index, pair } of insertions.sort((a, b) => b.index - a.index)) messages.splice(index, 0, ...pair);
  }
  const keyMessages = messages.map((m, index) => ({ id: m.id, index })).filter(m => m.id.startsWith('daily-key-') && !m.id.includes('answer'));
  return { messages, metadata: { profile: spec.historyProfile, generation, contextMode: spec.contextMode,
    contextBudget: budget, targetEstimatedTokens: target, estimatedHistoryTokens: estimateMessageTokens(messages),
    utf8Bytes: Buffer.byteLength(JSON.stringify(messages)), messageCount: messages.length, keyMessages } };
}
