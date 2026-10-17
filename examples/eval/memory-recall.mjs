import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '@serika/example-cli/internal/memory-store.js';
import { createMemoryEmbedder, normalizeEmbeddingConfig } from '@serika/example-cli/internal/memory-embedding-client.js';
import { LocalMemorySemanticIndex } from '@serika/example-cli/internal/memory-semantic-index.js';
import { retrieveMemories } from '@serika/example-cli/internal/memory-retrieval.js';
import { buildMemoryContextView } from '@serika/example-cli/internal/memory-context-view.js';
import { configureCliModel } from '@serika/example-cli/internal/model-config.js';
import { observeModelUsage } from '@serika/example-cli/internal/model-usage-observer.js';

const relevanceModel = { alias: 'command-code/default', provider: 'openai-compatible.chat',
  modelId: 'deepseek/deepseek-v4.1-flash-fast', baseURL: 'https://api.commandcode.ai/provider/v1' };

const fact = (label, text, kind = 'preference', extra = {}) => ({ label, text, kind, ...extra });
const style = fact('style', '复盘先给一行结论，再列两条可执行步骤。');
const coffee = fact('coffee', '我喝咖啡不加糖。');
const home = fact('home', '我住在杭州。', 'fact');
const noise = fact('noise', '晚饭时间是七点。', 'note');
// New suite; never alters or regrades the previous RM/RD results.
export const memoryRecallCases = [
  { id: 'MR01', category: 'direct', query: '复盘', facts: [style, noise], gold: ['style'] },
  { id: 'MR02', category: 'paraphrase', query: '回顾过去一周应该怎样组织内容？', facts: [style, noise], gold: ['style'] },
  { id: 'MR03', category: 'paraphrase', query: '给我点拿铁时应避开什么添加物？', facts: [coffee, home], gold: ['coffee'] },
  { id: 'MR04', category: 'paraphrase', query: '我的居住城市在哪里？', facts: [home, noise], gold: ['home'] },
  { id: 'MR05', category: 'kind', query: '我的咖啡偏好', facts: [coffee, ...Array.from({ length: 15 }, (_, n) =>
    fact(`event${n}`, `咖啡记录：第${n}次到店。`, 'event'))], gold: ['coffee'], first: 'coffee' },
  { id: 'MR06', category: 'kind', query: '杭州咖啡节', facts: [coffee, fact('festival', '杭州咖啡节。', 'event')], gold: ['festival'], first: 'festival' },
  { id: 'MR07', category: 'irrelevant', query: '解释量子纠缠的原理', facts: [coffee, style, home], gold: [] },
  { id: 'MR08', category: 'scope', query: '暗号', threadId: 'other', facts: [fact('private', '暗号是松果。', 'fact', { scope: { kind: 'thread', threadId: 'origin' } })], gold: [], forbidden: ['private'] },
  { id: 'MR09', category: 'scope', query: '暗号', threadId: 'origin', facts: [fact('private', '暗号是松果。', 'fact', { scope: { kind: 'thread', threadId: 'origin' } })], gold: ['private'] },
  { id: 'MR10', category: 'lifecycle', query: '咖啡', facts: [coffee, fact('disabled', '咖啡加糖。', 'preference', { enabled: false }),
    fact('expired', '咖啡加糖。', 'preference', { expiresAt: '2026-10-01T00:00:00.000Z' }), fact('retracted', '咖啡加糖。', 'preference', { retract: true })],
    gold: ['coffee'], forbidden: ['disabled', 'expired', 'retracted'] },
  { id: 'MR11', category: 'lifecycle', query: '咖啡', facts: [{ ...coffee, text: '我喝咖啡加糖。', correctedText: coffee.text }], gold: ['coffee'], forbiddenText: ['我喝咖啡加糖'] },
  { id: 'MR12', category: 'scene', query: '咖啡', facts: [
    fact('work', '工作时我喝咖啡不加糖。', 'preference', { factIdentity: { attribute: 'coffee', scenario: 'work', value: 'unsweetened' } }),
    fact('personal', '私人场景我喝咖啡加糖。', 'preference', { factIdentity: { attribute: 'coffee', scenario: 'personal', value: 'sweetened' } })],
    gold: ['work', 'personal'], noUnconditionalProfile: true },
];

