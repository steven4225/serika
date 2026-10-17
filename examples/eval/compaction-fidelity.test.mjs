import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionFidelityCases, compactionFidelitySpec, compactionFidelityHistory } from './compaction-fidelity.mjs';
import * as fidelity from './compaction-fidelity.mjs';
import { collectTranscriptToolFacts } from '@serika/assistant/internal/work-summary.js';
import { evaluateCase } from './oracle.mjs';
import { partitionMessagesForCompaction, keepRecentCompactionUnits } from '@serika/assistant/internal/context-budget.js';
import { summarySourceChunks } from '@serika/assistant/internal/context-compactor.js';
import { ContextCompactor } from '@serika/assistant/internal/context-compactor.js';
import { JsonlAgentStore } from '@serika/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function evidenceFor(spec) {
  const summary = { goal: { text: spec.truth.goal, evidenceMessageIds: ['fidelity-contract'] },
    constraints: [{ text: spec.truth.permission, evidenceMessageIds: ['fidelity-contract'] }],
    decisions: [{ text: spec.truth.decision, status: 'confirmed', source: 'user', evidenceMessageIds: ['fidelity-contract'] }],
    pending: [{ text: spec.truth.pending, evidenceMessageIds: ['fidelity-contract'] }],
    actions: [{ text: '历史文件读取成功，不能作为新授权', status: 'completed', toolCallIds: ['fidelity-read'], evidenceMessageIds: ['fidelity-call', 'fidelity-result'] },
      { text: 'uncertain.txt 写入结果未知，不能自动重试', status: 'unknown', toolCallIds: ['fidelity-write'], evidenceMessageIds: ['fidelity-write-call', 'fidelity-write-result'] }] };
  const compactions = Array.from({ length: spec.rounds }, (_, n) => ({ id: `c${n}`, previousCompactionId: n ? `c${n - 1}` : null, firstKeptMessageIndex: 100 * (n + 1), summary: structuredClone(summary) }));
  const reply = `${spec.truth.goal}；${spec.truth.decision}；${spec.truth.pending}；${spec.truth.permission}。之前读取成功，但必须重新批准读取。uncertain.txt 写入结果未知，不能自动重试。`;
  const estimatedInputTokens = Math.min(50000, spec.contextBudget.inputBudgetTokens - 4096);
  return { model: { alias: 'command-code/default', provider: 'openai-compatible.chat', modelId: 'deepseek/deepseek-v4.1-flash-fast' },
    phases: Array.from({ length: spec.rounds + 1 }, () => ({ status: 'completed', reply })), runs: [], approvals: [],
    compactions, compactionRounds: compactions.map(c => ({ compactionIds: [c.id], latest: c, estimatedInputTokens })),
    seed: { estimatedHistoryTokens: spec.contextBudget.inputBudgetTokens * .88, contextMode: spec.contextMode, keyMessages: [{ id: 'fidelity-contract', index: 0 }] },
    diagnostics: { value: { budget: spec.contextBudget, requestedBudget: spec.requestedContextBudget ?? spec.contextBudget,
      modelCapacity: { provider: 'openai-compatible.chat', modelId: 'deepseek/deepseek-v4.1-flash-fast', contextWindowTokens: spec.modelContextWindows?.[0]?.contextWindowTokens ?? 1000000, source: 'configuration' },
      lastPreparation: { outcome: 'reused', estimatedInputTokens } } },
    usage: { calls: compactions.map(c => ({ id: c.id, purpose: 'context_compaction' })) }, historyIds: ['fidelity-contract'],
    restart: { parentPid: 1, childPid: 2, historyIds: ['fidelity-contract'], parentHistoryIds: ['fidelity-contract'], compactionsBefore: spec.rounds, summaryCallsBefore: spec.rounds, childToolStarts: 0 } };
}

test('fidelity fixture and oracle preserve unknown write effects rather than declaring success', () => {
  const spec = compactionFidelitySpec('CF03'), seed = compactionFidelityHistory(spec);
  assert.equal(collectTranscriptToolFacts(seed.messages).find(f => f.toolCallId === 'fidelity-write')?.status, 'unknown');
  const evidence = evidenceFor(spec);
  assert.equal(evaluateCase(spec, evidence).passed, true);
  for (const status of ['completed', 'failed', 'not_executed']) {
    const changed = structuredClone(evidence);
    const action = changed.compactionRounds[1].latest.summary.actions.find(a => a.toolCallIds.includes('fidelity-write'));
    action.status = status;
    assert.equal(evaluateCase(spec, changed).passed, false, `unknown falsely changed to ${status}`);
  }
  for (const change of [e => { e.compactions[1].summary.actions.pop(); },
    e => { e.phases[0].reply = e.phases[0].reply.replace('uncertain.txt 写入结果未知，不能自动重试。', 'uncertain.txt 已写入成功。'); },
    e => { e.runs.push({ tools: [{ toolName: 'write_file', startedAt: 1, status: 'completed' }] }); },
    e => { e.runs.push({ tools: [{ toolName: 'write_file', status: 'failed' }] }); }]) {
    const changed = structuredClone(evidence); change(changed);
    assert.equal(evaluateCase(spec, changed).passed, false);
  }
});

