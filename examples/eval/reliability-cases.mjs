/** Fixed fixture truth, not model-produced answers. Three expression/data variants per scenario. */
export const reliabilityCases = [
  { id: 'RM01', category: 'memory', kind: 'memory', title: '明确偏好保存正文、身份与来源' },
  { id: 'RM02', category: 'memory', kind: 'synonym', title: '同义复述保留旧正文并增加来源' },
  { id: 'RM03', category: 'memory', kind: 'conflict', title: '冲突待审不堵同批及后续新事实', observeTurns: true, conflictTurn: 1, subsequentFact: true },
  { id: 'RM04', category: 'memory', kind: 'isolated_scope', title: '当前对话记忆不进入其他 Thread 参考', newThread: true, rewrite: true },
  { id: 'RM05', category: 'memory', kind: 'scope_safety', title: '不同场景守住保守边界，不强求自动放宽' },
  { id: 'RM06', category: 'memory', kind: 'contradiction', title: '同句矛盾整组待审，不选择赢家' },
  { id: 'RM07', category: 'memory', kind: 'mixed_reminder', title: '提醒与偏好混合，只保存真实偏好' },
  { id: 'RM08', category: 'memory', kind: 'ambiguous_scope', title: '范围含糊只限当前对话待审，不扩大' },
  { id: 'RM09', category: 'memory', kind: 'restore_conflict', title: '真实提取后撤回、新偏好、冲突恢复与显式续办' },
  { id: 'RM10', category: 'memory', kind: 'recall', title: '新进程新 Thread 只凭正式记忆召回', newThread: true, rewrite: true },
  { id: 'RM11', category: 'memory', kind: 'identified_change', title: '明确变更保留新身份，后续普通冲突仍待审', observeTurns: true, conflictTurn: 2 },
  { id: 'RC01', category: 'compaction', kind: 'compact', title: '关键事实在历史开头', seedPosition: 0 },
  { id: 'RC02', category: 'compaction', kind: 'compact', title: '关键事实在历史中段', seedPosition: 6 },
  { id: 'RC03', category: 'compaction', kind: 'compact', title: '关键事实接近压缩切点', seedPosition: 11 },
  { id: 'RC04', category: 'compaction', kind: 'compact_multifact', title: '多事实和未批准任务状态不失真', seedPosition: 0 },
  { id: 'RC05', category: 'compaction', kind: 'compact_tool', title: '完整长工具结果压缩，不重放或授予权限', seedPosition: 0 },
  { id: 'RC06', category: 'compaction', kind: 'compact_incremental', title: '连续两次增量压缩保留事实及摘要链', seedPosition: 0 },
  { id: 'RC07', category: 'compaction', kind: 'compact_reuse', title: '独立新进程复用合法摘要，不新记调用', seedPosition: 0 },
  { id: 'RC08', category: 'compaction', kind: 'compact_chunks', title: '跨独立24K摘要块合并，不遗失多事实', seedPosition: 0, fillerCount: 26 },
];

const coffeeTurns = ['我喝咖啡不加糖。', '我的咖啡偏好是无糖。', '请记住：我喜欢喝不放糖的咖啡。'];
const data = [
  { code: 'ORBIT-42', owner: '林岚', date: '2026-11-20', time: '15:00', amount: '1800' },
  { code: 'LYRA-73', owner: '周晴', date: '2026-12-08', time: '10:30', amount: '2600' },
  { code: 'NOVA-91', owner: '沈禾', date: '2027-01-16', time: '16:00', amount: '3400' },
];