// Developer-authored validation set, not a blind benchmark or a regrade of MR01–MR12.
// Off-target topical entries are explicitly forbidden here, using the existing oracle.
export const memoryRecallValidationCases = [
  { id: 'MH01', category: 'paraphrase', query: '你平时应该用哪种语言回答我？', facts: [
    fact('reply_language', '请默认用简体中文回复。'), fact('background', '我是后端工程师。', 'fact')],
    gold: ['reply_language'], forbidden: ['background'] },
  { id: 'MH02', category: 'precision', query: '我的周报格式偏好是什么？', facts: [
    fact('weekly_style', '周报先列风险，再列本周进展。'), fact('weekly_event', '周报记录：本周已经写完。', 'event')],
    gold: ['weekly_style'], forbidden: ['weekly_event'] },
  { id: 'MH03', category: 'precision', query: '周报提交截止时间是什么时候？', facts: [
    fact('weekly_deadline', '周报提交截止时间是每周五下午五点。', 'event'), fact('weekly_style', '周报先列风险，再列本周进展。')],
    gold: ['weekly_deadline'], forbidden: ['weekly_style'] },
  { id: 'MH04', category: 'irrelevant', query: '咖啡为什么会影响睡眠？', facts: [
    fact('coffee', '我喜欢美式咖啡。'), fact('language', '请默认用简体中文回复。')], gold: [] },
];

/** Gold labels are fixture-owned, never supplied by the model or by the candidate ranks. */
export function scoreRecall(spec, selected, profile = []) {
  const labels = selected.map(entry => entry.label), relevant = new Set(spec.gold);
  const hits = [...new Set(labels.filter(label => relevant.has(label)))].length;
  const missing = spec.gold.filter(label => !labels.includes(label));
  const unexpected = labels.filter(label => !relevant.has(label));
  const forbidden = labels.filter(label => (spec.forbidden ?? []).includes(label));
  const forbiddenText = selected.some(entry => (spec.forbiddenText ?? []).some(text => entry.text.includes(text)));
  const firstCorrect = !spec.first || labels[0] === spec.first;
  return { passed: !missing.length && !forbidden.length && !forbiddenText && firstCorrect
      && (!spec.noUnconditionalProfile || profile.length === 0) && (spec.gold.length > 0 || !labels.length),
    recall: relevant.size ? hits / relevant.size : null,
    precision: labels.length ? hits / labels.length : null,
    missing, unexpected, forbidden, forbiddenText, firstCorrect };
}

