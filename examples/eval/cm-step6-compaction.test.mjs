import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextCompactor } from '@serika/assistant/internal/context-compactor.js';
import { blockLimits, summaryText, reduceSummarySection } from '@serika/assistant/internal/context-blocks.js';
import { estimateMessageTokens, estimateSerializedTokens } from '@serika/assistant/internal/context-budget.js';
import { effectiveCompactionFidelitySpec, compactionFidelityHistory } from './compaction-fidelity.mjs';

class Store {
  messages = []; records = [];
  async getMessages() { return structuredClone(this.messages); }
  async getContextCompactions() { return structuredClone(this.records); }
  async appendContextCompaction(record) { this.records.push(structuredClone(record)); }
}
const user = (id, text) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const item = text => ({ text, evidenceMessageIds: ['fidelity-contract'] });
const core = { version: 2, goal: item('完成验收报告'), constraints: [item('部署尚未获批准，旧读取回执不授予新的读取权限')],
  decisions: [{ ...item('采用本地文件方案'), source: 'user', status: 'confirmed' }], pending: [item('补充失败样本')], actions: [], files: [], nextStep: null };
const open = (store, budget, complete) => new ContextCompactor({ store, threadId: 'eval', modelId: 'offline-fixture', budget,
  fixedContext: () => ({ instructions: 'Maintain original constraints.', tools: [] }), summarizer: { complete } });
const signal = () => AbortSignal.timeout(30000);

test('unpublished CE03/CE05 blocks remain visible after failed background work below the hard-input trigger', async () => {
  const spec = effectiveCompactionFidelitySpec('CE05'), limits = blockLimits(spec.contextBudget), store = new Store();
  store.messages = [...compactionFidelityHistory(spec).messages.slice(0, 6),
    ...Array.from({ length: 3 }, (_, i) => user(`background-${i}`, 'x'.repeat(limits.block * 2))), user('current', spec.turns[0])];
  const original = structuredClone(store.messages); let calls = 0;
  const compactor = open(store, spec.contextBudget, async () => { calls++; return { text: '{}' }; });
  assert.ok(estimateMessageTokens(store.messages) < spec.contextBudget.inputBudgetTokens * spec.contextBudget.triggerRatio);
  for (const stage of ['before', 'failed']) {
    const prepared = await compactor.prepare(store.messages, signal());
    assert.ok(prepared.some(message => message.id === 'fidelity-result'), stage);
    assert.ok(prepared.some(message => message.id === 'fidelity-call'), stage);
    assert.equal(calls, stage === 'before' ? 0 : 1);
    if (stage === 'before') await compactor.runPending(signal());
  }
  assert.equal(store.records.length, 0); assert.deepEqual(store.messages, original);
});

test('CE03/CE05 offline generations including CE05 generation 3 reduce optional overflow and preserve host read/unknown receipts', async () => {
  for (const id of ['CE03', 'CE05']) {
    const spec = effectiveCompactionFidelitySpec(id), limits = blockLimits(spec.contextBudget), store = new Store();
    let generation = 0, calls = 0;
    const complete = async ({ prompt }) => {
      calls++;
      return { text: JSON.stringify({ ...core, constraints: [...core.constraints, item(core.constraints[0].text.repeat(20))], files: [{ ...item('old file details'), path: 'notes/old.md', purpose: 'detail'.repeat(limits.section) }],
        ...(prompt.includes('farIndex string') ? { farIndex: 'Older file details\n'.repeat(limits.section) } : {}) }) };
    };
    let compactor = open(store, spec.contextBudget, complete);
    for (; generation < spec.rounds; generation++) {
      store.messages.push(...compactionFidelityHistory(spec, generation).messages, user(`${id}-probe-${generation}`, spec.turns[generation]));
      const original = structuredClone(store.messages), before = calls;
      const first = await compactor.prepare(store.messages, signal()); assert.equal(calls, before);
      const receipts = JSON.stringify(first);
      assert.match(receipts, /fidelity-read/); assert.match(receipts, /completed/); assert.match(receipts, /fidelity-write/); assert.match(receipts, /unknown/);
      while (compactor.pending) await compactor.runPending(signal());
      assert.equal(compactor.backgroundError, undefined, `${id}/${generation}`);
      const prepared = await compactor.prepare(store.messages, signal()), text = JSON.stringify(prepared);
      for (const required of ['完成验收报告', '本地文件', '失败样本', '批准', 'fidelity-read', 'completed', 'fidelity-write', 'unknown']) assert.ok(text.includes(required), `${id}/${generation}/${required}`);
      const diagnostic = (await compactor.getDiagnostics()).value.lastPreparation;
      assert.ok(diagnostic.estimatedInputTokens <= spec.contextBudget.inputBudgetTokens);
      assert.ok(store.records.some(record => estimateSerializedTokens(summaryText(record.summary)) > limits.section));
      assert.ok(diagnostic.summaryLayer.tokens <= limits.totalSummary + diagnostic.summaryLayer.borrowedTokens);
      assert.deepEqual(store.messages, original);
      console.info('CM_STEP6_METRICS ' + JSON.stringify({ case: 'CE offline overflow and receipt retention', id, generation, records: store.records.length, realModelCalls: 0, preparation: diagnostic }));
      compactor = open(store, spec.contextBudget, complete);
    }
  }
});


