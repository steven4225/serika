import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '@serika/assistant/internal/memory-store.js';
import { createMemoryEmbedder, normalizeEmbeddingConfig } from '@serika/assistant/internal/memory-embedding-client.js';
import { LocalMemorySemanticIndex, MEMORY_SEMANTIC_WARMUP_BATCH } from '@serika/assistant/internal/memory-semantic-index.js';
import { retrieveMemories } from '@serika/assistant/internal/memory-retrieval.js';
import { buildMemoryContextView } from '@serika/assistant/internal/memory-context-view.js';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';
import { scoreRecall, summarizeRecall } from './memory-recall.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const scaleSizes = [32, 128, 512];
export const scaleNow = new Date('2026-10-15T04:00:00.000Z');
const relevanceModel = { modelId: 'deepseek/deepseek-v4.1-flash-fast', baseURL: 'https://api.commandcode.ai/provider/v1' };

/** Developer-authored synthetic data, not held-out user data. Labels never come from ranks. */
export function makeScaleFixture(size) {
  if (!scaleSizes.includes(size)) throw Error('Unsupported scale');
  const fact = (label, text, extra = {}) => ({ label, text, kind: 'preference', ...extra });
  const facts = Array.from({ length: size }, (_, i) => fact(`noise-${i}`, `档案编号 ${i}：收藏品标签为松石 ${i}。`, { kind: 'note' }));
  const middle = Math.floor(size / 2);
  facts[0] = fact('review', '复盘先给一行结论，再列两条可执行步骤。');
  facts[1] = fact('language', '请默认用简体中文回复。');
  facts[middle] = fact('work-coffee', '工作时我喝咖啡不加糖。', { factIdentity: { attribute: 'coffee', scenario: 'work', value: 'unsweetened' } });
  facts[middle + 1] = fact('personal-coffee', '私人场景我喝咖啡加糖。', { factIdentity: { attribute: 'coffee', scenario: 'personal', value: 'sweetened' } });
  facts[size - 5] = fact('deadline', '周报提交截止时间是每周五下午五点。', { kind: 'event' });
  facts[size - 4] = fact('home', '我住在杭州。', { kind: 'fact' });
  facts[size - 3] = fact('foreign', '我的私人暗号是松果。', { scope: { kind: 'thread', threadId: 'foreign' } });
  facts[size - 2] = fact('retracted', '工作时我喝咖啡加糖。', { retract: true });
  facts[size - 1] = fact('expired', '工作时我喝咖啡加糖。', { expiresAt: '2026-10-01T00:00:00.000Z' });
  const forbidden = ['foreign', 'retracted', 'expired'];
  const cases = [
    { id: 'Q01', category: 'head-direct', query: '复盘', gold: ['review'] },
    { id: 'Q02', category: 'head-paraphrase', query: '你平时应该用哪种语言回答我？', gold: ['language'] },
    { id: 'Q03', category: 'middle-scene', query: '咖啡', gold: ['work-coffee', 'personal-coffee'], noUnconditionalProfile: true },
    { id: 'Q04', category: 'tail-paraphrase', query: '我的常住城市是哪里？', gold: ['home'] },
    { id: 'Q05', category: 'tail-event', query: '周报提交截止时间是什么时候？', gold: ['deadline'] },
    { id: 'Q06', category: 'irrelevant', query: '解释量子纠缠的原理', gold: [] },
    { id: 'Q07', category: 'scope', query: '我的私人暗号是什么？', gold: [] },
    { id: 'Q08', category: 'lifecycle', query: '我工作时咖啡加不加糖？', gold: ['work-coffee'] },
  ].map(spec => ({ ...spec, forbidden }));
  return { version: 'memory-scale-corpus-v1', size, threadId: 'origin', facts, cases };
}

