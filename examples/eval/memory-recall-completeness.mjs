import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { LocalMemorySemanticIndex, MEMORY_SEMANTIC_WARMUP_BATCH } from '@serika/example-cli/dist/memory-semantic-index.js';
import { createMemoryEmbedder, normalizeEmbeddingConfig } from '@serika/example-cli/dist/memory-embedding-client.js';
import { createMemoryRelevanceSelector } from '@serika/example-cli/dist/memory-relevance.js';
import { memorySemanticTextHash, retrieveMemories, selectEligibleMemoryEntries } from '@serika/example-cli/dist/memory-retrieval.js';
import { createMemoryStore } from '@serika/example-cli/dist/memory-store.js';
import { configureCliModel } from '@serika/example-cli/dist/model-config.js';
import { makeScaleFixture, scaleNow } from './memory-recall-scale.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const completenessModels = { embedding: 'qwen3.7-text-embedding-flash', relevance: 'deepseek/deepseek-v4.1-flash-fast' };
export const completenessCases = [
  { id: 'IC01', query: '我的常住城市是哪里？', expected: ['home'], origin: 'original cold Q04 regression' },
  { id: 'IC02', query: '我平时写程序用哪款软件？', expected: ['editor'], origin: 'new paraphrase' },
  { id: 'IC03', query: '解释量子纠缠的原理', expected: [], origin: 'original large-corpus Q06 regression' },
  { id: 'IC04', query: '你平时应该用哪种语言回答我？', expected: ['language'], origin: 'explicit response preference' },
  { id: 'IC05', query: '我希望复盘内容按什么格式组织？', expected: ['review'], origin: 'explicit format preference' },
  { id: 'IC06', query: '咖啡', expected: ['work-coffee', 'personal-coffee'], origin: 'bare topic preserves scenes' },
];
export function completenessFixture() {
  const fixture = makeScaleFixture(512);
  fixture.facts[fixture.size - 6] = { label: 'editor', text: '我常用的代码编辑器是 Neovim。', kind: 'preference' };
  return fixture.facts;
}
export async function seedCompletenessStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = createMemoryStore(directory), labels = new Map(), positions = new Map(), retractions = [];
  for (const [position, { label, retract, ...fact }] of completenessFixture().entries()) {
    const saved = await store.add(fact, undefined, { now: new Date('2026-09-30T04:00:00.000Z') });
    if (!saved.ok) throw Object.assign(Error('Fixture write failed'), { code: saved.error.code });
    labels.set(saved.entry.id, label); positions.set(saved.entry.id, position);
    if (retract) retractions.push(saved.entry);
  }
  for (const entry of retractions) {
    const result = await store.reviseMemory({ id: entry.id, expectedRevision: entry.revision, operation: 'retract' }, undefined, { now: scaleNow });
    if (!result.ok) throw Object.assign(Error('Fixture retract failed'), { code: result.error.code });
  }
  const snapshot = await store.list(undefined, { now: scaleNow });
  if (!snapshot.ok) throw Object.assign(Error('Fixture read failed'), { code: snapshot.error.code });
  return { entries: snapshot.entries.sort((a, b) => positions.get(a.id) - positions.get(b.id)), labels };
}
/** New suite only: extra selections are failures, unlike the unchanged historical scale Oracle. */
export function scoreCompleteness(spec, selected) {
  const actual = selected.map(entry => entry.id), missing = spec.expected.filter(id => !actual.includes(id));
  const unexpected = actual.filter(id => !spec.expected.includes(id));
  return { passed: !missing.length && !unexpected.length && new Set(actual).size === actual.length, missing, unexpected };
}
export function completenessBudget({ reuseIndex = false } = {}) {
  return { eligibleFacts: 509, maintenancePreparations: reuseIndex ? 1 : Math.ceil(509 / MEMORY_SEMANTIC_WARMUP_BATCH),
    embeddingHttpUpperBound: reuseIndex ? 6 : 515, relevanceHttpUpperBound: 6, totalHttpUpperBound: reuseIndex ? 12 : 521,
    retries: 0, assumption: reuseIndex ? 'Validated complete reused vectors; fact requests are forbidden, six queries and six relevance calls only.'
      : 'Fixed 512-entry corpus, single-string DashScope requests; maintenance has no query embedding.' };
}
export function completenessGuard(options) {
  const budget = completenessBudget(options);
  const counts = { embedding: 0, relevance: 0 }, limits = { embedding: budget.embeddingHttpUpperBound, relevance: budget.relevanceHttpUpperBound };
  return kind => {
    if (!(kind in limits) || counts[kind] >= limits[kind]) throw Object.assign(Error('Request budget exhausted'), { code: 'request_budget_exhausted' });
    counts[kind]++;
  };
}

