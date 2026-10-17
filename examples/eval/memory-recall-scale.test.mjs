import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalMemorySemanticIndex } from '@serika/assistant/internal/memory-semantic-index.js';
import { createMemoryStore } from '@serika/assistant/internal/memory-store.js';
import { selectEligibleMemoryEntries } from '@serika/assistant/internal/memory-retrieval.js';
import { makeScaleFixture, scaleSizes, scaleNow, scaleRequestBudget, createScaleRequestGuard, prepareScaleIndex, summarizeScale, runScaleRecall } from './memory-recall-scale.mjs';

test('scale fixtures freeze eight objective queries per corpus, with gold at head/middle/tail and three forbidden facts', () => {
  for (const size of scaleSizes) {
    const fixture = makeScaleFixture(size);
    assert.equal(fixture.facts.length, size);
    assert.equal(fixture.cases.length, 8);
    assert.equal(fixture.facts[0].label, 'review');
    assert.equal(fixture.facts[Math.floor(size / 2)].label, 'work-coffee');
    assert.equal(fixture.facts[size - 4].label, 'home');
    assert.deepEqual(fixture.facts.slice(-3).map(fact => fact.label), ['foreign', 'retracted', 'expired']);
    for (const spec of fixture.cases) {
      assert(spec.gold.every(label => fixture.facts.some(fact => fact.label === label)));
      assert(spec.gold.every(label => !spec.forbidden.includes(label)));
    }
  }
  assert.throws(() => makeScaleFixture(100));
  assert.equal(createHash('sha256').update(JSON.stringify(scaleSizes.map(makeScaleFixture))).digest('hex'), 'eda9e515e7f7ca850145b0abbc50c0d1c61e12fcd598c61ef26413fb5017958a');
});

test('the maximum cost counts cold facts, warmup facts and each query separately, never inventing free queries', () => {
  const budget = scaleRequestBudget();
  assert.equal(budget.embeddingHttpUpperBound, 1226);
  assert.equal(budget.relevanceHttpUpperBound, 48);
  assert.deepEqual(budget.perScale.map(item => item.warmupQuery), [2, 7, 26]);
  assert.equal(budget.perScale.reduce((sum, item) => sum + item.coldFact, 0), 480);
  assert.equal(budget.perScale.reduce((sum, item) => sum + item.warmupFact, 0), 663);
  assert.equal(budget.perScale.reduce((sum, item) => sum + item.coldQuery + item.warmQuery + item.warmupQuery, 0), 83);
});

test('request guard stops before the first dispatch beyond the authorized maximum and disallows unrequested relevance', () => {
  const guard = createScaleRequestGuard({ relevance: true });
  for (let i = 0; i < 1226; i++) guard('embedding');
  assert.throws(() => guard('embedding'), { code: 'request_budget_exhausted' });
  for (let i = 0; i < 48; i++) guard('relevance');
  assert.throws(() => guard('relevance'), { code: 'request_budget_exhausted' });
  assert.throws(() => createScaleRequestGuard()('relevance'), { code: 'request_budget_exhausted' });
});

test('normal warming is scoreable; degraded preparation stops rather than presenting lexical fallback as hybrid evidence', async () => {
  const warming = { lastState: 'warming', lastDiagnostics: { eligibleCount: 512, indexedCount: 20 }, async search() { return []; } };
  assert.equal((await prepareScaleIndex(warming, [], {})).state, 'warming');
  const degraded = { lastState: 'degraded', lastFailure: { code: 'http_error' }, async search() { return []; } };
  await assert.rejects(prepareScaleIndex(degraded, [], {}), { code: 'http_error' });
});

