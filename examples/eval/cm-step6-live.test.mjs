import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { meteredModel, safeFailure, chargedUsd } from './cm-step6-live.mjs';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';
import { evaluateM1, m1Cases } from './cm-step4.mjs';

test('combined batch reserves before dispatch, meters each actual request, and freezes unknown usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm6-meter-'));
  try {
    const path = join(root, 'meter.json'); let calls = 0;
    const request = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], maxOutputTokens: 1024 };
    const underlying = new MockLanguageModelV3({ doGenerate: async () => { calls++; return { content: [], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: calls === 1 ? 100 : undefined, cacheRead: undefined, cacheWrite: undefined, noCache: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } }, warnings: [] }; } });
    await writeFile(path, JSON.stringify({ costUsd: 1.9999, calls: [], stopped: false }));
    let model = await meteredModel(underlying, path, () => 'test');
    await assert.rejects(model.doGenerate(request), /reserve exceeded/); assert.equal(calls, 0);
    await writeFile(path, JSON.stringify({ costUsd: 0, calls: [], stopped: false }));
    model = await meteredModel(underlying, path, () => 'test');
    await generateText({ model, prompt: 'SDK boundary fixture', maxOutputTokens: 1024, maxRetries: 0 }); const first = JSON.parse(await readFile(path));
    assert.equal(first.calls[0].status, 'returned'); assert.equal(first.calls[0].usage.cacheRead, null); assert.ok(first.costUsd > 0);
    await assert.rejects(model.doGenerate(request), /batch stopped/); assert.equal(calls, 2);
    await assert.rejects(model.doGenerate(request), /frozen/); assert.equal(calls, 2);
    assert.equal(JSON.parse(await readFile(path)).stopped, true);
    await writeFile(path, JSON.stringify({ costUsd: 0, priorChargedUsd: chargedUsd({ amount: 1.999, unresolvedReservedUsd: 0.0009 }), calls: [], stopped: false }));
    model = await meteredModel(underlying, path, () => 'test');
    await assert.rejects(model.doGenerate(request), /reserve exceeded/); assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure diagnostics retain status, code, finish and schema paths without messages or upstream bodies', () => {
  const failure = Object.assign(new Error('private prompt sk-secret-sentinel'), { name: 'APIError', statusCode: 400,
    responseBody: JSON.stringify({ error: { code: 'invalid_request_error', param: 'response_format', message: 'sk-secret-sentinel' } }),
    cause: { name: 'TypeValidationError', finishReason: 'stop', issues: [{ path: ['proposals', 0, 'category'], message: 'sk-secret-sentinel' }] } });
  const diagnostic = safeFailure(failure);
  assert.equal(diagnostic.chain[0].httpStatus, 400); assert.equal(diagnostic.chain[0].code, 'invalid_request_error');
  assert.equal(diagnostic.chain[0].parameter, 'response_format'); assert.equal(diagnostic.chain[1].finishReason, 'stop');
  assert.deepEqual(diagnostic.chain[1].schemaPaths, ['proposals.0.category']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|sentinel|message|responseBody/);
});

test('extraction JSON Schema stays in prompt text; the configured provider sends no structured-output parameter', async () => {
  const requests = [];
  const { model } = configureCliModel(() => { throw new Error('unexpected fallback'); }, {
    RUNLOOM_MODEL: 'command-code', COMMAND_CODE_API_KEY: 'fixture-key', COMMAND_CODE_MODEL_ID: 'deepseek/deepseek-v4.1-flash-fast',
  }, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return new Response(JSON.stringify({ id: 'fixture', model: body.model, created: 0, object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ proposals: [], outcomes: [{ messageId: 'u', status: 'no_memory' }] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const result = await evaluateM1({ cases: [m1Cases()[0]], model });
  assert.equal(result.results.every(item => item.passed), true); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.response_format, undefined); assert.equal(request.tools, undefined);
    assert.match(JSON.stringify(request.messages), /Exact response JSON Schema/);
  }
});
