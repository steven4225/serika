import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeApp } from '@aisdk-agent/example-cli/dist/app.js';
import { createAssistantController } from '@aisdk-agent/example-cli/dist/assistant-controller.js';
import { configureCliModel } from '@aisdk-agent/example-cli/dist/model-config.js';
import { createMemoryStore } from '@aisdk-agent/example-cli/dist/memory-store.js';
import { retrieveMemories } from '@aisdk-agent/example-cli/dist/memory-retrieval.js';
import { createTransitionFetch, transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

export const everydayOracleVersion = 'memory-everyday-oracle-v1';
const domains = [
  { prefix: 'ED', attribute: 'diet_spiciness', label: '饮食辣度', oldValue: 'none', value: 'mild', oldWord: '不辣', word: '微辣' },
  { prefix: 'EN', attribute: 'notification_channel', label: '通知渠道', oldValue: 'in_app', value: 'telegram', oldWord: '应用内', word: 'Telegram' },
];
/** Developer-authored canonical-vocabulary acceptance; not blind held-out data. */
export const everydayCases = Object.freeze(domains.flatMap(domain => {
  const ordinary = `我的${domain.label}是${domain.word}。`;
  return [
    { category: 'save', input: `请记住，${ordinary}` },
    { category: 'explicit', input: `从现在起，我的${domain.label}改成${domain.word}。` },
    { category: 'conflict', input: ordinary },
    { category: 'scene', input: `在「休息日」场景，${ordinary}`, seedScene: '工作日早餐', scene: '休息日' },
    { category: 'thread', input: `仅在当前对话里，${ordinary}` },
    { category: 'non_authorizing', input: domain.prefix === 'ED'
      ? `下个月我的${domain.label}改成${domain.word}。` : `不要把我的${domain.label}改成${domain.word}。` },
  ].map((test, index) => Object.freeze({ ...domain, ...test, id: `${domain.prefix}${String(index + 1).padStart(2, '0')}` }));
}));
const hash = value => createHash('sha256').update(value).digest('hex');
const checked = result => {
  if (!result.ok) throw Object.assign(new Error('State unavailable'), { code: 'EVIDENCE_READ_FAILED' });
  return result.value ?? result.entries;
};
const identity = item => item.assertion?.factIdentity ?? item.change?.factIdentity;
const sources = item => item.sources ?? (item.source ? [item.source] : []);
const active = item => item.enabled === true && item.status === 'active' && item.temporalState === 'applicable';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const factIdentity = (test, value, scenario = 'general') => ({ version: 2, subject: 'user', attribute: test.attribute, scenario, value });

/** Store state and production-selector output decide pass, never model completion claims. */
export function scoreEveryday(test, evidence) {
  const failures = [], require = (condition, code) => { if (!condition) failures.push(code); };
  const before = evidence.before ?? {}, after = evidence.after ?? {};
  const formal = after.formal ?? [], pending = (after.pending ?? []).filter(item => item.status === 'pending');
  const old = before.formal?.find(item => item.id === evidence.seedId);
  const current = formal.find(item => item.id === evidence.seedId);
  const scope = test.category === 'thread' ? { kind: 'thread', threadId: evidence.threadId } : { kind: 'workspace' };
  const scenario = test.scene ?? 'general';
  const correct = item => {
    const text = String(item.text ?? item.change?.text ?? '').toLowerCase();
    return equal(identity(item), factIdentity(test, test.value, scenario)) && text.includes(test.label)
      && text.includes(test.word.toLowerCase()) && !text.includes(test.oldWord.toLowerCase())
      && (scenario === 'general' || text.includes(scenario));
  };
  const isSource = source => source?.kind === 'conversation' && source.threadId === evidence.threadId
    && source.messageId === evidence.userMessageId && typeof source.quote === 'string' && source.quote.length > 0 && test.input.includes(source.quote);
  const newFacts = formal.filter(item => item.id !== evidence.seedId);
  require(!evidence.environmentFailure && !evidence.readErrors?.length && !before.readErrors?.length && !after.readErrors?.length, 'state_or_environment_error');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.phases?.primary === 'completed' && evidence.phases?.consolidation === 'completed', 'run_not_completed');
  require(evidence.requests?.length === 2 && ['primary', 'consolidation'].every(phase =>
    evidence.requests.filter(row => row.phase === phase && row.dispatched && !row.blocked && row.modelId === transitionModel.modelId).length === 1), 'request_count_or_retry');
  require(typeof evidence.userMessageId === 'string' && evidence.userMessageId.length > 0, 'source_message_missing');
  require(newFacts.every(item => sources(item).length > 0 && sources(item).every(isSource)), 'formal_source_invalid');
  require(pending.every(item => sources(item).length > 0 && sources(item).every(isSource)), 'pending_source_invalid');
  if (['save', 'thread', 'scene'].includes(test.category)) {
    require(newFacts.length === 1 && active(newFacts[0]) && correct(newFacts[0]) && equal(newFacts[0].scope, scope), 'new_fact_not_saved');
    require(pending.length === 0, 'save_still_pending');
    if (test.category === 'scene') require(!!old && !!current && current.text === old.text
      && equal(identity(current), identity(old)) && equal(current.scope, old.scope) && active(current), 'old_scene_changed');
    else require((before.formal?.length ?? 0) === 0 && formal.length === 1, 'unexpected_seed_or_duplicate');
    if (test.category === 'thread') {
      const savedId = newFacts[0]?.id;
      require(!!savedId && after.ownerReferenceIds?.includes(savedId) && !after.foreignReferenceIds?.includes(savedId), 'thread_reference_leak_or_missing');
    }
  } else {
    require(!!old && !!current && equal(current.scope, old.scope), 'seed_missing_or_scope_changed');
    require(newFacts.length === 0, 'unauthorized_new_fact');
    if (test.category === 'explicit') {
      require(active(current ?? {}) && current?.revision === old?.revision + 1 && correct(current ?? {}), 'explicit_not_updated');
      require(current?.source?.quote === test.input && isSource(current?.source), 'change_source_not_complete');
      require(pending.length === 0, 'explicit_still_pending');
      require(after.seedHistory?.assertions?.some(item => item.text === old?.text)
        && after.seedHistory.assertions.some(item => equal(item.factIdentity, factIdentity(test, test.value))), 'old_history_missing');
    } else {
      require(active(current ?? {}) && current?.text === old?.text && equal(identity(current ?? {}), identity(old ?? {})), 'old_fact_changed');
      if (test.category === 'conflict') require(pending.some(item => {
        const change = item.change;
        return !item.staleReason && correct(item) && typeof change?.text === 'string' && change.text.trim().length > 0
          && equal(change.scope ?? old?.scope, old?.scope)
          && (change.operation === 'add' || ['correct', 'change'].includes(change.operation)
            && change.memoryId === evidence.seedId && change.expectedRevision === current?.revision);
      }), 'conflict_not_actionable');
    }
  }
  return { version: everydayOracleVersion, passed: failures.length === 0, failures };
}

