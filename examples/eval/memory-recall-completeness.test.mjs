import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { completenessCases, completenessFixture, completenessBudget, completenessGuard, scoreCompleteness, runCompleteness, reuseCompletenessIndex } from './memory-recall-completeness.mjs';

test('fixed six-case suite preserves original failures and independently adds positive and scene coverage', () => {
  assert.equal(completenessFixture().length, 512);
  assert.equal(completenessCases.length, 6);
  assert.deepEqual(completenessCases.map(item => item.expected), [['home'], ['editor'], [], ['language'], ['review'], ['work-coffee', 'personal-coffee']]);
  assert.equal(completenessFixture().filter(item => item.label === 'editor').length, 1);
});

test('new strict Oracle fails extras, duplicates, wrong scene and empty false positives without changing historical scoring', () => {
  const spec = completenessCases[0];
  assert.equal(scoreCompleteness(spec, [{ id: 'home' }]).passed, true);
  assert.equal(scoreCompleteness(spec, [{ id: 'home' }, { id: 'language' }]).passed, false);
  assert.equal(scoreCompleteness(spec, [{ id: 'home' }, { id: 'home' }]).passed, false);
  assert.equal(scoreCompleteness(completenessCases[2], [{ id: 'language' }]).passed, false);
  assert.equal(scoreCompleteness(completenessCases[5], [{ id: 'work-coffee' }]).passed, false);
});

test('hard budget includes every fact, query and relevance attempt; failed dispatch does not refund a slot', () => {
  assert.equal(completenessBudget().totalHttpUpperBound, 521);
  assert.equal(completenessBudget().maintenancePreparations, 26);
  const guard = completenessGuard();
  for (let i = 0; i < 515; i++) guard('embedding');
  assert.throws(() => guard('embedding'), { code: 'request_budget_exhausted' });
  for (let i = 0; i < 6; i++) guard('relevance');
  assert.throws(() => guard('relevance'), { code: 'request_budget_exhausted' });
  assert.throws(() => guard('unknown'), { code: 'request_budget_exhausted' });
  assert.equal(completenessBudget({ reuseIndex: true }).totalHttpUpperBound, 12);
  const reuseGuard = completenessGuard({ reuseIndex: true });
  for (let i = 0; i < 6; i++) reuseGuard('embedding');
  assert.throws(() => reuseGuard('embedding'), { code: 'request_budget_exhausted' });
});

test('default fixture run proves bounded complete indexing and exact production pipeline wiring, not real quality', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-completeness-test-'));
  try {
    const { root, summary } = await runCompleteness({ outputRoot: directory, env: {} });
    assert.equal(summary.environmentFailure, null);
    assert.equal(summary.executed, 6);
    assert.equal(summary.passed, 6);
    assert.equal(summary.qualityPassRate, null);
    assert.equal(summary.requests.length, 0);
    assert.equal(summary.maintenance.length, 26);
    assert(summary.maintenance.every(step => step.embeddedCount <= 20));
    assert.equal(summary.maintenance.reduce((sum, step) => sum + step.embeddedCount, 0), 509);
    assert.equal(summary.maintenance.at(-1).remainingCount, 0);
    const evidence = JSON.parse(await readFile(join(root, 'IC01.json'), 'utf8'));
    assert.equal(evidence.diagnostics.indexedCount, 509);
    const labels = JSON.parse(await readFile(join(root, 'labels.json'), 'utf8'));
    assert.equal(evidence.diagnostics.candidates.find(item => labels[item.id] === 'home').score, 1);
    assert(!evidence.diagnostics.candidates.some(item => ['foreign', 'retracted', 'expired'].includes(labels[item.id])));
    const projection = JSON.parse(await readFile(join(root, 'formal-projection.json'), 'utf8'));
    assert.equal(projection.find(item => labels[item.id] === 'language').assertion.kind, 'preference');
    assert.equal(projection.find(item => labels[item.id] === 'deadline').assertion.kind, 'event');
    assert.equal(projection.find(item => labels[item.id] === 'home').assertion.kind, 'fact');
    assert.equal(JSON.parse(await readFile(join(root, 'fixture-store/.runloom/memory.json'), 'utf8')).version, 4);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'offline-contract-fixture-not-quality');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reuse binds a validated full vector cache to fresh real store IDs without fact requests and records source hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-completeness-reuse-test-'));
  try {
    const original = await runCompleteness({ outputRoot: directory, env: {} });
    const oldBytes = await readFile(join(original.root, 'index.json'));
    const reused = await runCompleteness({ outputRoot: directory, env: {}, reuseIndex: original.root });
    assert.equal(reused.summary.environmentFailure, null);
    assert.equal(reused.summary.passed, 6);
    assert.equal(reused.summary.maintenance.length, 1);
    assert.equal(reused.summary.maintenance[0].embeddedCount, 0);
    const manifest = JSON.parse(await readFile(join(reused.root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.requestBudget.totalHttpUpperBound, 12);
    assert.equal(manifest.reusedIndex.source, original.root);
    assert.match(manifest.reusedIndex.indexHash, /^[a-f0-9]{64}$/);
    const oldCache = JSON.parse(oldBytes), cache = JSON.parse(await readFile(join(reused.root, 'index.json'), 'utf8'));
    assert.equal(cache.records.length, 509);
    assert(cache.records.every(item => !oldCache.records.some(old => old.id === item.id)));
    assert.deepEqual(await readFile(join(original.root, 'index.json')), oldBytes);
    oldCache.records.pop();
    await writeFile(join(original.root, 'index.json'), JSON.stringify(oldCache));
    const invalidRoot = join(directory, 'invalid');
    await mkdir(invalidRoot);
    const projection = JSON.parse(await readFile(join(reused.root, 'formal-projection.json'), 'utf8'));
    await assert.rejects(reuseCompletenessIndex(original.root, invalidRoot, projection, cache.modelId, manifest.requestedModels), { code: 'reuse_index_invalid' });
    for (const corrupt of [
      value => { value.records[0].vector = [null]; },
      value => { value.records[0].revision++; },
      value => { value.records[0].textHash = '0'.repeat(64); },
      value => { value.records[1].id = value.records[0].id; },
      value => { value.modelId = 'wrong-model'; },
    ]) {
      const invalid = JSON.parse(oldBytes);
      corrupt(invalid);
      await writeFile(join(original.root, 'index.json'), JSON.stringify(invalid));
      await assert.rejects(reuseCompletenessIndex(original.root, invalidRoot, projection, cache.modelId, manifest.requestedModels), { code: 'reuse_index_invalid' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live is explicit and credentials fail before report creation or requests', async () => {
  await assert.rejects(runCompleteness({ live: true, env: {} }), /Both host API keys/);
});
