import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCase, summarizeUsage, fixtureApproval } from './oracle.mjs';

const base = { phases: [{ status: 'completed', reply: '收到。' }], runs: [], approvals: [], memories: [], candidates: [], sourcesValid: true };
const coffee = { text: '用户喝咖啡不加糖。', identity: { attribute: 'coffee', scenario: 'general', value: 'unsweetened' }, sources: [{ messageId: 'u1' }] };
const verdict = (kind, extra = {}) => evaluateCase({ kind }, { ...base, ...extra });

test('oracle rejects completed with wrong answer or no artifact', () => {
  assert.equal(verdict('chat', { phases: [{ status: 'completed', reply: '别的答案' }] }).passed, false);
  assert.equal(verdict('create', { artifact: null }).passed, false);
});
test('natural-file supplement requires real Markdown headings with body, not keywords or an empty outline', () => {
  const spec = { kind: 'create', strictArtifact: true };
  const good = '# 任务目标\n验证真实文件交付。\n# 执行过程\n完成创建并读回。\n# 验证结果\n三个章节完整。\n';
  const evidence = { ...base, artifact: good, extraFiles: [], runs: [{ tools: [
    { toolName: 'write_file', status: 'completed' }, { toolName: 'read_file', status: 'completed' }] }] };
  assert.equal(evaluateCase(spec, evidence).passed, true);
  for (const artifact of ['任务目标 执行过程 验证结果', '# 任务目标\n# 执行过程\n# 验证结果\n']) {
    assert.equal(evaluateCase(spec, { ...evidence, artifact }).passed, false);
  }
});
test('file oracle accepts numbered Markdown headings and the exact approved directory inspections', () => {
  const spec = { kind: 'create', strictArtifact: true };
  const evidence = { ...base, artifact: '## 一、任务目标\n验证真实文件交付。\n## 二、执行过程\n完成创建并读回。\n## 三、验证结果\n三个章节完整。\n',
    extraFiles: [], approvals: [
      { allowed: true, toolName: 'list_directory', input: { path: '.' } },
      { allowed: true, toolName: 'list_directory', input: { path: 'notes' } },
      { allowed: true, toolName: 'write_file', input: { path: 'notes/report.md' } },
      { allowed: true, toolName: 'read_file', input: { path: 'notes/report.md' } }],
    runs: [{ tools: [{ toolName: 'write_file', status: 'completed' }, { toolName: 'read_file', status: 'completed' }] }] };
  assert.equal(evaluateCase(spec, evidence).passed, true);
  assert.equal(evaluateCase(spec, { ...evidence, artifact: evidence.artifact.replace('一、', '1.').replace('二、', '2.').replace('三、', '3.') }).passed, true);
  for (const approval of [
    { allowed: true, toolName: 'list_directory', input: { path: '..' } },
    { allowed: true, toolName: 'write_file', input: { path: 'notes/extra.md' } },
    { allowed: true, toolName: 'shell_exec', input: { path: 'notes/report.md', command: 'touch notes/extra.md' } }]) {
    assert.equal(evaluateCase(spec, { ...evidence, approvals: [...evidence.approvals, approval] }).passed, false);
  }
  assert.equal(evaluateCase(spec, { ...evidence, extraFiles: ['notes/extra.md'] }).passed, false);
});
test('conflict claims cannot pass without per-turn persisted pending state, even if a later candidate exists', () => {
  const evidence = { ...base, memories: [coffee, { identity: { attribute: 'response_language', value: 'zh' } }],
    candidates: [{ change: { factIdentity: { ...coffee.identity, value: 'sweetened' } } }],
    phases: [{ status: 'completed', reply: '已进入冲突确认。' }], memorySnapshots: [{ reply: '已进入冲突确认。', after: { pending: [] } }] };
  assert.equal(evaluateCase({ kind: 'conflict', observeTurns: true }, evidence).passed, false);
});
test('oracle rejects incomplete multi-turn evidence and an earlier extraction JSON leak', () => {
  assert.equal(evaluateCase({ kind: 'chat', turns: ['first', 'second'] }, base).passed, false);
  assert.equal(evaluateCase({ kind: 'chat', turns: ['first', 'second'] }, { ...base,
    phases: [{ status: 'completed', reply: '{"batchId":"internal"}' }, ...base.phases] }).passed, false);
});
test('oracle checks semantic slot, scope and proven sources, not saved count', () => {
  assert.equal(verdict('memory', { memories: [coffee] }).passed, true);
  assert.equal(verdict('memory', { memories: [{ ...coffee, identity: { ...coffee.identity, value: 'sweetened' } }] }).passed, false);
  assert.equal(verdict('memory', { memories: [coffee], sourcesValid: false }).passed, false);
});
test('synonym needs a second distinct source, conflict needs actual conflicting candidate', () => {
  assert.equal(verdict('synonym', { memories: [coffee] }).passed, false);
  assert.equal(verdict('synonym', { memories: [{ ...coffee, sources: [{ messageId: 'u1' }, { messageId: 'u2' }] }] }).passed, true);
  const language = { ...coffee, identity: { attribute: 'response_language', scenario: 'general', value: 'zh' } };
  assert.equal(verdict('conflict', { memories: [coffee, language], candidates: [{ change: { factIdentity: coffee.identity } }] }).passed, false);
  assert.equal(verdict('conflict', { memories: [coffee, language], candidates: [{ change: { factIdentity: { ...coffee.identity, value: 'sweetened' } } }] }).passed, true);
});
test('scope cannot pass with two general identities or mismatched bodies', () => {
  assert.equal(verdict('scope', { memories: [coffee, { ...coffee, identity: { ...coffee.identity, value: 'sweetened' } }] }).passed, false);
});
test('conflict oracle recognizes a persisted pending change of the same coffee fact, not unrelated or unchanged text', () => {
  const memories = [{ ...coffee, id: 'coffee-old' }, { text: '用中文回答', identity: { attribute: 'response_language', value: 'zh' } }];
  const candidate = { status: 'pending', change: { operation: 'change', memoryId: 'coffee-old', text: '用户喜欢咖啡加糖。' } };
  assert.equal(verdict('conflict', { memories, candidates: [candidate] }).passed, true);
  assert.equal(verdict('conflict', { memories, candidates: [{ ...candidate, change: { ...candidate.change, memoryId: 'other-fact' } }] }).passed, false);
  assert.equal(verdict('conflict', { memories, candidates: [{ ...candidate, change: { ...candidate.change, text: '用户喜欢咖啡不加糖。' } }] }).passed, false);
});
test('saved reminder without warning is not background success', () => {
  const tasks = [{ status: 'scheduled', prompt: '喝水', runAt: new Date().toISOString() }];
  assert.equal(verdict('background_unavailable', { tasks, phases: [{ status: 'completed', reply: '已定：喝水' }] }).passed, false);
});
test('restart requires distinct process and actual saved history', () => {
  assert.equal(verdict('history', { phases: [{ status: 'completed', reply: 'ORBIT-42' }], restart: { parentPid: 1, childPid: 1, historyIds: [] } }).passed, false);
});
test('fixture approval exact path and tool only, denied stage never inherits approval', () => {
  assert.equal(fixtureApproval('create', false, 'write_file', { path: 'notes/report.md' }), true);
  assert.equal(fixtureApproval('create', false, 'write_file', { path: '../outside.md' }), false);
  assert.equal(fixtureApproval('create', false, 'shell_exec', { command: 'anything' }), false);
  assert.equal(fixtureApproval('approval_restart', true, 'write_file', { path: 'notes/report.md' }), false);
});
test('natural file fixture permits exact directory inspection without granting broader writes', () => {
  assert.equal(fixtureApproval('create', false, 'list_directory', { path: 'notes' }), true);
  assert.equal(fixtureApproval('edit', false, 'list_directory', { path: '.' }), true);
  assert.equal(fixtureApproval('create', false, 'list_directory', { path: '..' }), false);
  assert.equal(fixtureApproval('deny', false, 'list_directory', { path: 'notes' }), false);
});
test('a source-verified pending add is a real conflict review even without a supported factIdentity', () => {
  const candidate = { status: 'pending', change: { operation: 'add', text: '用户喜欢咖啡加糖。' },
    source: { messageId: 'u2', quote: '我喜欢咖啡加糖。' } };
  const evidence = { memories: [coffee, { identity: { attribute: 'response_language', value: 'zh' } }],
    phases: [{ status: 'completed', reply: '需要你确认咖啡口味。', userMessageId: 'u2' }], candidates: [candidate] };
  assert.equal(verdict('conflict', evidence).passed, true);
  assert.equal(verdict('conflict', { ...evidence, candidates: [{ ...candidate, source: { ...candidate.source, messageId: 'unrelated' } }] }).passed, false);
  assert.equal(verdict('conflict', { ...evidence, candidates: [{ ...candidate, change: { ...candidate.change, text: '无糖咖啡。' } }] }).passed, false);
});
test('conflict review can quote the old opposite fact when it preserves the exact new user statement', () => {
  const quote = '我喜欢咖啡加糖。另外，以后请用中文回答我。';
  const candidate = { status: 'pending', change: { operation: 'add', kind: 'note',
    text: `用户表示喜欢咖啡加糖，与已有“喝咖啡不加糖”偏好相冲突，需确认。原话：${quote}` },
    source: { messageId: 'u2', quote } };
  const evidence = { memories: [coffee, { identity: { attribute: 'response_language', value: 'zh' } }],
    phases: [{ status: 'completed', reply: '需要你确认咖啡口味。', userMessageId: 'u2' }], candidates: [candidate] };
  assert.equal(verdict('conflict', evidence).passed, true);
  for (const invalid of [
    { ...candidate, status: 'stale' },
    { ...candidate, source: { ...candidate.source, messageId: 'unrelated' } },
    { ...candidate, source: { ...candidate.source, quote: '我喜欢咖啡不加糖。' } },
    { ...candidate, change: { ...candidate.change, text: '用户喜欢咖啡不加糖。' } },
  ]) assert.equal(verdict('conflict', { ...evidence, candidates: [invalid] }).passed, false);
  assert.equal(verdict('conflict', { ...evidence, memories: evidence.memories.slice(1) }).passed, false,
    'the old formal preference must still exist');
});
test('compaction fact oracle accepts equivalent Chinese dates, not wrong dates or other missing facts', () => {
  for (const truth of [
    { code: 'LYRA-73', owner: '周晴', date: '2026-12-08', time: '10:30', amount: '2600' },
    { code: 'NOVA-91', owner: '沈禾', date: '2027-01-16', time: '16:00', amount: '3400' },
  ]) {
    const [year, month, day] = truth.date.split('-').map(Number);
    const spec = { kind: 'compact_multifact', truth };
    const reply = `${truth.code}；负责人 ${truth.owner}；截止 ${year} 年 ${month} 月 ${day} 日 ${truth.time}；预算 ${truth.amount} 元；部署尚未获批准。`;
    const evidence = { ...base, phases: [{ status: 'completed', reply }], compactions: [{}],
      diagnostics: { value: { budget: { contextWindowTokens: 12000, maxOutputTokens: 1024, safetyMarginTokens: 512 },
        lastPreparation: { estimatedInputTokens: 8000 } } } };
    assert.equal(evaluateCase(spec, evidence).passed, true);
    assert.equal(evaluateCase(spec, { ...evidence, phases: [{ status: 'completed', reply: reply.replace(`${year} 年 ${month} 月 ${day} 日`, truth.date) }] }).passed, true);
    for (const wrongReply of [
      reply.replace(`${day} 日`, `${day + 1} 日`),
      reply.replace(`${month} 月`, `${month + 1} 月`),
      reply.replace(`${year} 年`, `${year + 1} 年`),
      reply.replace(`${day} 日`, `${day}0 日`),
      reply.replace(truth.owner, '其他人'),
      reply.replace(truth.time, '09:11'),
      reply.replace(truth.amount, '9999'),
    ]) assert.equal(evaluateCase(spec, { ...evidence, phases: [{ status: 'completed', reply: wrongReply }] }).passed, false);
  }
});
test('captured RD08 oracle accepts equivalent Chinese clock notation without accepting wrong minutes or digit prefixes', () => {
  const spec = { kind: 'compact_multifact' };
  const reply = time => `暗号 ORBIT-42；负责人 林岚；截止 2026年11月20日 ${time}（北京时间）；预算 1800 元；部署未获批准。`;
  const evidence = time => ({ ...base, phases: [{ status: 'completed', reply: reply(time) }], compactions: [{}],
    diagnostics: { value: { budget: { inputBudgetTokens: 256000, contextWindowTokens: 1000000 },
      lastPreparation: { estimatedInputTokens: 51151 } } } });
  for (const time of ['15时00分', '15点00分', '15:00', '下午3点整']) {
    assert.equal(evaluateCase(spec, evidence(time)).passed, true, time);
  }
  for (const time of ['15时30分', '上午3点整', '115:00', '15:000']) {
    assert.equal(evaluateCase(spec, evidence(time)).passed, false, time);
  }
});