export function scaleRequestBudget() {
  const perScale = scaleSizes.map(size => {
    const eligible = size - 3, queries = 8, warmupPreparations = Math.ceil(eligible / MEMORY_SEMANTIC_WARMUP_BATCH);
    return { size, eligible, coldFact: queries * Math.min(eligible, MEMORY_SEMANTIC_WARMUP_BATCH), coldQuery: queries,
      warmupFact: eligible, warmupQuery: warmupPreparations, warmFact: 0, warmQuery: queries, relevance: queries * 2 };
  });
  const embedding = perScale.reduce((sum, row) => sum + row.coldFact + row.coldQuery + row.warmupFact + row.warmupQuery + row.warmQuery, 0);
  return { perScale, embeddingHttpUpperBound: embedding, relevanceHttpUpperBound: 48, noRetries: true,
    assumption: 'fixed DashScope single-string requests; unchanged formal projection; one relevance call per scored query' };
}

/** Enforced before dispatch; a provider failure never grants another budget slot. */
export function createScaleRequestGuard({ relevance = false } = {}) {
  const budget = scaleRequestBudget();
  let embeddingCount = 0, relevanceCount = 0;
  return kind => {
    if (kind === 'relevance') {
      if (!relevance || relevanceCount >= budget.relevanceHttpUpperBound) throw Object.assign(Error('Request budget exhausted'), { code: 'request_budget_exhausted' });
      relevanceCount++;
    } else {
      if (embeddingCount >= budget.embeddingHttpUpperBound) throw Object.assign(Error('Request budget exhausted'), { code: 'request_budget_exhausted' });
      embeddingCount++;
    }
  };
}

/** Warming is partial coverage, not degradation. This does not retry an evaluation case. */
export async function prepareScaleIndex(index, entries, input) {
  const started = Date.now(), hits = await index.search(entries, input);
  if (!['ready', 'warming'].includes(index.lastState)) {
    const error = Error('Embedding preparation failed');
    error.code = index.lastFailure?.code ?? 'embedding_degraded';
    throw error;
  }
  return { hits, state: index.lastState, durationMs: Date.now() - started, diagnostics: index.lastDiagnostics ?? null };
}

