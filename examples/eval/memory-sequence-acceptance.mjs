import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeApp } from '@serika/example-cli/dist/app.js';
import { createAssistantController } from '@serika/example-cli/dist/assistant-controller.js';
import { configureCliModel } from '@serika/example-cli/dist/model-config.js';
import { createMemoryStore } from '@serika/example-cli/dist/memory-store.js';
import { createTransitionFetch, transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

export const sequenceCases = Object.freeze([
  { id: 'MS01', input: '【升级验收1015A】仅在当前对话里，请记住：我喝咖啡不加糖。', value: 'unsweetened' },
  { id: 'MS02', input: '从现在起，仅在当前对话里，我喝咖啡改成加糖。', value: 'sweetened' },
  { id: 'MS03', input: '仅在当前对话里，我喝咖啡不加糖。', value: 'sweetened' },
].map(Object.freeze));
export const sequenceOracleVersion = 'memory-sequence-oracle-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const checked = result => {
  if (!result.ok) throw Object.assign(Error('Read unavailable'), { code: 'EVIDENCE_READ_FAILED' });
  return result.value ?? result.entries;
};
const identity = item => item.assertion?.factIdentity ?? item.change?.factIdentity;
const active = item => item.enabled && item.status === 'active' && item.temporalState === 'applicable';
const scopeMatches = (item, threadId) => item.scope?.kind === 'thread' && item.scope.threadId === threadId;

/** Exact fragments of the observed false reply, NOT a semantic truthfulness judge.
 * No fuzzy persistence regex and no assumption that other wording is truthful.
 */
export function hasSequenceFalsePersistenceClaim(text) {
  return ['明白，当前对话里再改回：', '（「加糖」那版作废）'].some(fragment => String(text).includes(fragment));
}

/** Pure oracle: a scripted fixture can test this logic but is never live semantic evidence. */
export function scoreSequenceRound(index, evidence, previous = []) {
  const failures = [], require = (condition, code) => { if (!condition) failures.push(code); };
  const test = sequenceCases[index], { before, after, threadId, userMessageId } = evidence;
  const expectedRevision = index === 0 ? 1 : 2;
  const old = previous[0]?.after.formal[0];
  const fact = after.formal[0];
  require(!evidence.environmentFailure && !evidence.readErrors?.length && !before.readErrors?.length && !after.readErrors?.length, 'evidence_unavailable');
  require(evidence.phases.primary === 'completed' && evidence.phases.consolidation === 'completed', 'run_not_completed');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.requests.length === 2 && evidence.requests.every(row => row.dispatched && !row.blocked && row.httpStatus === 200 && row.modelId === transitionModel.modelId)
    && ['primary', 'consolidation'].every(phase => evidence.requests.filter(row => row.phase === phase).length === 1), 'request_boundary');
  require(typeof userMessageId === 'string' && userMessageId.length > 0, 'missing_source');
  require(after.formal.length === 1 && active(fact) && scopeMatches(fact, threadId)
    && identity(fact)?.attribute === 'coffee' && identity(fact)?.scenario === 'general'
    && identity(fact)?.value === test.value && fact?.revision === expectedRevision, 'formal_state_invalid');
  require(index === 0 ? before.formal.length === 0 : old && fact?.id === old.id, 'identity_or_initial_state');
  const boundSource = source => source?.kind === 'conversation' && source.threadId === threadId
    && source.messageId === userMessageId && source.quote === test.input;
  const currentReceipts = evidence.receipts?.filter(row => row.sourceMessageId === userMessageId && row.threadId === threadId) ?? [];
  require(currentReceipts.length === 1, 'receipt_missing_or_duplicated');
  const receipt = currentReceipts[0]?.text ?? '';
  if (index < 2) {
    require(after.pending.length === 0, 'unexpected_pending');
    require(boundSource(fact?.source), 'formal_source_incomplete');
    require(index === 0 ? /当时已保存/.test(receipt) : /当时已更新/.test(receipt), 'receipt_not_persisted_success');
    const raw = after.raw?.entries?.find(row => row.id === fact?.id);
    require(raw?.versions?.some(version => version.revision === 1), 'initial_version_lost');
    if (index === 1) require(raw?.assertions?.some(assertion => assertion.factIdentity?.value === 'unsweetened'
      && assertion.validTime.to !== null) && raw.versions.some(version => version.revision === 2), 'old_timeline_lost');
  } else {
    require(JSON.stringify(after.formal) === JSON.stringify(before.formal), 'ordinary_conflict_mutated_formal');
    const applicable = after.pending.filter(candidate => candidate.status === 'pending' && !candidate.staleReason
      && identity(candidate)?.attribute === 'coffee' && identity(candidate)?.scenario === 'general'
      && identity(candidate)?.value === 'unsweetened' && candidate.originThreadId === threadId
      && ['correct', 'change'].includes(candidate.change?.operation) && candidate.change.memoryId === fact?.id
      && candidate.change.expectedRevision === fact?.revision
      && (candidate.sources ?? [candidate.source]).some(boundSource)
      && after.previews?.some(preview => preview.candidate.id === candidate.id && preview.applicable === true));
    require(after.pending.length === 1 && applicable.length === 1, 'conflict_not_actionable');
    require(/记忆需要你确认/.test(receipt) && !/当时已(?:保存|更新)|暂时不能确认/.test(receipt), 'receipt_falsely_claims_success');
    require(JSON.stringify(after.raw?.entries) === JSON.stringify(before.raw?.entries), 'history_changed_or_revived');
    const primaryText = evidence.phaseResults?.findLast(row => row.phase === 'primary')?.text;
    require(typeof primaryText === 'string' && !hasSequenceFalsePersistenceClaim(primaryText), 'primary_false_persistence_claim');
  }
  return { version: sequenceOracleVersion, passed: failures.length === 0, failures };
}

