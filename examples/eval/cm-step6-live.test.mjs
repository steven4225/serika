import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { meteredModel } from './cm-step6-live.mjs';

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
  } finally { await rm(root, { recursive: true, force: true }); }
});
