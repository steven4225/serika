import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const rows = [{ id: spec.id, spec, category: spec.category,
    hybrid: { selected: [{ label: 'coffee', text: 'fact' }, { label: 'event0', text: 'event' }], oracle: result } }];
  const formatted = recall.formatRecallResult({ root: '/isolated/report', summary: {
    ...summarizeRecall(rows, 1), rows, probe: false, environmentFailure: null } });
  assert.deepEqual(formatted.precisionWarnings, [{ caseId: 'MR05', casePassed: true, precision: .5,
    unexpected: ['event0'], evidence: '/isolated/report/MR05/evidence.json' }]);
});

test('separate validation suite uses new tasks and explicitly rejects off-target topical hits', () => {
  assert.equal(recall.memoryRecallValidationCases?.length, 4);
  assert.ok(recall.memoryRecallValidationCases.every(spec => !memoryRecallCases.some(original => original.id === spec.id || original.query === spec.query)));
  assert.equal(memoryRecallCases.length, 12, 'original suite remains frozen');
  const spec = recall.memoryRecallValidationCases.find(spec => spec.id === 'MH02');
  assert.equal(scoreRecall(spec, [{ label: 'weekly_style', text: 'saved' }, { label: 'weekly_event', text: 'saved' }]).passed, false);
  assert.equal(scoreRecall(spec, [{ label: 'weekly_style', text: 'saved' }]).passed, true);
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
    const diagnostic = summary.rows.find(row => row.id === 'MR01').embedding.diagnostics;
    assert.equal(diagnostic?.threshold, .5);
    assert.equal(diagnostic?.candidates.length, 2);
    assert.equal(diagnostic?.candidates.every(item => item.reason === 'selected' && item.score === 1), true);
    assert.ok(diagnostic.candidates.every(item => !('text' in item) && !('vector' in item)));
    assert.ok((await readFile(join(root, 'MR11', '.runloom', 'memory.json'), 'utf8')).includes('我喝咖啡加糖'));
    assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).config.modelId, 'fixture-not-real-embedding');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('validation run writes a separate manifest and retains stricter precision failures without altering regression data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-validation-test-'));
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { root, summary } = await runMemoryRecall({ live: true, suite: 'validation', provider: 'local', env: {},
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture-not-real-embedding', outputRoot: directory });
    assert.equal(summary.environmentFailure, null);
    assert.equal(summary.hybrid.executed, 4);
    assert.equal(summary.hybrid.planned, 4);
    assert.equal(summary.hybrid.passed, 0, 'same-topic extra answers are visible quality failures, not silently accepted');
    assert.deepEqual(summary.rows.map(row => row.id), ['MH01', 'MH02', 'MH03', 'MH04']);
    assert.ok(root.includes('memory-recall-validation-'));
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.suite, 'memory-recall-validation-v1');
    assert.equal(manifest.threshold, .5);
    assert.equal(manifest.rrfK, 60);
    assert.deepEqual(manifest.caseIds, ['MH01', 'MH02', 'MH03', 'MH04']);
    await assert.rejects(runMemoryRecall({ live: true, suite: 'invented', env: {} }), /Unknown recall suite/);
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

test('relevance opt-in freezes both model boundaries and saves independent call evidence without changing the oracle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-relevance-test-'));
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/embeddings')) {
      assert.equal(body.model, 'qwen3.7-text-embedding-flash');
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 2, total_tokens: 2 } }));
    }
    assert.equal(String(url), 'https://api.commandcode.ai/provider/v1/chat/completions');
    modelRequests++;
    assert.equal(body.model, 'deepseek/deepseek-v4.1-flash-fast');
    // A valid empty decision proves the final oracle is not the earlier hybrid success.
    return new Response(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', created: 1,
      model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ selectedIds: [], queries: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
  };
  try {
    await assert.rejects(runMemoryRecall({ live: true, relevance: true, env: { DASHSCOPE_API_KEY: 'fixture-embedding-secret' }, outputRoot: directory }), /COMMAND_CODE_API_KEY/);
    await assert.rejects(runMemoryRecall({ live: true, relevance: true, probe: true, env: {}, outputRoot: directory }), /probe.*relevance|relevance.*probe/i);
    const { root, summary } = await runMemoryRecall({ live: true, relevance: true, suite: 'validation', env: {
      DASHSCOPE_API_KEY: 'fixture-embedding-secret', COMMAND_CODE_API_KEY: 'fixture-main-secret',
      COMMAND_CODE_MODEL_ID: 'wrong-env-model', COMMAND_CODE_BASE_URL: 'https://wrong.example/v1' }, outputRoot: directory });
    assert.equal(summary.environmentFailure, null);
    assert.equal(modelRequests, 4, 'exactly one judgment per eligible case, no separate rewrite');
    assert.equal(summary.hybrid.executed, 4);
    assert.equal(summary.hybrid.passed, 1, 'only the empty-gold case passes a valid empty judgment');
    assert.equal(summary.rows[0].hybridBeforeRelevance.selected.length, 2);
    assert.deepEqual(summary.rows[0].hybrid.selected, []);
    const relevance = summary.rows[0].relevance;
    assert.equal(relevance.state, 'succeeded');
    assert.equal(relevance.candidateCount, 2);
    assert.deepEqual(relevance.selectedIds, []);
    assert.deepEqual(relevance.queries, []);
    assert.equal(relevance.model.alias, 'command-code/default');
    assert.equal(relevance.model.modelId, 'deepseek/deepseek-v4.1-flash-fast');
    assert.equal(relevance.httpRequests.length, 1);
    assert.equal(relevance.httpRequests[0].httpStatus, 200);
    assert.equal(relevance.calls[0].usage.inputTokens, 11);
    assert.equal(relevance.calls[0].usage.outputTokens, 3);
    assert.equal(relevance.usage.totalTokens, 14);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.pipeline, 'hybrid+relevance');
    assert.equal(manifest.relevance.modelId, 'deepseek/deepseek-v4.1-flash-fast');
    assert.ok(manifest.runtimeHashes['memory-relevance']);
    assert.deepEqual(manifest.caseIds, ['MH01', 'MH02', 'MH03', 'MH04']);
    assert.ok(!JSON.stringify(summary).includes('fixture-main-secret'));
    assert.ok(!JSON.stringify(summary).includes('fixture-embedding-secret'));
    assert.equal(recall.formatRecallResult({ root, summary }).pipeline, 'hybrid+relevance');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('acceptance launcher prompts two hidden keys only with relevance opt-in and never places them in command arguments', async () => {
  const script = await readFile(new URL('./Start-Memory-Acceptance.command', import.meta.url), 'utf8');
  assert.ok(script.indexOf('unsetopt XTRACE') < script.indexOf('read -r -s'));
  assert.match(script, /read -r -s 'DASHSCOPE_API_KEY\?/);
  assert.match(script, /if \[\[ "\$serika_memory_relevance" == true \]\]; then\s+read -r -s 'COMMAND_CODE_API_KEY\?/);
  assert.match(script, /trap 'unset DASHSCOPE_API_KEY COMMAND_CODE_API_KEY SERIKA_MEMORY_RELEVANCE' EXIT/);
  assert.ok(!script.includes('--api-key='));
  assert.match(script, /if \(\( \$# != 1 \)\) \|\| \[\[ "\$1" != '--relevance' \]\]/);
  assert.match(script, /if \(result\.summary\.environmentFailure\)/);
});

test('acceptance launcher identifies the built judgment version before asking for any key', async () => {
  const script = await readFile(new URL('./Start-Memory-Acceptance.command', import.meta.url), 'utf8');
  assert.match(script, /本次构建/);
  assert.ok(script.indexOf("<<'VERSION'") < script.indexOf("read -r -s"));
  assert.match(script, /git.*rev-parse/);
  assert.match(script, /cli\/dist\/memory-relevance\.js/);
  assert.match(script, /createHash\('sha256'\)/);
  const code = script.match(/<<'VERSION'\n([\s\S]*?)\nVERSION/)?.[1];
  assert.ok(code);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, DASHSCOPE_API_KEY: 'fixture-hidden-dashscope', COMMAND_CODE_API_KEY: 'fixture-hidden-command' },
  });
  const expected = createHash('sha256').update(await readFile(new URL('../cli/dist/memory-relevance.js', import.meta.url))).digest('hex');
  assert.ok(output.includes(`relevanceRuntime=${expected}`));
  assert.match(output, /commit=[a-f0-9]{12}/);
  assert.doesNotMatch(output, /fixture-hidden/);
});

test('relevance degradation stops after one judgment without crediting the ordinary hybrid fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-relevance-failure-test-'));
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    modelRequests++;
    return new Response(JSON.stringify({ error: { message: 'upstream-error-secret-must-not-be-recorded' } }), { status: 503 });
  };
  try {
    const { root, summary } = await runMemoryRecall({ live: true, relevance: true, env: {
      DASHSCOPE_API_KEY: 'fixture-embedding-secret', COMMAND_CODE_API_KEY: 'fixture-main-secret' }, outputRoot: directory });
    assert.equal(modelRequests, 1);
    assert.equal(summary.environmentFailure.code, 'relevance_degraded');
    assert.equal(summary.hybrid.executed, 0);
    assert.equal(summary.hybrid.unexecuted, 12);
    assert.equal(summary.rows[0].hybridBeforeRelevance.oracle.passed, true);
    assert.equal(summary.rows[0].relevance.state, 'degraded');
    const evidence = await readFile(join(root, 'MR01', 'evidence.json'), 'utf8');
    assert.ok(!evidence.includes('upstream-error-secret'));
    assert.ok(!evidence.includes('fixture-main-secret'));
    assert.equal(recall.formatRecallResult({ root, summary }).status, 'environment_failed');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('relevance evaluation passes below-threshold pool hints and keeps foreign-thread cases call-free', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-recall-relevance-pool-test-'));
  const originalFetch = globalThis.fetch;
  const fixtureFacts = new Set(memoryRecallCases.flatMap(spec => spec.facts.flatMap(fact => [fact.text, fact.correctedText].filter(Boolean))));
  let modelRequests = 0;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0,
      embedding: fixtureFacts.has(body.input) ? [.4, Math.sqrt(.84)] : [1, 0] }] }));
    modelRequests++;
    const prompt = JSON.parse(body.messages.findLast(message => message.role === 'user').content);
    const selectedIds = prompt.question === memoryRecallCases[1].query
      ? [prompt.candidates.find(item => item.text === memoryRecallCases[1].facts[0].text).id] : [];
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ selectedIds, queries: ['复盘格式'] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  };
  try {
    const { summary } = await runMemoryRecall({ live: true, relevance: true, env: {
      DASHSCOPE_API_KEY: 'fixture-embedding-secret', COMMAND_CODE_API_KEY: 'fixture-main-secret' }, outputRoot: directory });
    assert.equal(summary.environmentFailure, null);
    assert.equal(summary.hybrid.executed, 12);
    assert.equal(modelRequests, 11);
    const paraphrase = summary.rows.find(row => row.id === 'MR02');
    assert.deepEqual(paraphrase.embedding.hits, []);
    assert.equal(paraphrase.embedding.diagnostics.candidates[0].reason, 'below_threshold');
    assert.equal(paraphrase.hybridBeforeRelevance.oracle.passed, false);
    assert.equal(paraphrase.relevance.candidateCount, 2);
    assert.deepEqual(paraphrase.hybrid.selected.map(item => item.label), ['style']);
    assert.equal(paraphrase.hybrid.oracle.passed, true);
    const foreign = summary.rows.find(row => row.id === 'MR08');
    assert.equal(foreign.relevance.state, 'not_applicable');
    assert.equal(foreign.relevance.candidateCount, 0);
    assert.deepEqual(foreign.relevance.calls, []);
    assert.deepEqual(foreign.relevance.httpRequests, []);
    assert.equal(foreign.hybrid.oracle.passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