export function summarizeScale(rows, environmentFailure = null) {
  const summarize = (size, lane) => {
    const selected = rows.filter(row => row.size === size && row.lane === lane);
    const durations = selected.filter(row => row.hybrid).map(row => row.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const requests = selected.flatMap(row => row.requests ?? []);
    return { ...summarizeRecall(selected, 8),
      latencyMs: { mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
        p95: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null },
      requestCounts: { fact: requests.filter(item => item.kind === 'fact').length,
        query: requests.filter(item => item.kind === 'query').length,
        relevance: requests.filter(item => item.kind === 'relevance').length, tokens: null } };
  };
  return scaleSizes.map(size => ({ size, cold: summarize(size, 'cold'),
    warm: summarize(size, 'warm'),
    environmentFailure: environmentFailure?.size === size ? environmentFailure : null }));
}

export async function runScaleRecall({ live = false, relevance = false, env = process.env,
  outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results') } = {}) {
  if (!live) throw Error('Use --live explicitly; local tests do not generate real-model quality scores.');
  if (!env.DASHSCOPE_API_KEY?.trim()) throw Error('DASHSCOPE_API_KEY is required in the host environment.');
  if (relevance && !env.COMMAND_CODE_API_KEY?.trim()) throw Error('COMMAND_CODE_API_KEY is required in the host environment.');
  const config = normalizeEmbeddingConfig({ provider: 'dashscope', modelId: 'qwen3.7-text-embedding-flash' });
  const requestedRoot = join(resolve(outputRoot), `memory-recall-scale-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(requestedRoot), fixtures = scaleSizes.map(makeScaleFixture);
  const ownSource = await readFile(fileURLToPath(import.meta.url)), oracleSource = await readFile(new URL('./memory-recall.mjs', import.meta.url));
  const runtimeFiles = ['memory-store', 'memory-retrieval', 'memory-semantic-index', 'memory-embedding-client', 'memory-relevance',
    'memory-context-view', 'memory-fact-identity', 'memory-observation-policy', 'memory-temporal', 'memory-candidates', 'model-config'];
  const runtimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async name => [name, hash(await readFile(new URL(`../../packages/assistant/dist/${name}.js`, import.meta.url)))])));
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* non-git export */ }
  const manifest = { suite: 'memory-recall-scale-v1', source: '我的 eval', datasetRole: 'developer-authored synthetic scale set; not blind held-out data',
    kind: 'real-embedding-retrieval-not-chat-e2e', config, requestedModelId: config.modelId,
    relevance: relevance ? { ...relevanceModel, alias: 'command-code/default' } : null, gitCommit, runtimeHashes,
    runtimeFingerprint: hash(JSON.stringify(runtimeHashes)), corpusHash: hash(JSON.stringify(fixtures)), oracleHash: hash(oracleSource),
    evalFingerprint: hash(Buffer.concat([ownSource, oracleSource])), planned: 48, coldPlanned: 24, warmPlanned: 24,
    caseIds: fixtures.flatMap(fixture => ['cold', 'warm'].flatMap(lane => fixture.cases.map(spec => `${fixture.size}-${lane}-${spec.id}`))),
    now: scaleNow.toISOString(), maxEntries: 3, requestBudget: scaleRequestBudget(),
    modelVerification: 'Configured endpoint/model; compatible response identity is not independently verified.',
    httpEvidence: 'modelId is the outbound request model field, not verified upstream model identity. All dispatched attempts, including failed HTTP/transport, count. No response bodies retained.',
    cadence: { scales: 'sequential', scoredCases: 'sequential', embeddingConcurrency: 10, prepareDeadlineMs: 5000,
      relevanceDeadlineMs: 5000, wholeSuiteDeadlineMs: null, retries: 0, onEnvironmentFailure: 'stop before next case' },
    warmingPolicy: 'Each cold case has a fresh cache. Separate bounded warmup prepares all eligible facts before warm scoring. No whole-case retries.' };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, 'corpus.json'), JSON.stringify(fixtures, null, 2));
  await writeFile(join(root, 'frozen-runner.mjs'), ownSource);
  await writeFile(join(root, 'frozen-oracle.mjs'), oracleSource);
  const rows = [], requests = [], warmup = [], limitRequest = createScaleRequestGuard({ relevance });
  let policyFailure = null;
  const guardRequest = kind => {
    try { limitRequest(kind); } catch (error) { policyFailure = error.code; throw error; }
  };
  let activity = {};
  let environmentFailure = null;
  let selectRelevance;
  if (relevance) {
    const { createMemoryRelevanceSelector } = await import('@serika/assistant/internal/memory-relevance.js');
    const configured = configureCliModel(() => { throw Error('No mock model'); }, { ...env, RUNLOOM_MODEL: 'command-code',
      COMMAND_CODE_MODEL_ID: relevanceModel.modelId, COMMAND_CODE_BASE_URL: relevanceModel.baseURL }, {
      fetch: async (url, options) => {
        guardRequest('relevance');
        const body = JSON.parse(options.body), request = { ...activity, kind: 'relevance', modelId: body.model,
          submittedAt: new Date().toISOString(), tokens: null };
        requests.push(request);
        try { const response = await fetch(url, options); request.httpStatus = response.status; return response; }
        catch { request.transportFailure = true; throw Error('Relevance transport failed'); }
      },
    });
    selectRelevance = createMemoryRelevanceSelector(configured.model);
  }
  for (const fixture of fixtures) {
    const workspace = join(root, String(fixture.size)), store = createMemoryStore(workspace), labels = new Map();
    await mkdir(workspace, { mode: 0o700 });
    try {
      const retractions = [];
      for (const { label, retract, ...input } of fixture.facts) {
        const saved = await store.add(input, undefined, { now: new Date('2026-09-30T04:00:00.000Z') });
        if (!saved.ok) throw Object.assign(Error('Fixture write failed'), { code: saved.error.code });
        labels.set(saved.entry.id, label);
        if (retract) retractions.push(saved.entry);
      }
      // Every seed write precedes the later lifecycle clock; never write seedNow after a retraction.
      for (const entry of retractions) {
        const result = await store.reviseMemory({ id: entry.id, expectedRevision: entry.revision, operation: 'retract' }, undefined, { now: scaleNow });
        if (!result.ok) throw Object.assign(Error('Fixture retract failed'), { code: result.error.code });
      }
      const snapshot = await store.list(undefined, { now: scaleNow });
      if (!snapshot.ok) throw Object.assign(Error('Fixture read failed'), { code: snapshot.error.code });
      const positions = new Map(fixture.facts.map((fact, i) => [fact.label, i]));
      const entries = snapshot.entries.sort((a, b) => positions.get(labels.get(a.id)) - positions.get(labels.get(b.id)));
      const factTexts = new Set(entries.map(entry => entry.text));
      await writeFile(join(workspace, 'formal-before.json'), JSON.stringify(entries, null, 2));
      let phase = 'cold', activeCase = null;
      const embedder = createMemoryEmbedder(config, env, async (url, options) => {
        guardRequest('embedding');
        const body = JSON.parse(options.body), text = body.input;
        const request = { kind: factTexts.has(text) ? 'fact' : 'query', phase, size: fixture.size, caseId: activeCase,
          modelId: body.model, inputCount: typeof text === 'string' ? 1 : text.length,
          inputHash: hash(JSON.stringify(text)), submittedAt: new Date().toISOString(), tokens: null };
        requests.push(request);
        try { const response = await fetch(url, options); request.httpStatus = response.status; return response; }
        catch { request.transportFailure = true; throw Error('Embedding transport failed'); }
      });
      const indexFor = file => new LocalMemorySemanticIndex({ file, embedding: embedder });
      const input = query => ({ query, threadId: fixture.threadId, now: scaleNow, maxEntries: 3 });
      const selected = selection => selection.entries.map(entry => ({ label: labels.get(entry.id), id: entry.id, revision: entry.revision, text: entry.text, scope: entry.scope }));
      for (const lane of ['cold', 'warm']) {
        phase = lane;
        const warmFile = join(workspace, 'warm-cache', 'index.json');
        if (lane === 'warm') {
          phase = 'warmup'; activeCase = null;
          activity = { phase, size: fixture.size, caseId: null };
          const maxSteps = Math.ceil((fixture.size - 3) / MEMORY_SEMANTIC_WARMUP_BATCH);
          for (let step = 0; step < maxSteps; step++) {
            const requestStart = requests.length;
            const preparation = await prepareScaleIndex(indexFor(warmFile), entries, input('索引预热校验'));
            const record = { size: fixture.size, step: step + 1, ...preparation, requests: requests.slice(requestStart) };
            warmup.push(record);
            await writeFile(join(workspace, `warmup-${step + 1}.json`), JSON.stringify(record, null, 2));
            if (preparation.state === 'ready') break;
            if (step === maxSteps - 1) throw Object.assign(Error('Warmup incomplete'), { code: 'warmup_incomplete' });
          }
          phase = 'warm';
        }
        for (const spec of fixture.cases) {
          activeCase = `${fixture.size}-${lane}-${spec.id}`;
          activity = { phase, size: fixture.size, caseId: activeCase };
          const started = Date.now(), requestStart = requests.length;
          const row = { id: activeCase, size: fixture.size, lane, category: spec.category, spec };
          rows.push(row);
          try {
            const lexicalStart = Date.now(), lexical = retrieveMemories(entries, input(spec.query));
            const profile = spec.noUnconditionalProfile ? buildMemoryContextView(entries, [], input(spec.query)).profile
              .filter(item => ['work-coffee', 'personal-coffee'].includes(labels.get(item.id))) : [];
            row.lexical = { selected: selected(lexical), durationMs: Date.now() - lexicalStart };
            row.lexical.oracle = scoreRecall(spec, row.lexical.selected, profile);
            const index = indexFor(lane === 'cold' ? join(workspace, activeCase, 'index.json') : warmFile);
            row.embedding = await prepareScaleIndex(index, entries, input(spec.query));
            let options = { ...input(spec.query), semanticHits: row.embedding.hits };
            if (selectRelevance) {
              const decision = await selectRelevance(activeCase, spec.query, entries, { ...input(spec.query), signal: new AbortController().signal,
                semanticCandidates: row.embedding.diagnostics?.candidates.filter(item => item.score !== null)
                  .map(({ id, revision, textHash, score }) => ({ id, revision, textHash, score })) });
              row.relevance = decision;
              if (decision.state === 'degraded') throw Object.assign(Error('Relevance failed'), { code: 'relevance_degraded' });
              options = { ...input(spec.query), relevanceSelection: decision.selected };
            }
            const hybrid = selected(retrieveMemories(entries, options));
            row.hybrid = { selected: hybrid, oracle: scoreRecall(spec, hybrid, profile) };
          } catch (error) {
            environmentFailure = { size: fixture.size, caseId: activeCase, code: policyFailure ?? error.code ?? 'evaluation_failed' };
            row.environmentFailure = environmentFailure;
          } finally {
            row.durationMs = Date.now() - started; row.requests = requests.slice(requestStart);
            await writeFile(join(workspace, `${activeCase}.json`), JSON.stringify(row, null, 2));
          }
          if (environmentFailure) break;
        }
        if (environmentFailure) break;
      }
    } catch (error) { environmentFailure = { size: fixture.size, code: policyFailure ?? error.code ?? 'fixture_or_warmup_failed' }; }
    if (environmentFailure) break;
  }
  const metrics = summarizeScale(rows, environmentFailure);
  const hybrid = metrics.flatMap(item => [item.cold.hybrid, item.warm.hybrid]);
  const executed = hybrid.reduce((sum, item) => sum + item.executed, 0), passed = hybrid.reduce((sum, item) => sum + item.passed, 0);
  const summary = { status: environmentFailure ? 'environment_failed' : executed < 48 ? 'incomplete' : passed === 48 ? 'completed_pass' : 'completed_with_failures',
    planned: 48, executed, passed, unexecuted: 48 - executed, passRateOfPlanned: passed / 48, metrics, environmentFailure,
    requestCounts: { fact: requests.filter(item => item.kind === 'fact').length, query: requests.filter(item => item.kind === 'query').length,
      relevance: requests.filter(item => item.kind === 'relevance').length, warmup: requests.filter(item => item.phase === 'warmup').length,
      tokens: null, costUsd: null },
    warmupMetrics: scaleSizes.map(size => ({ size, preparations: warmup.filter(item => item.size === size).length,
      durationMs: warmup.filter(item => item.size === size).reduce((sum, item) => sum + item.durationMs, 0),
      factRequests: requests.filter(item => item.size === size && item.phase === 'warmup' && item.kind === 'fact').length,
      queryRequests: requests.filter(item => item.size === size && item.phase === 'warmup' && item.kind === 'query').length })), warmup, requests, rows };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  return { root, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--live', '--relevance', '--budget'].includes(arg))) throw Error('Unknown argument');
  if (args.includes('--budget')) console.log(JSON.stringify(scaleRequestBudget(), null, 2));
  else {
    const { root, summary } = await runScaleRecall({ live: args.includes('--live'), relevance: args.includes('--relevance') });
    const { rows, requests, warmup, ...compact } = summary;
    console.log(JSON.stringify({ report: root, ...compact }, null, 2));
    if (summary.status !== 'completed_pass') process.exitCode = 1;
  }
}
