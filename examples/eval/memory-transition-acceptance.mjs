import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeApp } from '@serika/assistant/internal/app.js';
import { createAssistantController } from '@serika/assistant/internal/assistant-controller.js';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';
import { createMemoryStore } from '@serika/assistant/internal/memory-store.js';

export const transitionModel = Object.freeze({ alias: 'command-code/default', modelId: 'deepseek/deepseek-v4.1-flash-fast',
  baseURL: 'https://api.commandcode.ai/provider/v1' });
export const transitionOracleVersion = 'memory-transition-oracle-v3';
const spec = (id, category, input, extra = {}) => ({ id, category, input, ...extra });
// Frozen developer-authored regression set, not blind held-out evaluation.
export const transitionCases = Object.freeze([
  spec('MT01', 'explicit', '从现在起，我喝咖啡改成加糖。'),
  spec('MT02', 'explicit', '请把我的咖啡偏好改为加糖。'),
  spec('MT03', 'thread', '从现在起，仅在当前对话里，我的咖啡改成加糖。', { thread: true }),
  spec('MT04', 'thread', '仅当前对话有效，从现在起，我的咖啡改成加糖。', { thread: true }),
  spec('MT05', 'conflict', '我喝咖啡加糖。'),
  spec('MT06', 'conflict', '我喜欢喝加糖咖啡。'),
  spec('MT07', 'scene', '休息日我喝咖啡加糖，工作时依旧不加糖。', { scenario: 'work' }),
  spec('MT08', 'scene', '私人场景我喝咖啡加糖，工作时依旧不加糖。', { scenario: 'work' }),
  spec('MT09', 'non_authorizing', '如果从现在起我喝咖啡改成加糖，就好了。'),
  spec('MT10', 'non_authorizing', '从现在起，我的朋友喝咖啡改成加糖。'),
  spec('MT11', 'future', '我打算下个月喝咖啡改成加糖，现在依旧不加糖。'),
  spec('MT12', 'future', '以后，我可能喝咖啡改成加糖，但现在还没决定。'),
].map(Object.freeze));
const hash = value => createHash('sha256').update(value).digest('hex');
const checked = result => {
  if (!result.ok) throw Object.assign(new Error('Fixture state could not be read'), { code: 'EVIDENCE_READ_FAILED' });
  return result.value ?? result.entries;
};
const active = entry => entry.enabled && entry.status === 'active' && entry.temporalState === 'applicable';
const identity = entry => entry.assertion?.factIdentity ?? entry.change?.factIdentity;
const sources = item => item.sources ?? (item.source ? [item.source] : []);

/** Do not serialize arbitrary provider exception messages, headers, response bodies or credentials. */
export function transitionSafeError(cause) {
  const allowed = ['EVAL_DEADLINE', 'EVIDENCE_READ_FAILED', 'MODEL_MISMATCH', 'FIXTURE_APPROVAL_DENIED', 'ADMISSION_FAILED', 'CONFIGURATION_FAILED'];
  return { code: allowed.includes(cause?.code) ? cause.code : 'EVAL_ENVIRONMENT_FAILED',
    message: 'Execution infrastructure failed; inspect bounded run statuses and usage. Raw exception text was not retained.' };
}

/** Product retry behavior is unchanged; this eval permits only one HTTP dispatch per phase. */
export function createTransitionFetch(fetchImpl = fetch) {
  const requests = [], counts = { primary: 0, consolidation: 0 };
  const controlledFetch = async (url, options) => {
    let body;
    try { body = JSON.parse(options?.body); } catch { throw Error('Eval request body unavailable'); }
    const material = body.messages?.some(message => {
      const content = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
      return content.some(text => typeof text === 'string' && text.startsWith('Extract only from this host-prepared material.'));
    });
    const phase = material ? 'consolidation' : 'primary';
    const row = { phase, modelId: body.model, submittedAt: new Date().toISOString(), dispatched: false, blocked: false };
    requests.push(row);
    if (body.model !== transitionModel.modelId || counts[phase] >= 1) {
      row.blocked = true;
      throw Error('Eval refused model mismatch or repeated phase dispatch');
    }
    counts[phase] += 1;
    row.dispatched = true;
    // Never retain request headers, body, authorization or provider error text.
    try {
      const response = await fetchImpl(url, options);
      row.httpStatus = response.status;
      return response;
    } catch (cause) { row.transportFailure = true; throw cause; }
  };
  return { fetch: controlledFetch, requests };
}

