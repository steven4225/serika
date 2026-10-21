import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateM1 } from './cm-step4.mjs';
test('M1 extraction and persisted source/conflict evidence at 32K and daily windows (scripted, no semantic score)', async () => {
  const result = await evaluateM1({});
  assert.equal(result.calls, 0); assert.equal(result.fixtureCalls, 16); assert.equal(result.costUsd, 0);
  assert.deepEqual(result.results.filter(item => !item.passed).map(item => ({ case: item.case, checks: item.checks })), []);
});

test('M1 usage-unknown provider failure stops the quoted batch after one dispatch', async () => {
  const result = await evaluateM1({ model: { doGenerate: async () => { throw new Error('transport fixture'); } } });
  assert.equal(result.stopped, true); assert.equal(result.calls, 1); assert.equal(result.results.length, 1);
  assert.equal(result.results[0].rows[0].status, 'failed'); assert.equal(result.results[0].rows[0].usage, null);
});