async function capture(workspace, store, threadId) {
  let raw = null;
  try { raw = JSON.parse(await readFile(join(workspace, '.runloom/memory.json'), 'utf8')); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const pending = checked(await store.listCandidates({ status: 'pending' }, undefined, { boundThreadId: threadId })).candidates;
  return { raw, readErrors: [], formal: checked(await store.list()), pending,
    previews: await Promise.all(pending.map(async candidate => checked(await store.getCandidate(candidate.id, undefined, { boundThreadId: threadId })))) };
}

export function summarizeSequence(rows) {
  const passed = rows.filter(row => row.oracle?.passed && !row.environmentFailure).length;
  return { planned: 3, executed: rows.length, unexecuted: 3 - rows.length, passed, failed: rows.filter(row => !row.oracle?.passed).length,
    environmentFailures: rows.filter(row => row.environmentFailure).length, passRateOfPlanned: passed / 3,
    status: rows.some(row => row.environmentFailure) ? 'environment_failed' : rows.length < 3 ? 'incomplete' : passed === 3 ? 'completed_pass' : 'completed_with_failures',
    failures: rows.filter(row => !row.oracle?.passed).map(row => ({ caseId: row.caseId, failures: row.oracle?.failures, environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemorySequence({ live = false, env = process.env, outputRoot = join(dirname(fileURLToPath(import.meta.url)), 'results'), deadlineMs = 180_000 } = {}) {
  if (!live || !env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(Error('Explicit live and protected credentials required'), { code: 'CONFIGURATION_FAILED' });
  const root = resolve(outputRoot, `memory-sequence-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  const workspace = join(root, 'workspace'), threadId = `sequence-${randomUUID()}`, config = join(root, 'config.json');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ version: 1, workspace, run: { maxSteps: 2, totalTimeoutMs: 120_000 }, modules: {
    memory: { enabled: true, autoConsolidate: true, writePolicy: 'automatic', queryRewrite: { enabled: false }, semantic: { enabled: false } },
    task: { enabled: false }, web: { enabled: false }, shell: { enabled: false }, 'read-file': { enabled: false },
  } }), { mode: 0o600 });
  const source = await readFile(fileURLToPath(import.meta.url));
  const runtimeHashes = Object.fromEntries(await Promise.all(['app', 'assistant-controller', 'memory-consolidation', 'memory-store', 'model-config'].map(async name =>
    [name, hash(await readFile(new URL(`../cli/dist/${name}.js`, import.meta.url)))])));
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { /* export */ }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ suite: 'memory-sequence-v1', source: '我的 eval', requestedModelId: transitionModel.modelId,
    model: transitionModel, gitCommit, runtimeHashes, runtimeFingerprint: hash(JSON.stringify(runtimeHashes)), evalFingerprint: hash(source),
    oracleVersion: sequenceOracleVersion, cases: sequenceCases, planned: 3, repeat: 1, maxHttpDispatches: 6, seededFacts: 0,
    corpus: 'isolated synthetic Thread; no daily data', retry: 'none; each phase refuses second dispatch', deadlineMs,
    datasetRole: 'developer-authored regression, not held-out', modelVerification: 'request and SDK usage, not provider attestation' }, null, 2), { mode: 0o600 });
  await writeFile(join(root, 'frozen-eval.mjs'), source, { mode: 0o600 });
  const fixedEnv = { ...env, RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: transitionModel.modelId, COMMAND_CODE_BASE_URL: transitionModel.baseURL };
  let boundary = createTransitionFetch();
  const selected = configureCliModel(() => { throw Error('Mock forbidden'); }, fixedEnv, { fetch: (...args) => boundary.fetch(...args) });
  const output = new PassThrough(), store = createMemoryStore(workspace), rows = [], phaseResults = [];
  let controller, app;
  output.on('data', chunk => controller?.recordOutput(chunk.toString()));
  try {
    app = await createRuntimeApp({ args: ['--tui', join(root, 'transcripts'), '--thread', threadId, '--config', config], ...selected, output, env: fixedEnv, cwd: root });
    controller = createAssistantController(app);
    controller.subscribe(event => {
      if (event.type === 'approval') controller.confirm({ approvalId: event.approval.approvalId, decision: 'deny' });
      if (event.type === 'run-result') phaseResults.push({ phase: event.phase, status: event.result.status, runId: event.result.runId,
        text: event.result.status === 'completed' ? event.result.text : null });
    });
    await controller.listRuns();
    while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
    for (const [index, test] of sequenceCases.entries()) {
      boundary = createTransitionFetch();
      const evidence = { caseId: test.id, input: test.input, threadId, userMessageId: null, before: await capture(workspace, store, threadId), requests: [], phases: {} };
      const start = phaseResults.length;
      const usageBefore = await app.executionRecords.listModelUsage(threadId), knownCalls = new Set(usageBefore.calls.map(call => call.id));
      let deadline;
      try {
        await Promise.race([(async () => {
          const admission = await controller.run(test.input);
          if (!admission.ok) throw Object.assign(Error('Admission failed'), { code: 'ADMISSION_FAILED' });
          evidence.primaryRunId = admission.runId;
          while (controller.getSnapshot().state.kind !== 'idle') await delay(20);
        })(), new Promise((_, reject) => {
          deadline = setTimeout(() => { void controller.cancel(); reject(Object.assign(Error('Deadline'), { code: 'EVAL_DEADLINE' })); }, deadlineMs);
        })]);
      } catch (cause) { evidence.environmentFailure = transitionSafeError(cause); }
      finally { clearTimeout(deadline); }
      evidence.phaseResults = phaseResults.slice(start);
      evidence.phases = Object.fromEntries(evidence.phaseResults.map(row => [row.phase, row.status]));
      evidence.consolidationRawText = evidence.phaseResults.findLast(row => row.phase === 'consolidation')?.text ?? null;
      evidence.requests = boundary.requests;
      try {
        const history = await controller.getHistory();
        evidence.userMessageId = history.findLast(message => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.text === test.input))?.id ?? null;
        evidence.receipts = checked(await controller.getMemoryReceipts());
        evidence.persistedReceipt = checked(await store.getConsolidationReceipt(threadId));
        const usage = await app.executionRecords.listModelUsage(threadId);
        evidence.usage = { ...usage, calls: usage.calls.filter(call => !knownCalls.has(call.id)) };
        evidence.modelVerified = evidence.usage.calls.length === 2 && usage.droppedCount === 0 && evidence.usage.calls.every(call => call.modelId === transitionModel.modelId);
        evidence.after = await capture(workspace, store, threadId);
      } catch (cause) { evidence.environmentFailure ??= transitionSafeError(cause); }
      evidence.after ??= { formal: [], pending: [], readErrors: ['capture_failed'] };
      if (evidence.requests.some(row => row.transportFailure || row.httpStatus >= 400)) evidence.environmentFailure ??= transitionSafeError({});
      evidence.oracle = scoreSequenceRound(index, evidence, rows);
      rows.push(evidence);
      await writeFile(join(root, `${test.id}-evidence.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      await writeFile(join(root, 'summary.json'), JSON.stringify(summarizeSequence(rows), null, 2), { mode: 0o600 });
      // Dependent rounds must not masquerade as independently executable after an unmet prerequisite.
      if (!evidence.oracle.passed) break;
    }
  } catch (cause) {
    const failure = { caseId: sequenceCases[rows.length]?.id ?? 'initialization', environmentFailure: transitionSafeError(cause),
      oracle: { version: sequenceOracleVersion, passed: false, failures: ['execution_infrastructure_failed'] } };
    // If admission/capture failed outside a round, retain it without inventing execution.
    await writeFile(join(root, 'infrastructure-failure.json'), JSON.stringify(failure, null, 2), { mode: 0o600 });
    const summary = { ...summarizeSequence(rows), status: 'environment_failed', environmentFailures: 1,
      infrastructureFailure: failure };
    await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return { report: root, ...summary };
  } finally { await controller?.shutdown(); }
  return { report: root, ...summarizeSequence(rows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMemorySequence({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