/** Oracle reads persisted state only; model claims and final reply never determine pass. */
export function scoreTransition(test, evidence) {
  const failures = [];
  const require = (condition, code) => { if (!condition) failures.push(code); };
  const { before, after, seedId, userMessageId, threadId } = evidence;
  require(!before.readErrors?.length && !after.readErrors?.length, 'state_read_error');
  const old = before.formal.find(entry => entry.id === seedId);
  const current = after.formal.find(entry => entry.id === seedId);
  const isNewSource = source => source?.kind === 'conversation' && source.threadId === threadId && source.messageId === userMessageId
    && typeof source.quote === 'string' && source.quote.length > 0 && test.input.includes(source.quote);
  const scoped = item => {
    const scope = item.change?.scope ?? item.scope ?? old?.scope;
    return JSON.stringify(scope) === JSON.stringify(old?.scope);
  };
  const newFormal = after.formal.filter(entry => active(entry) && identity(entry)?.value === 'sweetened');
  const pending = after.pending.filter(entry => entry.status === 'pending');
  require(evidence.phases.primary === 'completed' && evidence.phases.consolidation === 'completed', 'run_not_completed');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.requests?.length === 2 && evidence.requests.every(request => request.dispatched && !request.blocked)
    && ['primary', 'consolidation'].every(phase => evidence.requests.filter(request => request.phase === phase).length === 1), 'request_count_or_retry');
  require(!!old && !!current, 'seed_missing');
  require(typeof userMessageId === 'string' && userMessageId.length > 0, 'user_source_missing');
  require(after.formal.every(entry => entry.id === seedId || sources(entry).every(isNewSource) && sources(entry).length > 0), 'formal_source_invalid');
  require(pending.every(entry => sources(entry).length > 0 && sources(entry).every(isNewSource)), 'pending_source_invalid');
  if (['explicit', 'thread'].includes(test.category)) {
    require(current?.revision === old?.revision + 1 && active(current) && identity(current)?.value === 'sweetened', 'explicit_not_updated');
    require(identity(current)?.scenario === identity(old)?.scenario && scoped(current), 'scope_or_scene_changed');
    require(current?.source?.quote === test.input && isNewSource(current?.source), 'change_source_not_complete');
    require(pending.length === 0, 'explicit_still_pending');
    require(after.formal.length === before.formal.length, 'duplicate_fact');
  } else {
    // Source reinforcement may legitimately increment the old revision.
    require(active(current) && current?.text === old?.text && identity(current)?.value === 'unsweetened'
      && identity(current)?.scenario === identity(old)?.scenario && scoped(current), 'old_fact_changed');
    require(newFormal.every(entry => test.category === 'scene' && identity(entry)?.scenario !== identity(old)?.scenario
      && identity(entry)?.scenario !== 'general' && scoped(entry)), 'unauthorized_current_fact');
    if (['non_authorizing', 'future'].includes(test.category)) {
      require(!after.formal.some(entry => entry.id !== seedId && active(entry)), 'unauthorized_new_active_fact');
    }
    if (test.category === 'conflict') {
      require(!after.formal.some(entry => entry.id !== seedId && active(entry)), 'unauthorized_new_active_fact');
      require(pending.some(entry => {
        const change = entry.change;
        return !entry.staleReason && identity(entry)?.value === 'sweetened'
          && identity(entry)?.attribute === identity(old)?.attribute
          && identity(entry)?.scenario === identity(old)?.scenario && scoped(entry)
          && typeof change?.text === 'string' && change.text.trim().length > 0
          && (change.operation === 'add' || ['correct', 'change'].includes(change.operation)
            && change.memoryId === seedId && change.expectedRevision === current?.revision);
      }), 'conflict_not_actionable');
    }
    if (test.category === 'scene') {
      const identified = [...newFormal, ...pending].some(entry => identity(entry)?.value === 'sweetened'
        && identity(entry)?.scenario && !['general', identity(old)?.scenario].includes(identity(entry).scenario)
        && (active(entry) || entry.status === 'pending' && !entry.staleReason && entry.change?.operation === 'add' && scoped(entry)));
      // A safe pending add may intentionally have no factIdentity: mixed-scene
      // source ambiguity must not make its independently reviewable body vanish.
      // These are fixture-owned scene/value checks, not product extraction code.
      const scene = test.id === 'MT07' ? /休息日|休息时|休息的时候/ : /私人场景|个人场景|生活场景/;
      const review = pending.some(entry => entry.change?.operation === 'add' && !entry.staleReason && scoped(entry)
        && !identity(entry) && String(entry.change.text).split(/[，,。；;\n]/).some(clause => scene.test(clause)
          && /咖啡.{0,8}加糖/.test(clause) && !/不加糖|没加糖|未加糖|如果|可能|朋友|他|她/.test(clause)));
      require(identified || review, 'new_scene_not_actionable');
    }
  }
  return { version: transitionOracleVersion, passed: failures.length === 0, failures };
}