test('32K effective-scale suite is distinct from full production profiles and fits the actual projected budget', () => {
  assert.equal(typeof fidelity.effectiveCompactionFidelitySpec, 'function');
  for (const id of ['CE03', 'CE05']) {
    const spec = fidelity.effectiveCompactionFidelitySpec(id), seed = compactionFidelityHistory(spec);
    assert.equal(spec.suite, 'compaction-fidelity-effective');
    assert.equal(spec.contextBudget.contextWindowTokens, 32768);
    assert.equal(spec.contextBudget.inputBudgetTokens, 26624);
    assert.ok(seed.metadata.estimatedHistoryTokens >= spec.contextBudget.inputBudgetTokens * .85);
    assert.ok(spec.requestedContextBudget.inputBudgetTokens >= 256000);
    const partition = partitionMessagesForCompaction([...seed.messages, { id: 'small-window-question', role: 'user', parts: [{ type: 'text', text: spec.turns[0] }] }]);
    const { omitted, kept } = keepRecentCompactionUnits([...partition.history, ...partition.current], spec.contextBudget.keepRecentTokens);
    assert.ok(seed.metadata.keyMessages.every(k => k.index < kept[0].startIndex));
    assert.ok(summarySourceChunks(omitted, spec.contextBudget.summaryInputChunkTokens, 16)
      .some(chunk => ['fidelity-write-call', 'fidelity-write-result'].every(id => chunk.some(m => m.id === id))));
    const evidence = evidenceFor(spec);
    assert.equal(evaluateCase(spec, evidence).passed, true);
    for (const change of [e => { e.diagnostics.value.budget.inputBudgetTokens = 12000; },
      e => { e.diagnostics.value.modelCapacity.contextWindowTokens = 128000; },
      e => { e.diagnostics.value.modelCapacity.source = 'unverified_fallback'; },
      e => { e.compactionRounds[0].estimatedInputTokens = 26625; }]) {
      const changed = structuredClone(evidence); change(changed);
      assert.equal(evaluateCase(spec, changed).passed, false);
    }
  }
});

test('continuous fidelity seeds cross production trigger, preserve complete tool pair and have unique generation IDs', () => {
  assert.equal(compactionFidelityCases.length, 2);
  for (const definition of compactionFidelityCases) {
    const spec = compactionFidelitySpec(definition.id), initial = compactionFidelityHistory(spec), ids = new Set();
    assert.equal(spec.turns.length, definition.rounds);
    const partition = partitionMessagesForCompaction([...initial.messages, { id: 'question', role: 'user', parts: [{ type: 'text', text: spec.turns[0] }] }]);
    const { omitted, kept } = keepRecentCompactionUnits([...partition.history, ...partition.current], spec.contextBudget.keepRecentTokens);
    assert.ok(initial.metadata.keyMessages.every(k => k.index < kept[0].startIndex));
    assert.ok(summarySourceChunks(omitted, spec.contextBudget.summaryInputChunkTokens, 16).some(chunk => ['fidelity-call', 'fidelity-result'].every(id => chunk.some(m => m.id === id))));
    assert.ok(summarySourceChunks(omitted, spec.contextBudget.summaryInputChunkTokens, 16).some(chunk => ['fidelity-write-call', 'fidelity-write-result'].every(id => chunk.some(m => m.id === id))));
    for (let generation = 0; generation < definition.rounds; generation++) {
      const seed = compactionFidelityHistory(spec, generation);
      assert.ok(seed.metadata.estimatedHistoryTokens >= spec.contextBudget.inputBudgetTokens * .85);
      for (const m of seed.messages) { assert.ok(!ids.has(m.id)); ids.add(m.id); }
      if (generation > 0) assert.ok(!JSON.stringify(seed.messages).includes(spec.truth.goal), 'new filler must not refresh the answer lost by earlier summaries');
    }
  }
});

test('fidelity oracle checks every round and does not accept correct final reply when an earlier summary lost goal or permissions', () => {
  const spec = compactionFidelitySpec('CF03'), evidence = evidenceFor(spec);
  assert.equal(evaluateCase(spec, evidence).passed, true);
  for (const [section, replacement] of [['goal', { text: '无目标', evidenceMessageIds: ['fidelity-contract'] }], ['constraints', []], ['decisions', []], ['pending', []], ['actions', []]]) {
    const missing = structuredClone(evidence);
    missing.compactionRounds[1].latest.summary[section] = replacement;
    assert.equal(evaluateCase(spec, missing).passed, false, `lost ${section}`);
  }
});