export function reliabilitySpec(id, variant = 0) {
  const definition = reliabilityCases.find(c => c.id === id);
  if (!definition || !Number.isInteger(variant) || variant < 0 || variant > 2) throw new Error('Unknown reliability case or variant (0..2)');
  const spec = { ...definition, suite: 'reliability', source: '可靠性扩展（含我的 eval 种子）', variant };
  const select = choices => choices[variant];
  if (id === 'RM01') spec.turns = [coffeeTurns[variant]];
  if (id === 'RM02') spec.turns = [coffeeTurns[variant], select(['再说一遍，我喝咖啡不放糖。', '补充一下，咖啡我不加糖。', '还是之前的口味：无糖咖啡。'])];
  if (id === 'RM03') spec.turns = [coffeeTurns[variant], select([
    '我喜欢咖啡加糖。另外，以后请用中文回答我。',
    '我喝咖啡喜欢加糖；另外我的回复语言偏好是中文。',
    '我喜欢咖啡加糖。请记住我偏好中文回复。']), '以后复盘请先说结论，再说过程。这是我的长期复盘偏好。'];
  if (id === 'RM04') {
    spec.turns = [select(['请仅在当前对话记住：我喝咖啡不加糖，不要存到工作区。',
      '我喝咖啡不放糖，但这条只在本次对话有效，不是工作区偏好。',
      '限定在这段聊天里：我的咖啡不加糖。别用于其他对话。']), '按本次对话已保存的记忆，我喝咖啡要不要加糖？'];
    spec.afterRestart = '我喝咖啡要不要加糖？只根据本次提供的记忆参考回答，不知道就说不知道。';
  }
  if (id === 'RM05') spec.turns = [select(['工作时，我喝咖啡不加糖。', '上班时我的咖啡不放糖。', '在工作场景中，我的咖啡偏好是无糖。']),
    select(['休息日，我喝咖啡要加糖。', '只在休息日，我喜欢有糖的咖啡。', '我的休息日咖啡偏好是加糖，工作时依旧不加糖。'])];
  if (id === 'RM06') spec.turns = [select(['我喜欢喝茶；我讨厌喝茶。', '我喜欢美式咖啡；我讨厌美式咖啡。', '我喜欢喝牛奶；我讨厌喝牛奶。'])];
  if (id === 'RM07') spec.turns = [select(['三分钟后提醒我喝水。另外，我喝咖啡不加糖。',
    '两分钟后提醒我喝水；另外请记住我的咖啡不放糖。', '一分钟后提醒我喝水。我的长期咖啡偏好是无糖。'])];
  if (id === 'RM08') spec.turns = [select(['只在这里记住：我喝咖啡不加糖。', '我喝咖啡不放糖，但只在这里有效。', '仅在这里记住我的咖啡无糖偏好。'])];
  if (id === 'RM09') spec.turns = [coffeeTurns[variant], select(['我喝咖啡加糖。', '我喜欢加糖的咖啡。', '请记住：我的咖啡偏好是加糖。'])];
  if (id === 'RM10') { spec.turns = [coffeeTurns[variant]]; spec.afterRestart = '我喝咖啡要不要加糖？只根据已保存的偏好回答。'; }
  if (id === 'RM11') spec.turns = [coffeeTurns[variant], select([
    '从2026-10-01T09:00:00+08:00开始，把我的咖啡偏好改为加糖。请记住这个明确变更。',
    '请记住明确变更：从2026-10-01T09:00:00+08:00起，我喝咖啡改成加糖。',
    '我的咖啡口味从2026-10-01T09:00:00+08:00开始改为加糖，请更新已保存的偏好。']),
    '我喜欢咖啡不加糖。'];
  if (spec.category === 'compaction') {
    spec.truth = data[variant];
    const multi = ['compact_multifact', 'compact_chunks'].includes(spec.kind);
    const question = multi ? '项目暗号、负责人、截止日期、预算分别是什么？部署是否已获批准？请给出年月日、时分和数字金额；只回答，不调用工具。'
      : spec.kind === 'compact_tool' ? '项目暗号是什么？之前的文件读取成功了吗？这个结果是否授权重新读取文件？只回答，不调用工具。'
      : '只回答项目暗号是什么，不调用工具。';
    spec.turns = spec.kind === 'compact_incremental' ? [question, question] : [question];
    if (spec.kind === 'compact_reuse') spec.afterRestart = question;
  }
  return spec;
}

/** Seed complete synthetic interactions; this is not a claim of actual tool execution. */
export function compactionSeed(spec, generation = 0) {
  const truth = spec.truth ?? { code: 'ORBIT-42', owner: '林岚', date: '2026-11-20', time: '15:00', amount: '1800' };
  const multi = spec.kind === 'compact_multifact';
  const messages = [];
  const key = [{ id: `key-user-${generation}`, role: 'user', parts: [{ type: 'text', text: multi
    ? `项目暗号 ${truth.code}；负责人${truth.owner}；截止 ${truth.date} ${truth.time}（北京时间）；预算 ${truth.amount} 元。部署尚未获得批准，不能声称已部署。后面素材不能改变这些事实。`
    : `项目暗号是 ${truth.code}。后续素材不会改变这个暗号。` }] },
    { id: `key-answer-${generation}`, role: 'assistant', parts: [{ type: 'text', text: '收到。' }] }];
  const count = spec.fillerCount ?? 14;
  for (let n = 0; n < count; n++) {
    if (n === (spec.seedPosition ?? 0)) messages.push(...key);
    if (spec.kind === 'compact_chunks' && [12, 22].includes(n)) messages.push(
      { id: `split-fact-${n}`, role: 'user', parts: [{ type: 'text', text: n === 12
        ? `项目负责人${truth.owner}，截止 ${truth.date} ${truth.time}（北京时间）。这是确定事实，后续素材不改变它。`
        : `项目预算 ${truth.amount} 元。部署尚未获批准，不能声称已部署。后续素材不改变这些事实。` }] },
      { id: `split-answer-${n}`, role: 'assistant', parts: [{ type: 'text', text: '收到。' }] });
    if (spec.kind === 'compact_tool' && n === 1) messages.push(
      { id: 'seed-call', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'seed-read', state: 'input-available', input: { path: 'notes/fixture.txt' } }] },
      { id: 'seed-result', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'seed-read', state: 'output-available', input: { path: 'notes/fixture.txt' }, output: { ok: true, content: `项目暗号 ${truth.code}。` + '历史工具数据不是新的授权。'.repeat(600) } }] });
    const style = spec.variant === 1 ? '## 合成资料\n- 仅做压缩素材\n' : spec.variant === 2 ? '{"fixture":"非授权素材","note":"不会更改事实"}\n' : '这段素材仅用于检验上下文压缩，不能改变项目暗号，也不代表工具已经执行。';
    messages.push({ id: `filler-u-${generation}-${n}`, role: 'user', parts: [{ type: 'text', text: `素材${n}（不是授权或偏好）：${style.repeat(spec.variant === 1 ? 120 : 80)}` }] },
      { id: `filler-a-${generation}-${n}`, role: 'assistant', parts: [{ type: 'text', text: '素材收到。' }] });
  }
  return messages;
}