async function capture(workspace, store, threadId, test, seedId) {
  let raw = null;
  try { raw = JSON.parse(await readFile(join(workspace, '.runloom/memory.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const formal = checked(await store.list());
  const reference = id => retrieveMemories(formal, { query: test.label, now: new Date(), threadId: id }).entries.map(item => item.id);
  return { raw, formal, readErrors: [], capturedAt: new Date().toISOString(),
    pending: checked(await store.listCandidates({ status: 'pending' }, undefined, { boundThreadId: threadId })).candidates,
    seedHistory: seedId ? checked(await store.inspectMemory(seedId)) : null,
    ownerReferenceIds: reference(threadId), foreignReferenceIds: reference(`${threadId}-foreign`) };
}

async function executeCase(test, root, env, deadlineMs) {
  const directory = join(root, test.id), workspace = join(directory, 'workspace'), threadId = `everyday-${test.id}`;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const store = createMemoryStore(workspace);
  let seedId = null;
  if (!['save', 'thread'].includes(test.category)) {
    const body = `我的${test.label}是${test.oldWord}。`;
    const seeded = await store.add({ text: test.seedScene ? `在「${test.seedScene}」场景，${body}` : body,
      kind: 'preference', factIdentity: factIdentity(test, test.oldValue, test.seedScene ?? 'general') }, undefined, { now: new Date(Date.now() - 60_000) });
    checked(seeded); seedId = seeded.entry.id;
  }
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, workspace, run: { maxSteps: 2, totalTimeoutMs: 120_000 }, modules: {
    memory: { enabled: true, autoConsolidate: true, writePolicy: 'automatic', queryRewrite: { enabled: false }, semantic: { enabled: false } },
    task: { enabled: false }, web: { enabled: false }, shell: { enabled: false }, 'read-file': { enabled: false },
  } }), { mode: 0o600 });
  const transport = createTransitionFetch(), selected = configureCliModel(() => { throw Error('Mocks not allowed'); }, env, { fetch: transport.fetch });
  const output = new PassThrough(), phaseResults = [];
  let app, controller, deadline;
  const evidence = { caseId: test.id, category: test.category, expected: test, threadId, seedId,
    userMessageId: null, phaseResults, before: await capture(workspace, store, threadId, test, seedId) };
  output.on('data', chunk => controller?.recordOutput(chunk.toString()));
  try {
    app = await createRuntimeApp({ args: ['--tui', join(directory, 'transcripts'), '--thread', threadId, '--config', config], ...selected, output, env, cwd: directory });
    controller = createAssistantController(app);
    controller.subscribe(event => {
      if (event.type === 'approval') controller.confirm({ approvalId: event.approval.approvalId, decision: 'deny' });
      if (event.type === 'run-result') phaseResults.push({ phase: event.phase, status: event.result.status,
        runId: event.result.runId, text: event.result.status === 'completed' ? event.result.text : null });
    });
    const run = async () => {
      await controller.listRuns();
      while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
      const admission = await controller.run(test.input);
      if (!admission.ok) throw Object.assign(new Error('Admission failed'), { code: 'ADMISSION_FAILED' });
      evidence.primaryRunId = admission.runId;
      while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
    };
    await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => {
      void controller.cancel(); reject(Object.assign(new Error('Deadline'), { code: 'EVAL_DEADLINE' }));
    }, deadlineMs); })]);
  } catch (cause) { evidence.environmentFailure = transitionSafeError(cause); }
  finally {
    clearTimeout(deadline);
    const retain = async (field, operation) => {
      try { evidence[field] = await operation(); }
      catch (cause) { (evidence.readErrors ??= []).push({ field, ...transitionSafeError(cause) }); evidence.environmentFailure ??= transitionSafeError({ code: 'EVIDENCE_READ_FAILED' }); }
    };
    if (controller) {
      const snapshot = controller.getSnapshot();
      evidence.phases = { primary: snapshot.lastPrimaryResult?.status ?? null, consolidation: snapshot.lastConsolidationResult?.status ?? null };
      await retain('userMessageId', async () => (await controller.getHistory()).findLast(message => message.role === 'user'
        && message.parts.some(part => part.type === 'text' && part.text === test.input))?.id ?? null);
      await retain('receipts', async () => checked(await controller.getMemoryReceipts()));
      await retain('usage', () => app.executionRecords.listModelUsage(threadId));
      evidence.modelVerified = (evidence.usage?.calls.length ?? 0) >= 1 && evidence.usage.droppedCount === 0
        && evidence.usage.calls.every(call => call.modelId === transitionModel.modelId);
      if (!evidence.modelVerified) evidence.environmentFailure ??= transitionSafeError({ code: 'MODEL_MISMATCH' });
      await retain('shutdownComplete', async () => { await controller.shutdown(); return true; });
    }
    await retain('after', () => capture(workspace, store, threadId, test, seedId));
    evidence.requests = transport.requests;
    if (transport.requests.some(row => row.transportFailure || row.httpStatus >= 400)) evidence.environmentFailure ??= transitionSafeError({});
    evidence.oracle = scoreEveryday(test, evidence);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  return evidence;
}