test('cold cache remains partial; independent bounded warmup reaches 509 facts without leaking forbidden inputs', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'recall-scale-test-')));
  try {
    const fixture = makeScaleFixture(512), calls = [];
    const entries = fixture.facts.map(({ label, retract, ...fact }) => ({ ...fact, id: label, revision: 1, enabled: true,
      status: 'active', scope: fact.scope ?? { kind: 'workspace' }, ...(retract ? { temporalState: 'retracted' } : {}) }));
    const port = { modelId: 'local-fixture-not-real-embedding', async embed(texts) { calls.push([...texts]); return texts.map(() => [1, 0]); } };
    const input = { query: 'fixture-query', now: scaleNow, threadId: 'origin' };
    const cold = await prepareScaleIndex(new LocalMemorySemanticIndex({ file: join(directory, 'cold.json'), embedding: port }), entries, input);
    assert.equal(cold.state, 'warming');
    assert.equal(cold.diagnostics.eligibleCount, 509);
    assert.equal(cold.diagnostics.indexedCount, 20);
    assert.equal(calls[0].length, 21);
    const warmFile = join(directory, 'warm.json');
    let preparation;
    for (let step = 0; step < 26; step++) {
      preparation = await prepareScaleIndex(new LocalMemorySemanticIndex({ file: warmFile, embedding: port }), entries, input);
      assert(calls.at(-1).length <= 21);
    }
    assert.equal(preparation.state, 'ready');
    assert.equal(preparation.diagnostics.indexedCount, 509);
    await prepareScaleIndex(new LocalMemorySemanticIndex({ file: warmFile, embedding: port }), entries, input);
    assert.deepEqual(calls.at(-1), ['fixture-query']);
    const forbidden = new Set(fixture.facts.slice(-3).map(fact => fact.text));
    // Retracted/expired text overlaps a deliberately absent opposite coffee fact.
    assert(!calls.flat().some(text => forbidden.has(text)));
    assert(!preparation.diagnostics.candidates.some(item => ['foreign', 'retracted', 'expired'].includes(item.id)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('planned denominators stay at eight per lane and scale after a partial environment failure', () => {
  const oracle = { passed: true, recall: 1, precision: 1, forbidden: [] };
  const rows = [{ size: 32, lane: 'cold', category: 'head-direct', lexical: { oracle, selected: [] }, hybrid: { oracle, selected: [] } }];
  const summary = summarizeScale(rows, { size: 32, caseId: '32-cold-Q02', code: 'http_error' });
  assert.equal(summary[0].cold.hybrid.passed, 1);
  assert.equal(summary[0].cold.hybrid.planned, 8);
  assert.equal(summary[0].cold.hybrid.unexecuted, 7);
  assert.equal(summary[0].cold.percentagePointChange, null);
  assert.equal(summary[0].warm.hybrid.unexecuted, 8);
  assert.equal(summary[2].warm.hybrid.unexecuted, 8);
  assert.equal(summary[0].cold.latencyMs.p95, null);
  assert.equal(summary[0].cold.requestCounts.tokens, null);
});

test('formal fixture writes and lifecycle projection yield the exact eligible count used for the request budget', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'recall-scale-store-test-')));
  try {
    const store = createMemoryStore(directory), fixture = makeScaleFixture(32);
    const retractions = [];
    for (const { label, retract, ...input } of fixture.facts) {
      const result = await store.add(input, undefined, { now: new Date('2026-09-30T04:00:00Z') });
      assert.equal(result.ok, true, label);
      if (retract) retractions.push(result.entry);
    }
    for (const entry of retractions) assert.equal((await store.reviseMemory({ id: entry.id, expectedRevision: entry.revision,
      operation: 'retract' }, undefined, { now: scaleNow })).ok, true);
    const snapshot = await store.list(undefined, { now: scaleNow });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.entries.length, 32);
    assert.equal(selectEligibleMemoryEntries(snapshot.entries, { now: scaleNow, threadId: 'origin' }).length, 29);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live execution is explicit and missing credentials fail before creating a report', async () => {
  await assert.rejects(runScaleRecall({ live: false, env: {} }), /Use --live explicitly/);
  await assert.rejects(runScaleRecall({ live: true, env: {} }), /DASHSCOPE_API_KEY is required/);
  await assert.rejects(runScaleRecall({ live: true, relevance: true, env: { DASHSCOPE_API_KEY: 'fixture-not-sent' } }), /COMMAND_CODE_API_KEY is required/);
});