test('host reduction removes completed actions and file details while preserving structured essentials', () => {
  const budget = effectiveCompactionFidelitySpec('CE05').contextBudget, limit = blockLimits(budget).section;
  const summary = { ...core, actions: [{ ...item('old read details '.repeat(limit)), status: 'completed', toolCallIds: ['read'] },
    { ...item('unresolved effect'), status: 'unknown', toolCallIds: ['write'] }],
    files: [{ ...item('old file'), path: 'notes/old.md', purpose: 'detail'.repeat(limit) }] };
  const before = structuredClone(summary), reduced = reduceSummarySection(summary, limit);
  assert.equal(reduced.files.length, 0); assert.equal(reduced.actions.length, 1); assert.equal(reduced.actions[0].status, 'unknown');
  for (const key of ['goal', 'constraints', 'decisions', 'pending']) assert.deepEqual(reduced[key], summary[key]);
  assert.ok(estimateSerializedTokens(summaryText(reduced)) <= limit); assert.deepEqual(summary, before);
});

test('far index retains opaque clauses when archived structured coverage is incomplete', async () => {
  const spec = effectiveCompactionFidelitySpec('CE05'), store = new Store();
  const complete = async ({ prompt }) => ({ text: JSON.stringify({ ...core, ...(prompt.includes('farIndex string') ? { farIndex: 'optional old file topic' } : {}) }) });
  store.messages = [...compactionFidelityHistory(spec).messages, user('probe-0', spec.turns[0])];
  let compactor = open(store, spec.contextBudget, complete);
  await compactor.prepare(store.messages, signal());
  while (compactor.pending) await compactor.runPending(signal());
  const record = store.records.at(-1);
  assert.equal(record.layers.index.length, 1);
  record.layers.index[0].text = 'Historical permission: publish only after the owner approves.';
  store.records = [record];
  store.messages.push(...compactionFidelityHistory(spec, 1).messages, user('probe-1', spec.turns[1]));
  compactor = open(store, spec.contextBudget, complete);
  await compactor.prepare(store.messages, signal());
  while (compactor.pending) await compactor.runPending(signal());
  assert.equal(compactor.backgroundError, undefined);
  assert.match(JSON.stringify(await compactor.prepare(store.messages, signal())), /publish only after the owner approves/);
});

test('overflow checklist retains request and steer references plus complete permissions', async () => {
  const { createCompactionChecklist } = await import('@serika/assistant/internal/compaction-records.js');
  const permissions = { autonomousFiles: false, shell: false, web: { origins: ['https://example.org'] }, fileAuthorizations: [{ path: 'notes' }], blocked: ['write_file'], remembered: ['read_file'] };
  const messages = [user('request', 'Complete the report'), { ...user('correction', 'Keep deployment pending'), metadata: { source: 'steer' } },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `effect-${i}`, role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'write_file', toolCallId: `write-${i}`, state: 'output-error', input: { path: 'notes/uncertain.txt' }, errorText: 'TOOL_OUTCOME_UNKNOWN: dispatched, receipt missing' }] }))];
  const checklist = createCompactionChecklist({ messages, permissions, maxTokens: 100, hardMaxTokens: 1000, preserveRecentReceipts: true, requestReferenceOnly: true });
  const body = JSON.parse(checklist.parts[0].text.split('\n').slice(1).join('\n'));
  assert.equal(body.unknown, 100); assert.equal(body.request, 'request'); assert.deepEqual(body.corrections, ['correction']);
  assert.deepEqual(body.permissions, { files: permissions.autonomousFiles, shell: permissions.shell, web: permissions.web,
    fileAuthorizations: permissions.fileAuthorizations, blocked: permissions.blocked, remembered: permissions.remembered });
});

test('emergency prepare preserves the masked ordinary request and classifies Steer, including overflow', async () => {
  for (const effects of [0, 100]) {
    const spec = effectiveCompactionFidelitySpec('CE05'), store = new Store();
    store.messages = [user('original-request', '请完成 ONLY-ORIGINAL-GOAL 验收报告'),
      ...Array.from({ length: effects }, (_, i) => ({ id: `effect-${i}`, role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'write_file', toolCallId: `write-${i}`, state: 'output-error', input: { path: 'notes/uncertain.txt' }, errorText: 'TOOL_OUTCOME_UNKNOWN: dispatched, receipt missing' }] })),
      { id: 'old-1', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(24000) }] },
      { id: 'old-2', role: 'assistant', parts: [{ type: 'text', text: 'y'.repeat(24000) }] },
      { ...user('correction', '只改输出格式，先给结论'), metadata: { source: 'steer' } }];
    const before = structuredClone(store.messages);
    const compactor = open(store, spec.contextBudget, async () => { throw new Error('foreground must not dispatch'); });
    const prepared = await compactor.prepare(store.messages, signal());
    assert.equal(prepared.some(message => message.id === 'original-request'), false);
    const checklist = prepared.find(message => message.id === 'runloom-compaction-checklist');
    const body = JSON.parse(checklist.parts[0].text.split('\n').slice(1).join('\n'));
    assert.equal(body.request.messageId, 'original-request');
    assert.match(JSON.stringify(body.request), /ONLY-ORIGINAL-GOAL/);
    assert.equal(body.corrections[0].messageId, 'correction');
    assert.match(JSON.stringify(body.corrections), /只改输出格式/);
    assert.deepEqual(store.messages, before);
    assert.ok((await compactor.getDiagnostics()).value.lastPreparation.degradation.reasons.includes('input_limit'));
  }
});