async function capture(workspace, store, threadId) {
  return { capturedAt: new Date().toISOString(), readErrors: [],
    raw: JSON.parse(await readFile(join(workspace, '.runloom/memory.json'), 'utf8')),
    formal: checked(await store.list()),
    pending: checked(await store.listCandidates({ status: 'pending' }, undefined, { boundThreadId: threadId })).candidates,
    material: checked(await store.listConsolidationMaterial(undefined, { boundThreadId: threadId })) };
}

async function executeCase(test, root, env, deadlineMs) {
  const directory = join(root, test.id), workspace = join(directory, 'workspace'), threadId = `transition-${test.id}`;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const scope = test.thread ? { kind: 'thread', threadId } : { kind: 'workspace' };
  const store = createMemoryStore(workspace);
  const seeded = await store.add({ text: test.scenario === 'work' ? '工作时我喝咖啡不加糖。' : '我喝咖啡不加糖。',
    kind: 'preference', scope, factIdentity: { attribute: 'coffee', scenario: test.scenario ?? 'general', value: 'unsweetened' } },
  undefined, { now: new Date(Date.now() - 60_000) });
  if (!seeded.ok) throw Object.assign(new Error('Seed failed'), { code: 'EVIDENCE_READ_FAILED' });
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, workspace, run: { maxSteps: 2, totalTimeoutMs: 120_000 }, modules: {
    memory: { enabled: true, autoConsolidate: true, writePolicy: 'automatic', queryRewrite: { enabled: false }, semantic: { enabled: false } },
    task: { enabled: false }, web: { enabled: false }, shell: { enabled: false }, 'read-file': { enabled: false },
  } }), { mode: 0o600 });
  const transport = createTransitionFetch();
  const selected = configureCliModel(() => { throw Error('Mocks not allowed'); }, env, { fetch: transport.fetch });
  const output = new PassThrough();
  let controller, app, evidence = { caseId: test.id, category: test.category, expected: test,
    threadId, seedId: seeded.entry.id, userMessageId: null, phases: {}, before: await capture(workspace, store, threadId) };
  output.on('data', chunk => controller?.recordOutput(chunk.toString()));
  const phaseResults = [];
  evidence.phaseResults = phaseResults;
  let deadline;
  try {
    app = await createRuntimeApp({ args: ['--tui', join(directory, 'transcripts'), '--thread', threadId, '--config', config],
      ...selected, output, env, cwd: directory });
    controller = createAssistantController(app);
    controller.subscribe(event => {
      if (event.type === 'approval') controller.confirm({ approvalId: event.approval.approvalId, decision: 'deny' });
      if (event.type === 'run-result') phaseResults.push({ phase: event.phase, status: event.result.status,
        runId: event.result.runId, text: event.result.status === 'completed' ? event.result.text : null });
    });
    const task = async () => {
      await controller.listRuns();
      while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
      const admission = await controller.run(test.input);
      if (!admission.ok) throw Object.assign(new Error('Admission failed'), { code: 'ADMISSION_FAILED' });
      evidence.primaryRunId = admission.runId;
      while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
    };
    await Promise.race([task(), new Promise((_, reject) => {
      deadline = setTimeout(() => { void controller.cancel(); reject(Object.assign(new Error('Deadline'), { code: 'EVAL_DEADLINE' })); }, deadlineMs);
    })]);
  } catch (cause) { evidence.environmentFailure = transitionSafeError(cause); }
  finally {
    clearTimeout(deadline);
    const retain = async (field, operation) => {
      try { evidence[field] = await operation(); }
      catch (cause) {
        (evidence.readErrors ??= []).push({ field, ...transitionSafeError(cause) });
        evidence.environmentFailure ??= transitionSafeError({ code: 'EVIDENCE_READ_FAILED' });
      }
    };
    if (controller) {
      const snapshot = controller.getSnapshot();
      evidence.phases = { primary: snapshot.lastPrimaryResult?.status ?? null, consolidation: snapshot.lastConsolidationResult?.status ?? null };
      evidence.consolidationRawText = phaseResults.findLast(result => result.phase === 'consolidation')?.text ?? null;
      await retain('userMessageId', async () => (await controller.getHistory()).findLast(message => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.text === test.input))?.id ?? null);
      await retain('receipts', async () => checked(await controller.getMemoryReceipts()));
      await retain('usage', () => app.executionRecords.listModelUsage(threadId));
      await retain('runs', async () => Promise.all((await controller.listRuns(50)).map(async row => {
        const run = await controller.getRun(row.runId);
        return { runId: run.runId, phase: run.phase, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
          tools: run.tools.map(tool => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, status: tool.status })) };
      })));
      evidence.modelVerified = (evidence.usage?.calls.length ?? 0) >= 1 && evidence.usage.droppedCount === 0
        && evidence.usage.calls.every(call => call.modelId === transitionModel.modelId);
      if (!evidence.modelVerified) evidence.environmentFailure ??= transitionSafeError({ code: 'MODEL_MISMATCH' });
      await retain('shutdownComplete', async () => { await controller.shutdown(); return true; });
    }
    await retain('after', () => capture(workspace, store, threadId));
    evidence.after ??= { formal: [], pending: [], readErrors: ['capture_failed'] };
    evidence.requests = transport.requests;
    if (transport.requests.some(request => request.transportFailure || request.httpStatus >= 400)) evidence.environmentFailure ??= transitionSafeError({});
    evidence.oracle = scoreTransition(test, evidence);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  return evidence;
}