/** Fixture vectors and decisions prove wiring only, never semantic quality. No network in default mode. */
function fixturePorts(labels) {
  const concepts = ['杭州', '编辑器', '量子纠缠', '语言', '复盘', '咖啡'];
  const vector = text => {
    const index = concepts.findIndex(term => text.includes(term));
    const values = Array(7).fill(0);
    // The regression paraphrase has no shared body keyword; fixture vectors deliberately bridge it.
    values[text.includes('常住城市') ? 0 : text.includes('写程序') ? 1 : text.includes('简体中文') ? 3 : index < 0 ? 6 : index] = 1;
    return values;
  };
  return {
    embedding: { modelId: 'offline-fixture-not-real-embedding', async embed(texts) { return texts.map(vector); } },
    selector: createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async options => {
      const prompt = options.prompt.find(message => message.role === 'user');
      const text = prompt.content.find(part => part.type === 'text').text;
      const question = JSON.parse(text).question;
      const spec = completenessCases.find(item => item.query === question);
      return { content: [{ type: 'text', text: JSON.stringify({ selectedIds: spec.expected.map(label => [...labels].find(([, value]) => value === label)[0]), queries: [] }) }],
        finishReason: { unified: 'stop', raw: undefined }, warnings: [],
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
    } })),
  };
}

/** Validate through the production cache reader using a no-network port, then rebind by exact body hash/revision. */
export async function reuseCompletenessIndex(sourceRoot, root, entries, modelId, requestedModels) {
  const source = await realpath(resolve(sourceRoot));
  const [manifestBytes, projectionBytes, cacheBytes] = await Promise.all(['manifest.json', 'formal-projection.json', 'index.json'].map(file => readFile(join(source, file))));
  const manifest = JSON.parse(manifestBytes), previous = JSON.parse(projectionBytes), cache = JSON.parse(cacheBytes);
  const fail = () => { throw Object.assign(Error('Reused index does not match the fixed corpus/model or is incomplete'), { code: 'reuse_index_invalid' }); };
  if (manifest.suite !== 'memory-completeness-v1' || JSON.stringify(manifest.requestedModels) !== JSON.stringify(requestedModels)
    || hash(JSON.stringify(previous)) !== manifest.corpusHash
    || !Array.isArray(previous) || previous.length !== 512 || cache.modelId !== modelId) fail();
  const noNetwork = { modelId, async embed() { fail(); } };
  const validationFile = join(root, 'reused-source-validation-index.json');
  await writeFile(validationFile, cacheBytes, { mode: 0o600 });
  const coverage = await new LocalMemorySemanticIndex({ file: validationFile, embedding: noNetwork }).maintain(previous, { now: scaleNow, threadId: 'origin' });
  if (coverage.state !== 'ready' || coverage.embeddedCount !== 0 || coverage.indexedCount !== 509) fail();
  const eligiblePrevious = selectEligibleMemoryEntries(previous, { now: scaleNow, threadId: 'origin' });
  const oldById = new Map(eligiblePrevious.map(entry => [entry.id, entry]));
  const recordsByContent = new Map();
  for (const record of cache.records) {
    const entry = oldById.get(record.id);
    if (!entry) continue; // Foreign/inactive records never reach the rebound cache.
    const key = `${memorySemanticTextHash(entry.text)}:${entry.revision ?? 1}`;
    if (recordsByContent.has(key) || record.textHash !== memorySemanticTextHash(entry.text) || record.revision !== (entry.revision ?? 1)) fail();
    recordsByContent.set(key, record);
  }
  const records = selectEligibleMemoryEntries(entries, { now: scaleNow, threadId: 'origin' }).map(entry => {
    const record = recordsByContent.get(`${memorySemanticTextHash(entry.text)}:${entry.revision ?? 1}`);
    if (!record) fail();
    return { ...record, id: entry.id };
  });
  if (records.length !== 509 || recordsByContent.size !== records.length) fail();
  const file = join(root, 'index.json');
  await writeFile(file, JSON.stringify({ ...cache, records }), { mode: 0o600 });
  const rebound = await new LocalMemorySemanticIndex({ file, embedding: noNetwork }).maintain(entries, { now: scaleNow, threadId: 'origin' });
  if (rebound.state !== 'ready' || rebound.embeddedCount !== 0 || rebound.remainingCount !== 0) fail();
  return { source, manifestHash: hash(manifestBytes), projectionHash: hash(projectionBytes), indexHash: hash(cacheBytes),
    reboundIndexHash: hash(await readFile(file)), recordCount: records.length, binding: 'exact body SHA-256 plus revision; IDs from a newly seeded real MemoryStore projection' };
}

