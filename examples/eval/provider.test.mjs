import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import SerikaProvider, { requireLive } from './provider.mjs';
import check from './assertions.mjs';

// Test commands are always offline even if the caller's shell opted into live.
process.env.SERIKA_EVAL_MODE = 'offline';

test('live requires explicit opt-in and never falls back to mock', () => {
  assert.equal(new SerikaProvider().config.maxRetries, 0);
  assert.throws(() => requireLive({}), /SERIKA_EVAL_LIVE/);
  assert.throws(() => requireLive({ SERIKA_EVAL_LIVE: '1' }), /禁止回退 mock/);
  assert.throws(() => requireLive({ SERIKA_EVAL_LIVE: '1', RUNLOOM_MODEL: 'command-code' }), /API_KEY/);
});

test('grader rejects false success, missing evidence and extraction JSON leakage', () => {
  const context = { vars: { expected: { saved: 1, sourceValid: true, approvalsMin: 1 } } };
  assert.equal(check({ reply: '记住了', saved: 0 }, context).pass, false);
  assert.equal(check({ saved: 1, sourceValid: true, approvals: 1 }, context).pass, true);
  assert.equal(check({ saved: 1, sourceValid: true, approvals: 1, reply: '{"batchId":"internal"}' }, context).pass, false);
  assert.equal(check({ saved: 1, sourceValid: true, approvals: 1, reply: '{ "batchId" : "internal" }' }, context).pass, false);
});

const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
test('multi-turn cases must not silently become promptfoo variable combinations', async () => {
  await assert.rejects(new SerikaProvider().callApi('', { vars: { scenario: 'memory', turns: '我喝咖啡不加糖。' } }), /完整消息数组/);
});
for (const fixture of cases) test(`offline provider: ${fixture.description}`, async () => {
  const actual = await new SerikaProvider().callApi(fixture.vars.input, { vars: fixture.vars });
  const verdict = check(actual.output, { vars: fixture.vars });
  assert.equal(verdict.pass, true, JSON.stringify({ verdict, output: actual.output }));
  assert.equal(actual.metadata.mode, 'offline');
});
