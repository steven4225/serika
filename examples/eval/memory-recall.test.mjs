import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as recall from './memory-recall.mjs';
const { memoryRecallCases, scoreRecall, summarizeRecall, runMemoryRecall } = recall;

test('independent recall oracle detects missing, false-positive, cross-thread, old-text and scene loss', () => {
  const direct = memoryRecallCases[0];
  assert.equal(scoreRecall(direct, [{ label: 'style', text: 'saved' }]).passed, true);
  assert.equal(scoreRecall(direct, []).passed, false);
  const mixed = scoreRecall(direct, [{ label: 'style', text: 'saved' }, { label: 'noise', text: 'noise' }]);
  assert.equal(mixed.precision, .5); assert.deepEqual(mixed.unexpected, ['noise']);
  assert.equal(scoreRecall(memoryRecallCases[6], [{ label: 'coffee', text: 'noise' }]).passed, false);
  assert.equal(scoreRecall(memoryRecallCases[7], [{ label: 'private', text: 'secret' }]).passed, false);
  assert.equal(scoreRecall(memoryRecallCases[10], [{ label: 'coffee', text: '我喝咖啡加糖' }]).passed, false);
  assert.equal(scoreRecall(memoryRecallCases[11], [{ label: 'work', text: 'work' }, { label: 'personal', text: 'personal' }], [{}]).passed, false);
});

test('ranking oracle requires preferred first result and retains false positives independently of case pass rate', () => {
  const spec = memoryRecallCases[4];
  assert.equal(scoreRecall(spec, [{ label: 'event0', text: 'event' }, { label: 'coffee', text: 'fact' }]).passed, false);
  const result = scoreRecall(spec, [{ label: 'coffee', text: 'fact' }, { label: 'event0', text: 'event' }]);
  assert.equal(result.passed, true); assert.equal(result.precision, .5);
});

test('unfinished semantic runs are not scored as lexical successes, unexecuted cases stay in the denominator', () => {
  const selected = [{ label: 'style', text: 'fact' }], oracle = scoreRecall(memoryRecallCases[0], selected);
  const summary = summarizeRecall([{ category: 'direct', lexical: { selected, oracle } }], 12);
  assert.equal(summary.lexical.passed, 1); assert.equal(summary.lexical.passRateOfPlanned, 1 / 12);
  assert.equal(summary.hybrid.passed, 0); assert.equal(summary.hybrid.executed, 0);
  assert.equal(summary.hybrid.unexecuted, 12); assert.equal(summary.hybrid.meanPrecision, null);
  assert.equal(summary.percentagePointChange, null, 'incomplete runs are not before/after improvements');
});

test('completed recall misses are identified separately from embedding environment failures', () => {
  const spec = memoryRecallCases[1], oracle = scoreRecall(spec, []);
  const rows = [{ id: spec.id, spec, category: spec.category, embedding: { state: 'ready', hits: [] },
    lexical: { selected: [], oracle }, hybrid: { selected: [], oracle } }];
  const summary = { ...summarizeRecall(rows, 1), rows, probe: false, environmentFailure: null };
  const result = recall.formatRecallResult({ root: '/isolated/report', summary });
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.environmentFailure, null);
  assert.deepEqual(result.failedCases, [{ caseId: 'MR02', category: 'paraphrase', query: spec.query,
    expected: spec.gold, selected: [], missing: ['style'], unexpected: [], forbidden: [], firstCorrect: true,
    evidence: '/isolated/report/MR02/evidence.json' }]);
  assert.equal(result.hybrid.passRateOfPlanned, 0, 'honest failed oracle is unchanged');
  const failed = recall.formatRecallResult({ root: '/isolated/report', summary: {
    ...summary, environmentFailure: { caseId: 'MR02', code: 'response_index_invalid' } } });
  assert.equal(failed.status, 'environment_failed');
  assert.equal(failed.environmentFailure.code, 'response_index_invalid');
});

test('live recall requires explicit invocation and a dedicated cloud key; no chat keys or mock success path', async () => {
  await assert.rejects(runMemoryRecall(), /--live/);
  await assert.rejects(runMemoryRecall({ live: true, env: { OPENAI_API_KEY: 'fixture-chat-key' } }), /DASHSCOPE_API_KEY/);
  await assert.rejects(runMemoryRecall({ live: true, baseURL: 'https://remote.example/v1' }), /DashScope/);
  await assert.rejects(runMemoryRecall({ live: true, provider: 'local', baseURL: 'https://remote.example/v1' }), /loopback/);
  assert.equal(memoryRecallCases.length, 12);
  assert.equal(new Set(memoryRecallCases.map(spec => spec.id)).size, 12);
});