export function summarizeRecall(rows, planned) {
  const summarize = lane => {
    const executed = rows.filter(row => row[lane]);
    const mean = key => { const values = executed.map(row => row[lane].oracle[key]).filter(v => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
    return { passed: executed.filter(row => row[lane].oracle.passed).length, executed: executed.length,
      planned, unexecuted: planned - executed.length, passRateOfPlanned: executed.filter(row => row[lane].oracle.passed).length / planned,
      meanRecall: mean('recall'), meanPrecision: mean('precision'),
      irrelevantCases: executed.filter(row => row.category === 'irrelevant').length,
      irrelevantFalsePositives: executed.filter(row => row.category === 'irrelevant' && row[lane].selected.length > 0).length,
      forbiddenHits: executed.reduce((sum, row) => sum + row[lane].oracle.forbidden.length, 0) };
  };
  const lexical = summarize('lexical'), hybrid = summarize('hybrid');
  return { lexical, hybrid, percentagePointChange: hybrid.executed === planned && lexical.executed === planned
    ? (hybrid.passRateOfPlanned - lexical.passRateOfPlanned) * 100 : null };
}

/** A completed negative measurement is not a transport failure or a missing report. */
export function formatRecallResult({ root, summary }) {
  const precisionWarnings = summary.rows.filter(row => row.hybrid?.oracle.unexpected.length).map(row => ({
    caseId: row.id, casePassed: row.hybrid.oracle.passed, precision: row.hybrid.oracle.precision,
    unexpected: row.hybrid.oracle.unexpected, evidence: join(root, row.id, 'evidence.json'),
  }));
  const failedCases = summary.rows.filter(row => row.hybrid?.oracle.passed === false).map(row => ({
    caseId: row.id, category: row.category, query: row.spec.query, expected: row.spec.gold,
    selected: row.hybrid.selected.map(entry => entry.label), missing: row.hybrid.oracle.missing,
    unexpected: row.hybrid.oracle.unexpected, forbidden: row.hybrid.oracle.forbidden,
    firstCorrect: row.hybrid.oracle.firstCorrect, evidence: join(root, row.id, 'evidence.json'),
  }));
  const status = summary.environmentFailure ? 'environment_failed' : summary.probe ? 'probe_completed'
    : summary.hybrid.executed !== summary.hybrid.planned ? 'incomplete'
    : summary.hybrid.passed !== summary.hybrid.planned ? 'completed_with_failures' : 'completed_pass';
  return { report: root, status,
    ...(summary.relevance ? { pipeline: 'hybrid+relevance' } : {}),
    ...(summary.probe ? { probe: true, embedding: summary.rows[0]?.embedding }
      : { lexical: summary.lexical, hybrid: summary.hybrid, percentagePointChange: summary.percentagePointChange }),
    failedCases, precisionWarnings, environmentFailure: summary.environmentFailure };
}

export async function runMemoryRecall({ live = false, probe = false, relevance = false, suite = 'regression', provider = 'dashscope', baseURL, modelId, env = process.env,
  outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results') } = {}) {
  if (!live) throw Error('Use --live only with an explicitly configured embedding service; no mock scores are generated.');
  if (!['regression', 'validation'].includes(suite)) throw Error('Unknown recall suite; use regression or validation.');
  if (relevance && probe) throw Error('Embedding probe cannot enable relevance judgment.');
  if (relevance && !env.COMMAND_CODE_API_KEY?.trim()) throw Error('Configure COMMAND_CODE_API_KEY in the host environment, never in chat or report files.');
  const config = normalizeEmbeddingConfig({ provider, baseURL, modelId });
  if (relevance && (config.provider !== 'dashscope' || config.modelId !== 'qwen3.7-text-embedding-flash')) throw Error('Relevance acceptance requires the fixed DashScope qwen3.7-text-embedding-flash configuration.');
  const relevanceSelector = relevance ? (await import('@serika/example-cli/internal/memory-relevance.js')).createMemoryRelevanceSelector : null;
  const suiteCases = suite === 'validation' ? memoryRecallValidationCases : memoryRecallCases;
  const cases = probe ? suiteCases.slice(0, 1) : suiteCases;
  if (config.provider === 'dashscope' && !env.DASHSCOPE_API_KEY) throw Error('Configure DASHSCOPE_API_KEY in the host environment, never in chat or report files.');
  const requestedRoot = join(resolve(outputRoot), `memory-recall-${suite === 'validation' ? 'validation-' : ''}${relevance ? 'relevance-' : ''}${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(requestedRoot); // macOS /var temp aliases are not index authority.
  const now = new Date('2026-10-14T04:00:00.000Z'), seedNow = new Date('2026-09-30T04:00:00.000Z');
  const rows = [];
  const hash = value => createHash('sha256').update(value).digest('hex');
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* non-git export */ }
  const sourceFiles = ['memory-retrieval', 'memory-semantic-index', 'memory-embedding-client', 'memory-context-view', 'memory-store',
    ...(relevance ? ['memory-relevance', 'model-config', 'model-usage-observer'] : [])];
  const runtimeHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
    hash(await readFile(new URL(`../cli/dist/${file}.js`, import.meta.url)))])));
  const manifest = { suite: probe ? 'memory-embedding-probe-v1' : suite === 'validation' ? 'memory-recall-validation-v1' : 'memory-recall-v1', source: '我的 eval',
    kind: probe ? 'connectivity-diagnostic-not-recall-accuracy' : `real-${config.provider}-embedding-retrieval-not-chat-e2e`, probe, config,
    modelVerification: 'Configured endpoint/model; compatible response identity is not independently verified.',
    ...(relevance ? { pipeline: 'hybrid+relevance', relevance: { ...relevanceModel, maxCallsPerCase: 1, timeoutMs: 5000,
      separateQueryRewrite: false } } : {}),
    gitCommit, runtimeHashes, evalFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
    planned: cases.length, caseIds: cases.map(spec => spec.id), topK: 3, threshold: 0.5, rrfK: 60,
    ...(suite === 'validation' ? { datasetRole: 'developer-authored independent validation; not blind held-out data' } : {}),
    corpus: 'isolated synthetic formal memory', now: now.toISOString() };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, 'frozen-eval.mjs'), await readFile(fileURLToPath(import.meta.url)));
  let environmentFailure = null;
  for (const spec of cases) {
    const workspace = join(root, spec.id), store = createMemoryStore(workspace), labels = new Map();
    await mkdir(workspace, { mode: 0o700 });
    try {
      for (const { label, retract, correctedText, ...input } of spec.facts) {
        const saved = await store.add(input, undefined, { now: seedNow });
        if (!saved.ok) throw Error(saved.error.code);
        labels.set(saved.entry.id, label);
        if (retract) {
          const result = await store.reviseMemory({ id: saved.entry.id, expectedRevision: saved.entry.revision, operation: 'retract' }, undefined, { now });
          if (!result.ok) throw Error(result.error.code);
        }
        if (correctedText) {
          const result = await store.update(saved.entry.id, { text: correctedText, expectedRevision: saved.entry.revision }, undefined, { now });
          if (!result.ok) throw Error(result.error.code);
        }
      }
      const snapshot = await store.list(undefined, { now });
      if (!snapshot.ok) throw Error(snapshot.error.code);
      const input = { query: spec.query, now, threadId: spec.threadId ?? 'origin', maxEntries: 3 };
      const profile = buildMemoryContextView(snapshot.entries, [], input).profile;
      const selected = selection => selection.entries.map(entry => ({ label: labels.get(entry.id), id: entry.id,
        revision: entry.revision, text: entry.text, scope: entry.scope, assertion: entry.assertion }));
      const lexicalSelection = retrieveMemories(snapshot.entries, input), lexical = selected(lexicalSelection);
      const row = { id: spec.id, category: spec.category, spec, lexical: { selected: lexical,
        reasons: lexicalSelection.selected, oracle: scoreRecall(spec, lexical, profile) } };
      rows.push(row);
      const httpRequests = [];
      const embedder = createMemoryEmbedder(config, env, async (url, options) => {
        const body = JSON.parse(options.body), texts = typeof body.input === 'string' ? [body.input] : body.input;
        const request = { modelId: body.model, inputCount: texts.length,
          inputHashes: texts.map(text => hash(text)), submittedAt: new Date().toISOString() };
        httpRequests.push(request);
        try {
          const response = await fetch(url, options); request.httpStatus = response.status;
          return response;
        } catch (error) { request.transportFailure = true; throw error; }
      });
      const index = new LocalMemorySemanticIndex({ file: join(workspace, '.runloom', 'memory-semantic-index.json'), embedding: embedder });
      const started = Date.now(), hits = await index.search(snapshot.entries, input);
      row.embedding = { state: index.lastState === 'ready' && !httpRequests.length ? 'not_applicable' : index.lastState, durationMs: Date.now() - started,
        requestMode: embedder.requestMode, usage: embedder.lastUsage, httpRequests, hits, diagnostics: index.lastDiagnostics,
        failure: index.lastFailure, responseMapping: embedder.lastResponseMapping };
      if (index.lastState !== 'ready') throw Error(`Embedding ${index.lastState}: ${index.lastFailure?.code ?? 'unknown'}; lexical fallback is not semantic acceptance.`);
      const hybridSelection = retrieveMemories(snapshot.entries, { ...input, semanticHits: hits }), hybrid = selected(hybridSelection);
      const ordinaryHybrid = { selected: hybrid, reasons: hybridSelection.selected, oracle: scoreRecall(spec, hybrid, profile) };
      if (!relevance) row.hybrid = ordinaryHybrid;
      else {
        row.hybridBeforeRelevance = ordinaryHybrid;
        const calls = [], modelRequests = [];
        const configured = configureCliModel(() => { throw Error('Mock relevance is not permitted'); }, { ...env,
          RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: relevanceModel.modelId, COMMAND_CODE_BASE_URL: relevanceModel.baseURL }, {
          fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            const request = { modelId: body.model, submittedAt: new Date().toISOString() };
            modelRequests.push(request);
            try { const response = await fetch(url, options); request.httpStatus = response.status; return response; }
            catch (error) { request.transportFailure = true; throw error; }
          },
        });
        const observed = observeModelUsage(configured.model, { records: {
          startModelCall: async call => { calls.push(structuredClone(call)); },
          finishModelCall: async (id, status, usage) => {
            const call = calls.find(item => item.id === id);
            if (call) Object.assign(call, { status, usage: { ...usage }, finishedAt: new Date().toISOString() });
          },
        }, threadId: spec.id, enabled: () => true, scope: () => ({ purpose: 'query_rewrite' }) });
        const started = Date.now();
        const decision = await relevanceSelector(observed)(spec.id, spec.query, snapshot.entries, { ...input,
          signal: new AbortController().signal, semanticCandidates: index.lastDiagnostics?.candidates
            .filter(item => item.score !== null).map(({ id, revision, textHash, score }) => ({ id, revision, textHash, score })) });
        row.relevance = { state: decision.state, selectedIds: decision.selected.map(item => item.id), queries: decision.queries,
          candidateCount: decision.candidateCount, truncated: decision.truncated, durationMs: Date.now() - started,
          model: { ...relevanceModel }, usage: calls.length === 1 ? { ...calls[0].usage } : {}, calls, httpRequests: modelRequests };
        if (decision.state === 'degraded' || modelRequests.length > 1 || calls.length > 1) {
          environmentFailure = { caseId: spec.id, code: 'relevance_degraded', message: 'Relevance judgment degraded; ordinary hybrid fallback is not relevance acceptance.' };
        } else {
          const fresh = await store.list(undefined, { now });
          if (!fresh.ok) throw Error(fresh.error.code);
          const finalSelection = retrieveMemories(fresh.entries, { ...input, relevanceSelection: decision.selected });
          const final = selected(finalSelection);
          row.hybrid = { selected: final, reasons: finalSelection.selected, oracle: scoreRecall(spec, final, profile) };
        }
      }
      row.profile = profile;
    } catch (error) {
      environmentFailure = { caseId: spec.id, message: error.message,
        ...(rows.at(-1)?.id === spec.id && rows.at(-1)?.embedding?.failure ? { code: rows.at(-1).embedding.failure.code } : {}) };
    }
    await writeFile(join(workspace, 'evidence.json'), JSON.stringify(rows.at(-1)?.id === spec.id ? rows.at(-1) : { id: spec.id, environmentFailure }, null, 2));
    if (environmentFailure) break; // No retries; remaining planned cases remain visible as unexecuted.
  }
  const summary = { ...summarizeRecall(rows, manifest.planned), environmentFailure, probe, ...(relevance ? { relevance: true } : {}),
    ...(probe ? { percentagePointChange: null } : {}),
    embeddingCasesExecuted: rows.filter(row => row.embedding?.httpRequests.length).length,
    policyOnlyCases: rows.filter(row => row.embedding?.state === 'not_applicable').length, rows };
  const result = formatRecallResult({ root, summary });
  summary.status = result.status; summary.failedCases = result.failedCases; summary.precisionWarnings = result.precisionWarnings;
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  return { root, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--live' && arg !== '--probe' && arg !== '--relevance' && !arg.startsWith('--suite=') && !arg.startsWith('--provider=') && !arg.startsWith('--base-url=') && !arg.startsWith('--model='))) throw Error('Unknown argument');
  const option = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const result = await runMemoryRecall({ live: args.includes('--live'), probe: args.includes('--probe'), relevance: args.includes('--relevance'), suite: option('--suite'), provider: option('--provider'), baseURL: option('--base-url'), modelId: option('--model') });
  const output = formatRecallResult(result);
  console.log(JSON.stringify(output, null, 2));
  if (result.summary.environmentFailure) {
    console.error(`评测环境失败：${result.summary.environmentFailure.code ?? 'unknown'}；请查看报告，未执行的题不算模型测试失败。`);
    process.exitCode = 1;
  } else if (!result.summary.probe && result.summary.hybrid.passed !== result.summary.hybrid.planned) {
    console.error(`评测${output.status === 'incomplete' ? '未完成' : '已完成'}：混合召回 ${result.summary.hybrid.passed}/${result.summary.hybrid.planned}；失败题：${output.failedCases.map(item => item.caseId).join('、') || '无已执行失败题'}。退出码 1 表示未达到全部通过门槛，不是 embedding 接口调用失败。`);
    process.exitCode = 1;
  }
}