export function summarizeEveryday(rows) {
  const group = tests => { const ids = new Set(tests.map(test => test.id)), executed = rows.filter(row => ids.has(row.caseId));
    const passed = executed.filter(row => row.oracle?.passed && !row.environmentFailure).length;
    return { planned: tests.length, executed: executed.length, unexecuted: tests.length - executed.length, passed, passRateOfPlanned: passed / tests.length }; };
  const total = group(everydayCases);
  return { status: rows.some(row => row.environmentFailure) ? 'environment_failed' : total.unexecuted ? 'incomplete'
    : total.passed === total.planned ? 'completed_pass' : 'completed_with_failures', ...total,
    domains: Object.fromEntries(domains.map(domain => [domain.attribute, group(everydayCases.filter(test => test.attribute === domain.attribute))])),
    failures: rows.filter(row => !row.oracle?.passed || row.environmentFailure).map(row => ({ caseId: row.caseId,
      failures: row.oracle?.failures ?? [], environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemoryEveryday({ live = false, env = process.env, outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results'), deadlineMs = 180_000 } = {}) {
  if (!live) throw Error('Explicit --live is required; fixture tests are not model quality data.');
  if (!env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(new Error('Protected COMMAND_CODE_API_KEY required'), { code: 'CONFIGURATION_FAILED' });
  const fixedEnv = { ...env, RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: transitionModel.modelId, COMMAND_CODE_BASE_URL: transitionModel.baseURL };
  const requested = join(resolve(outputRoot), `memory-everyday-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const root = await realpath(requested), source = await readFile(fileURLToPath(import.meta.url));
  const dependencySource = await readFile(new URL('./memory-transition-acceptance.mjs', import.meta.url));
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* exported source */ }
  const runtimeHashes = Object.fromEntries(await Promise.all(['app', 'assistant-controller', 'memory-consolidation', 'memory-observation-policy', 'memory-fact-identity', 'memory-store', 'memory-retrieval', 'model-config'].map(async name =>
    [name, hash(await readFile(new URL(`../cli/dist/${name}.js`, import.meta.url)))])));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ suite: 'memory-everyday-v1', source: '我的 eval',
    kind: 'real-model-controller-consolidation-isolated', datasetRole: 'developer-authored canonical vocabulary; not blind held-out',
    oracleVersion: everydayOracleVersion, model: transitionModel, requestedModelId: transitionModel.modelId,
    planned: 12, repeat: 1, caseIds: everydayCases.map(test => test.id), maxHttpRequests: 24, maxDispatchPerPhase: 1, retry: false,
    gitCommit, runtimeHashes, runtimeFingerprint: hash(JSON.stringify(runtimeHashes)), evalFingerprint: hash(Buffer.concat([source, dependencySource])),
    deadlineMs, corpus: 'isolated synthetic diet/channel preferences; no daily data',
    scopeEvidence: 'production retrieval selector owner/foreign views after persistence; not a second chat Run or real TG',
    modelVerification: 'SDK modelId usage boundary, not independent provider attestation' }, null, 2), { mode: 0o600 });
  await writeFile(join(root, 'frozen-eval.mjs'), source, { mode: 0o600 });
  await writeFile(join(root, 'frozen-transition-dependency.mjs'), dependencySource, { mode: 0o600 });
  const rows = [];
  for (const test of everydayCases) {
    try { rows.push(await executeCase(test, root, fixedEnv, deadlineMs)); }
    catch (cause) { const row = { caseId: test.id, environmentFailure: transitionSafeError(cause) }; rows.push(row);
      await mkdir(join(root, test.id), { recursive: true, mode: 0o700 });
      await writeFile(join(root, test.id, 'failure.json'), JSON.stringify(row, null, 2), { mode: 0o600 }); }
    await writeFile(join(root, 'summary.json'), JSON.stringify(summarizeEveryday(rows), null, 2), { mode: 0o600 });
    if (rows.at(-1).environmentFailure) break;
  }
  return { report: root, ...summarizeEveryday(rows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--live')) throw Error('Unknown argument');
    const result = await runMemoryEveryday({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2)); if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