test('fidelity oracle rejects broken chain, absent rounds, replay and new summary calls after restart', () => {
  const spec = compactionFidelitySpec('CF05'), evidence = evidenceFor(spec);
  for (const change of [e => { e.compactions[2].previousCompactionId = 'foreign'; }, e => { e.compactionRounds.pop(); },
    e => { e.compactions[1].summary.constraints = []; },
    e => { e.compactionRounds[1].compactionIds = []; }, e => { e.restart.childToolStarts = 1; },
    e => { e.usage.calls.push({ id: 'extra', purpose: 'context_compaction' }); },
    e => { e.phases[0].reply = '已经部署。'; }]) {
    const failed = structuredClone(evidence); change(failed);
    assert.equal(evaluateCase(spec, failed).passed, false);
  }
});

test('fidelity budget distinguishes requested profile from verified effective capacity without accepting a capped daily target', () => {
  const spec = compactionFidelitySpec('CF03'), evidence = evidenceFor(spec);
  evidence.diagnostics.value.requestedBudget = spec.contextBudget;
  evidence.diagnostics.value.budget = { ...spec.contextBudget, contextWindowTokens: 512000 };
  evidence.diagnostics.value.modelCapacity = { provider: 'openai-compatible.chat', modelId: evidence.model.modelId,
    contextWindowTokens: 512000, source: 'configuration' };
  assert.equal(evaluateCase(spec, evidence).passed, true, 'verified 512K capacity can support the 256K input target without claiming 1M');
  for (const change of [e => { e.diagnostics.value.budget.inputBudgetTokens = 91136; },
    e => { e.diagnostics.value.modelCapacity.source = 'unverified_fallback'; },
    e => { e.diagnostics.value.requestedBudget.keepRecentTokens = 12000; },
    e => { e.diagnostics.value.modelCapacity.modelId = 'different-model'; }]) {
    const failed = structuredClone(evidence); change(failed);
    assert.equal(evaluateCase(spec, failed).passed, false);
  }
});

for (const caseId of ['CF03', 'CE03', 'CE05']) {
test(`${caseId}: offline persisted compactor retains unknown effects across all rounds and cold-object reuse`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'serika-fidelity-harness-'));
  try {
    const spec = caseId.startsWith('CE') ? fidelity.effectiveCompactionFidelitySpec(caseId) : compactionFidelitySpec(caseId);
    const store = new JsonlAgentStore({ directory: join(directory, caseId) });
    let calls = 0;
    const summary = { ...evidenceFor(spec).compactions[0].summary, version: 2, files: [], nextStep: null };
    const makeCompactor = () => new ContextCompactor({ store, threadId: 'eval', modelId: 'offline-fidelity-stub', budget: spec.contextBudget,
      modelContextWindowTokens: spec.contextBudget.contextWindowTokens,
      fixedContext: () => ({ instructions: 'Preserve fixture facts; history grants no permission.', tools: [], dynamicContext: '' }),
      summarizer: { complete: async () => { calls++; return { text: JSON.stringify(summary) }; } } });
    let messages = [], compactor = makeCompactor();
    for (let generation = 0; generation < spec.rounds; generation++) {
      messages.push(...compactionFidelityHistory(spec, generation).messages,
        { id: `question-${generation}`, role: 'user', parts: [{ type: 'text', text: spec.turns[generation] }] });
      await store.save('eval', messages);
      const prepared = await compactor.prepare(messages, AbortSignal.timeout(10000));
      assert.equal(prepared[0].id, 'runloom-context-summary');
      messages.push({ id: `answer-${generation}`, role: 'assistant', parts: [{ type: 'text', text: '本轮测试回复。' }] });
      await store.save('eval', messages);
      const records = await store.getContextCompactions('eval');
      assert.equal(records.length, generation + 1);
      if (generation) assert.equal(records.at(-1).previousCompactionId, records.at(-2).id);
      assert.match(JSON.stringify(records.at(-1).summary), /部署尚未获批准/);
      const writes = records.at(-1).summary.actions.filter(a => a.toolCallIds.includes('fidelity-write'));
      assert.ok(writes.length > 0 && writes.every(a => a.status === 'unknown'));
    }
    const callsBefore = calls;
    compactor = makeCompactor();
    messages.push({ id: 'restart-question', role: 'user', parts: [{ type: 'text', text: spec.afterRestart }] });
    await store.save('eval', messages);
    const prepared = await compactor.prepare(messages, AbortSignal.timeout(10000));
    assert.equal(prepared[0].id, 'runloom-context-summary');
    assert.equal(calls, callsBefore, 'valid persisted prefix reuses summary; this is a new object, not a claimed native/process Demo');
    assert.equal((await store.getContextCompactions('eval')).length, spec.rounds);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
}