export function summarizeTransitions(rows, planned = transitionCases.length) {
  const passed = rows.filter(row => row.oracle?.passed && !row.environmentFailure).length;
  return { status: rows.some(row => row.environmentFailure) ? 'environment_failed' : rows.length < planned ? 'incomplete'
    : passed === planned ? 'completed_pass' : 'completed_with_failures', planned, executed: rows.length,
  unexecuted: planned - rows.length, passed, passRateOfPlanned: passed / planned,
  categories: Object.fromEntries([...new Set(transitionCases.map(test => test.category))].map(category => {
    const selected = rows.filter(row => row.category === category), total = transitionCases.filter(test => test.category === category).length;
    return [category, { passed: selected.filter(row => row.oracle?.passed && !row.environmentFailure).length, executed: selected.length, planned: total }];
  })), failures: rows.filter(row => !row.oracle?.passed || row.environmentFailure).map(row => ({ caseId: row.caseId,
    failures: row.oracle?.failures ?? [], environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemoryTransitions({ live = false, env = process.env, outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results'), deadlineMs = 180_000 } = {}) {
  if (!live) throw Error('Explicit --live is required; no mock scores are generated.');
  if (!env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(new Error('Configure COMMAND_CODE_API_KEY in the protected environment, never in chat.'), { code: 'CONFIGURATION_FAILED' });
  const fixedEnv = { ...env, RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: transitionModel.modelId, COMMAND_CODE_BASE_URL: transitionModel.baseURL };
  const requested = join(resolve(outputRoot), `memory-transition-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const root = await realpath(requested), source = await readFile(fileURLToPath(import.meta.url));
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* export */ }
  const runtimeHashes = Object.fromEntries(await Promise.all(['app', 'assistant-controller', 'memory-consolidation', 'memory-store', 'model-config'].map(async name =>
    [name, hash(await readFile(new URL(`../../packages/assistant/dist/${name}.js`, import.meta.url)))])));
  const manifest = { suite: 'memory-transition-v1', source: '我的 eval', kind: 'real-model-controller-consolidation-isolated',
    oracleVersion: transitionOracleVersion,
    datasetRole: 'developer-authored regression; not blind held-out', model: transitionModel, requestedModelId: transitionModel.modelId,
    gitCommit, runtimeHashes, runtimeFingerprint: hash(JSON.stringify(runtimeHashes)), evalFingerprint: hash(source),
    planned: transitionCases.length, caseIds: transitionCases.map(test => test.id), repeat: 1,
    retry: 'Product bounded retries unchanged; eval blocks second HTTP dispatch in each phase and fails the case.', deadlineMs,
    corpus: 'isolated synthetic coffee facts only; no daily data', modelVerification: 'SDK modelId usage boundary, not independent provider attestation' };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(root, 'frozen-eval.mjs'), source, { mode: 0o600 });
  const rows = [];
  for (const test of transitionCases) {
    try { rows.push(await executeCase(test, root, fixedEnv, deadlineMs)); }
    catch (cause) {
      const failure = { caseId: test.id, category: test.category, environmentFailure: transitionSafeError(cause) };
      rows.push(failure);
      await writeFile(join(root, test.id, 'failure.json'), JSON.stringify(failure, null, 2), { mode: 0o600 });
    }
    await writeFile(join(root, 'summary.json'), JSON.stringify(summarizeTransitions(rows), null, 2), { mode: 0o600 });
    if (rows.at(-1).environmentFailure) break;
  }
  return { report: root, ...summarizeTransitions(rows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMemoryTransitions({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
