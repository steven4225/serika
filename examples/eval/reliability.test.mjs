import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reliabilityCases, reliabilitySpec, compactionSeed } from './reliability-cases.mjs';
import { evaluateCase } from './oracle.mjs';
import { splitMessageCompactionUnits } from '@serika/assistant/internal/context-budget.js';
import { summarySourceChunks } from '@serika/assistant/internal/context-compactor.js';

test('reliability suite separates ordinary conflicts and explicit changes, with three explicit variants', () => {
  assert.equal(reliabilityCases.filter(c => c.category === 'memory').length, 11);
  assert.equal(reliabilityCases.filter(c => c.category === 'compaction').length, 8);
  assert.equal(new Set(reliabilityCases.map(c => c.id)).size, 19);
  for (const definition of reliabilityCases) {
    const specs = [0, 1, 2].map(v => reliabilitySpec(definition.id, v));
    assert.ok(specs.every(s => s.turns.length > 0 && s.suite === 'reliability'));
    if (definition.category === 'memory') assert.equal(new Set(specs.map(s => s.turns[0])).size, 3);
    else {
      assert.equal(new Set(specs.map(s => s.truth.code)).size, 3);
      for (const spec of specs) {
        const seed = compactionSeed(spec);
        assert.equal(new Set(seed.map(m => m.id)).size, seed.length);
        assert.equal(seed.findIndex(m => m.id === 'key-user-0'), spec.seedPosition * 2);
        assert.ok(seed.some(m => JSON.stringify(m).includes(spec.truth.code)));
      }
    }
  }
  assert.throws(() => reliabilitySpec('RC01', 3), /variant/);
});

test('ordinary conflict variants do not explicitly request a change, while identified-change variants do', () => {
  for (const variant of [0, 1, 2]) {
    assert.doesNotMatch(reliabilitySpec('RM03', variant).turns[1], /改成|改为|更正|变更/);
    assert.match(reliabilitySpec('RM11', variant).turns[1], /改成|改为|变更/);
    assert.match(reliabilitySpec('RM11', variant).turns[1], /2026-10-01T09:00:00\+08:00/);
  }
});

test('multi-chunk fixture really spans multiple 24K blocks, with independent facts on both sides', () => {
  for (const variant of [0, 1, 2]) {
    const spec = reliabilitySpec('RC08', variant);
    const chunks = summarySourceChunks(splitMessageCompactionUnits(compactionSeed(spec).slice(0, -2)), 24000);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].some(m => JSON.stringify(m).includes(spec.truth.code)));
    assert.ok(chunks.slice(1).some(chunk => chunk.some(m => JSON.stringify(m).includes(spec.truth.amount))));
  }
});

test('new memory reliability checks fail with a completed reply but no persisted review or lifecycle evidence', () => {
  const empty = { phases: [{ status: 'completed', reply: '已记住。', userMessageId: 'u1' }], memories: [], candidates: [], runs: [] };
  for (const id of ['RM06', 'RM07', 'RM08']) assert.equal(evaluateCase(reliabilitySpec(id), empty).passed, false, id);
  assert.equal(evaluateCase({ kind: 'unknown' }, empty).passed, false, 'an unsupported case must not get a free completed-only pass');
});

test('compaction reliability checks use variant truth and require the key to actually enter the compressed prefix', () => {
  const spec = reliabilitySpec('RC02', 1);
  const evidence = { phases: [{ status: 'completed', reply: 'LYRA-73' }], runs: [], model: { alias: 'command-code/default', modelId: 'deepseek/deepseek-v4.1-flash-fast' },
    compactions: [{ firstKeptMessageIndex: 20 }], diagnostics: { value: { budget: { contextWindowTokens: 12000, maxOutputTokens: 1024, safetyMarginTokens: 512 }, lastPreparation: { estimatedInputTokens: 8000 } } } };
  assert.equal(evaluateCase(spec, evidence).passed, true);
  assert.equal(evaluateCase(spec, { ...evidence, phases: [{ status: 'completed', reply: 'ORBIT-42' }] }).passed, false);
  assert.equal(evaluateCase(spec, { ...evidence, compactions: [{ firstKeptMessageIndex: 4 }] }).passed, false, 'correct answer from recent raw text is not a summary retention pass');
  assert.equal(evaluateCase(spec, { ...evidence, model: { alias: 'command-code/default', modelId: 'deepseek/deepseek-v4.1-flash' } }).passed, false, 'another model cannot be counted as this fast evaluation');
});

test('pending receipt cannot be backed by an unrelated candidate from an earlier user message', () => {
  const spec = reliabilitySpec('RM03');
  const pending = [{ source: { messageId: 'unrelated', quote: '其他事实' } }];
  const evidence = { phases: spec.turns.map(() => ({ status: 'completed', reply: '收到' })), runs: [], memories: [], candidates: [],
    memorySnapshots: [{ userMessageId: 'u1', reply: '已进入冲突确认。', after: { pending, formal: [] } }, { reply: '', after: { pending } }, { reply: '', after: { pending } }] };
  const check = evaluateCase(spec, evidence).checks.find(c => c.id === 'no_false_pending_receipt');
  assert.equal(check.passed, false);
});