test('fixture HTTP transport exercises all reporting paths without claiming real embedding accuracy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-report-test-'));
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('Content-Type', 'application/json');
    // Intentionally indistinguishable vectors: the oracle must expose false positives.
    response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { root, summary } = await runMemoryRecall({ live: true, provider: 'local', env: {}, baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: 'fixture-not-real-embedding', outputRoot: directory });
    assert.equal(summary.environmentFailure, null);
    assert.equal(summary.rows.length, 12);
    assert.equal(summary.hybrid.executed, 12);
    assert.ok(summary.hybrid.passed < 12, 'valid HTTP is not automatic semantic success');
    assert.equal(summary.hybrid.irrelevantFalsePositives, 1);
    assert.equal(summary.rows.find(row => row.id === 'MR08').embedding.state, 'not_applicable');
    assert.equal(summary.policyOnlyCases, 1);
    const lifecycle = summary.rows.find(row => row.id === 'MR10');
    assert.deepEqual(lifecycle.hybrid.selected.map(entry => entry.label), ['coffee']);
    assert.ok(lifecycle.embedding.httpRequests.every(call => call.inputCount <= 10));
    assert.ok(summary.rows.find(row => row.id === 'MR11').hybrid.selected[0].text.includes('不加糖'));
    assert.ok((await readFile(join(root, 'MR11', '.runloom', 'memory.json'), 'utf8')).includes('我喝咖啡加糖'));
    assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).config.modelId, 'fixture-not-real-embedding');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('service failure saves evidence and stops without silently scoring fallback or retrying', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-unavailable-test-'));
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.writeHead(503); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { root, summary } = await runMemoryRecall({ live: true, provider: 'local', env: {}, baseURL: `http://127.0.0.1:${server.address().port}/v1`, outputRoot: directory });
    assert.equal(calls, 1);
    assert.equal(summary.environmentFailure.caseId, 'MR01');
    assert.equal(summary.environmentFailure.code, 'http_error', 'the original cause must survive lexical degradation');
    assert.equal(summary.hybrid.executed, 0); assert.equal(summary.hybrid.unexecuted, 12);
    assert.equal(summary.lexical.executed, 1);
    assert.equal(summary.percentagePointChange, null);
    const evidence = JSON.parse(await readFile(join(root, 'MR01', 'evidence.json'), 'utf8'));
    assert.equal(evidence.embedding.state, 'degraded');
    assert.equal(evidence.embedding.httpRequests[0].httpStatus, 503);
    assert.deepEqual(evidence.embedding.failure, { code: 'http_error', httpStatus: 503 });
    assert.equal(evidence.hybrid, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP 200 parsing failure retains a safe cause, never a response body or fake semantic score', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-200-test-'));
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++; response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: { message: 'fixture-secret-must-not-be-recorded' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { root, summary } = await runMemoryRecall({ live: true, provider: 'local', env: {},
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, outputRoot: directory });
    assert.equal(calls, 1);
    assert.equal(summary.environmentFailure.code, 'provider_error_response');
    assert.equal(summary.hybrid.executed, 0);
    assert.equal(summary.hybrid.unexecuted, 12);
    assert.equal(summary.percentagePointChange, null);
    const evidence = await readFile(join(root, 'MR01', 'evidence.json'), 'utf8');
    assert.equal(JSON.parse(evidence).embedding.httpRequests[0].httpStatus, 200);
    assert.equal(JSON.parse(evidence).embedding.failure.code, 'provider_error_response');
    assert.ok(!evidence.includes('fixture-secret'));
    assert.ok(!JSON.stringify(summary).includes('fixture-secret'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit connectivity probe makes exactly one fixture request and is not a full recall comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-probe-test-'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { root, summary } = await runMemoryRecall({ live: true, probe: true, provider: 'local', env: {},
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, outputRoot: directory });
    assert.equal(calls, 1);
    assert.equal(summary.probe, true);
    assert.equal(summary.rows.length, 1);
    assert.equal(summary.hybrid.planned, 1);
    assert.equal(summary.percentagePointChange, null);
    assert.equal(summary.environmentFailure, null);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.suite, 'memory-embedding-probe-v1');
    assert.equal(manifest.kind, 'connectivity-diagnostic-not-recall-accuracy');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('flash probe binds three zero-index singleton responses and records real request counts without an accuracy claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-flash-probe-test-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
    calls++;
    const body = JSON.parse(options.body);
    // The captured gateway pattern is [0,0,0] for a batch, zero for a single input.
    const texts = typeof body.input === 'string' ? [body.input] : body.input;
    return new Response(JSON.stringify({ data: texts.map(() => ({ index: 0, embedding: [1, 0] })),
      usage: { prompt_tokens: 2, total_tokens: 2 } }));
  };
  try {
    const { root, summary } = await runMemoryRecall({ live: true, probe: true, provider: 'dashscope',
      env: { DASHSCOPE_API_KEY: 'fixture-key-not-real' }, outputRoot: directory });
    assert.equal(calls, 3);
    assert.equal(summary.environmentFailure, null);
    assert.equal(summary.percentagePointChange, null);
    const evidence = JSON.parse(await readFile(join(root, 'MR01', 'evidence.json'), 'utf8'));
    assert.equal(evidence.embedding.state, 'ready');
    assert.equal(evidence.embedding.requestMode, 'single-input');
    assert.deepEqual(evidence.embedding.httpRequests.map(request => request.inputCount), [1, 1, 1]);
    assert.equal(new Set(evidence.embedding.httpRequests.flatMap(request => request.inputHashes)).size, 3);
    assert.deepEqual(evidence.embedding.usage, { inputTokens: 6, totalTokens: 6 });
    assert.ok(!JSON.stringify(evidence).includes('fixture-key'));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