export async function runCompleteness({ live = false, reuseIndex, env = process.env,
  outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results') } = {}) {
  if (live && (!env.DASHSCOPE_API_KEY?.trim() || !env.COMMAND_CODE_API_KEY?.trim())) throw Error('Both host API keys are required for --live.');
  const requestedRoot = join(resolve(outputRoot), `memory-recall-completeness-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(requestedRoot);
  const { entries, labels } = await seedCompletenessStore(join(root, 'fixture-store'));
  const requests = [], maintenance = [], rows = [], guard = completenessGuard({ reuseIndex });
  let phase = 'maintenance', caseId = null, environmentFailure = null;
  const observedFetch = kind => async (url, options) => {
    guard(kind);
    const body = JSON.parse(options.body);
    if (reuseIndex && kind === 'embedding' && (phase !== 'query' || typeof body.input !== 'string' || !completenessCases.some(spec => spec.query === body.input))) {
      throw Object.assign(Error('Fact embedding forbidden in reuse mode'), { code: 'reuse_fact_embedding_forbidden' });
    }
    const request = { kind, phase, caseId, modelId: body.model, submittedAt: new Date().toISOString(),
      ...(kind === 'embedding' ? { inputHash: hash(JSON.stringify(body.input)) } : {}) };
    requests.push(request);
    try { const response = await fetch(url, options); request.httpStatus = response.status; return response; }
    catch { request.transportFailure = true; throw Error('Provider transport failed'); }
  };
  const offline = live ? undefined : fixturePorts(labels);
  const embedding = live ? createMemoryEmbedder(normalizeEmbeddingConfig({ provider: 'dashscope', modelId: completenessModels.embedding }), env, observedFetch('embedding')) : offline.embedding;
  const selector = live ? createMemoryRelevanceSelector(configureCliModel(() => { throw Error('No mock model'); }, {
    ...env, RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: completenessModels.relevance,
    COMMAND_CODE_BASE_URL: 'https://api.commandcode.ai/provider/v1',
  }, { fetch: observedFetch('relevance') }).model) : offline.selector;
  const runtimeHashes = Object.fromEntries(await Promise.all(['memory-store', 'memory-semantic-index', 'memory-relevance', 'memory-retrieval', 'memory-embedding-client', 'model-config'].map(async name =>
    [name, hash(await readFile(new URL(`../cli/dist/${name}.js`, import.meta.url)))])));
  const source = await readFile(fileURLToPath(import.meta.url));
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* non-git export */ }
  const manifest = { suite: 'memory-completeness-v1', source: '我的 eval',
    mode: live ? 'real-embedding-and-relevance' : 'offline-contract-fixture-not-quality', planned: completenessCases.length,
    requestedModels: live ? completenessModels : { embedding: embedding.modelId, relevance: 'mock' },
    gitCommit, requestBudget: completenessBudget({ reuseIndex }), runtimeHashes, runtimeFingerprint: hash(JSON.stringify(runtimeHashes)),
    evalFingerprint: hash(source), corpusHash: hash(JSON.stringify(entries)), cases: completenessCases,
    modelVerification: 'Outbound model IDs only; no independent upstream identity attestation.', costUsd: null };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, 'frozen-runner.mjs'), source);
  await writeFile(join(root, 'formal-projection.json'), JSON.stringify(entries, null, 2));
  await writeFile(join(root, 'labels.json'), JSON.stringify(Object.fromEntries(labels), null, 2));
  const index = new LocalMemorySemanticIndex({ file: join(root, 'index.json'), embedding });
  const input = { now: scaleNow, threadId: 'origin' };
  try {
    if (reuseIndex) {
      manifest.reusedIndex = await reuseCompletenessIndex(reuseIndex, root, entries, embedding.modelId, manifest.requestedModels);
      await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    for (let step = 0; step < completenessBudget({ reuseIndex }).maintenancePreparations; step++) {
      const result = await index.maintain(entries, input);
      maintenance.push(result);
      await writeFile(join(root, 'maintenance.json'), JSON.stringify(maintenance, null, 2));
      if (result.state === 'degraded') throw Object.assign(Error('Maintenance degraded'), { code: index.lastFailure?.code ?? 'maintenance_degraded' });
      if (result.state === 'ready') break;
    }
    if (maintenance.at(-1)?.remainingCount !== 0) throw Object.assign(Error('Maintenance incomplete'), { code: 'maintenance_incomplete' });
    phase = 'query';
    for (const spec of completenessCases) {
      caseId = spec.id;
      const semanticHits = await index.search(entries, { ...input, query: spec.query });
      if (index.lastState !== 'ready') throw Object.assign(Error('Query index not ready'), { code: index.lastFailure?.code ?? 'index_incomplete' });
      const diagnostics = index.lastDiagnostics;
      const decision = await selector(caseId, spec.query, entries, { ...input, signal: new AbortController().signal,
        semanticCandidates: diagnostics.candidates.filter(item => item.score !== null).map(item => ({ ...item, score: item.score })) });
      if (decision.state === 'degraded') throw Object.assign(Error('Relevance degraded'), { code: 'relevance_degraded' });
      const selection = retrieveMemories(entries, { ...input, query: spec.query, semanticHits, relevanceSelection: decision.selected });
      const row = { caseId, query: spec.query, expected: spec.expected, diagnostics, decision,
        selected: selection.entries.map(entry => ({ ...entry, label: labels.get(entry.id) })),
        oracle: scoreCompleteness(spec, selection.entries.map(entry => ({ id: labels.get(entry.id) }))) };
      rows.push(row);
      await writeFile(join(root, `${caseId}.json`), JSON.stringify(row, null, 2));
    }
  } catch (error) { environmentFailure = { phase, caseId, code: error.code ?? 'evaluation_failed' }; }
  const summary = { mode: live ? 'real-embedding-and-relevance' : 'offline-contract-fixture-not-quality',
    planned: completenessCases.length, executed: rows.length, unexecuted: completenessCases.length - rows.length,
    passed: rows.filter(row => row.oracle.passed).length, environmentFailure, maintenance, requests,
    qualityPassRate: live ? rows.filter(row => row.oracle.passed).length / completenessCases.length : null };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  return { root, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const reuseAt = args.indexOf('--reuse-index'), reuseIndex = reuseAt < 0 ? undefined : args[reuseAt + 1];
  if (reuseAt >= 0 && (!reuseIndex || reuseIndex.startsWith('--'))) throw Error('--reuse-index requires a report path');
  if (args.some((arg, index) => !(reuseAt >= 0 && index === reuseAt + 1) && !['--live', '--budget', '--reuse-index'].includes(arg))) throw Error('Unknown argument');
  if (args.includes('--budget')) console.log(JSON.stringify(completenessBudget({ reuseIndex }), null, 2));
  else {
    const { root, summary } = await runCompleteness({ live: args.includes('--live'), reuseIndex });
    console.log(JSON.stringify({ report: root, ...summary, requests: summary.requests.length, maintenance: summary.maintenance.at(-1) }, null, 2));
    if (summary.environmentFailure || summary.passed !== summary.planned) process.exitCode = 1;
  }
}