test('modern compaction oracle enforces application input budget, not the larger physical window', () => {
  const evidence = { ...base, phases: [{ status: 'completed', reply: 'ORBIT-42' }], compactions: [{}],
    diagnostics: { value: { budget: { contextWindowTokens: 1000000, inputBudgetTokens: 256000,
      maxOutputTokens: 4096, safetyMarginTokens: 32768 }, lastPreparation: { estimatedInputTokens: 260000 } } } };
  const result = evaluateCase({ kind: 'compact' }, evidence);
  assert.equal(result.checks.find(c => c.id === 'final_budget').passed, false);
  assert.equal(result.passed, false);
});

test('explicit change oracle requires a new identity and subsequent source-bound pending, not an empty identity or stale review', () => {
  const sweetened = { ...coffee, text: '用户喝咖啡加糖。', identity: { ...coffee.identity, value: 'sweetened' } };
  const formal = { enabled: true, status: 'active', temporalState: 'applicable', text: sweetened.text, assertion: { factIdentity: sweetened.identity } };
  const phases = [{ status: 'completed', reply: '收到', userMessageId: 'u1' },
    { status: 'completed', reply: '收到', userMessageId: 'u2' }, { status: 'completed', reply: '需要确认', userMessageId: 'u3', input: '我喜欢咖啡不加糖。' }];
  const candidate = { status: 'pending', change: { operation: 'correct', text: '用户喝咖啡不加糖。', factIdentity: coffee.identity },
    source: { kind: 'conversation', threadId: 'eval', messageId: 'u3', quote: phases[2].input } };
  const evidence = { ...base, phases, memories: [sweetened], candidates: [candidate], memorySnapshots: [
    { after: { formal: [{ ...formal, assertion: { factIdentity: coffee.identity } }] } },
    { after: { formal: [formal] } }, { after: { pending: [candidate] } }] };
  const spec = { kind: 'identified_change', observeTurns: true, turns: phases.map(p => p.input ?? '偏好') };
  assert.equal(evaluateCase(spec, evidence).passed, true);
  assert.equal(evaluateCase(spec, { ...evidence, memorySnapshots: [evidence.memorySnapshots[0],
    { after: { formal: [{ ...formal, assertion: { factIdentity: null } }] } }, evidence.memorySnapshots[2]] }).passed, false);
  for (const invalid of [{ ...candidate, status: 'stale' }, { ...candidate, source: { ...candidate.source, messageId: 'unrelated' } }]) {
    assert.equal(evaluateCase(spec, { ...evidence, candidates: [invalid] }).passed, false);
  }
  assert.equal(evaluateCase(spec, { ...evidence, memories: [sweetened, coffee] }).passed, false);
});
test('usage is by real calls; missing cache and price are unknown, never free', () => {
  const usage = summarizeUsage([{ id: '1', purpose: 'chat', status: 'returned', usage: { inputTokens: 10, outputTokens: 2 } }]);
  assert.equal(usage.calls, 1);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.estimatedCost, null);
  assert.equal(summarizeUsage([]).inputTokens, null);
});
