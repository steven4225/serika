import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishReport, recordProduct } from './report.mjs';
const here = dirname(fileURLToPath(import.meta.url));

test('report keeps all planned runs in denominator and never fills native acceptance from backend pass', async () => {
  await mkdir(join(here, 'results'), { recursive: true });
  const dir = await mkdtemp(join(here, 'results', 'report-test-'));
  try {
    const plan = { caseIds: ['T01', 'M01'], planned: 6, repeat: 3, gitCommit: 'test', evalFingerprint: 'test', dirty: true, plannedByCategory: { chat_tools: 3, memory: 3 } };
    await mkdir(join(dir, 'evidence'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(plan));
    await writeFile(join(dir, 'evidence/T01-test.json'), JSON.stringify({ id: 'T01-test', caseId: 'T01', category: 'chat_tools', durationMs: 1, oracle: { passed: true, checks: [{ passed: true }] }, usage: {} }));
    const options = { publishLatest: false };
    const result = await finishReport(dir, plan, 1, options);
    assert.equal(result.passed, 1); assert.equal(result.notRun, 5);
    assert.equal(result.byCategory.chat_tools.planned, 3);
    assert.equal(result.byCategory.chat_tools.percent, 33.33);
    assert.equal(result.byCategory.memory.notRun, 3);
    assert.equal(result.byCase.T01.allVariantsPassed, false);
    assert.ok(JSON.parse(await readFile(join(dir, 'product.json'))).checks.every(c => c.status === 'not_run'));
    await writeFile(join(dir, 'native-status.json'), JSON.stringify({ worker: 'not_running' }));
    await recordProduct(dir, 'P03', { status: 'blocked', reason: 'native worker not available', evidence: ['native-status.json'] }, options);
    await finishReport(dir, plan, 1, options);
    assert.equal(JSON.parse(await readFile(join(dir, 'product.json'))).checks.find(c => c.id === 'P03').status, 'blocked');
    assert.match(await readFile(join(dir, 'index.html'), 'utf8'), /native worker not available/);
    await assert.rejects(recordProduct(dir, 'P01', { status: 'passed' }, options), /requires a reason/);
    await assert.rejects(recordProduct('/tmp', 'P01', { status: 'passed' }, options), /inside eval/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
