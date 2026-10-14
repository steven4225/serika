import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonlAgentStore } from '@aisdk-agent/core';
import { evaluateCase, fixtureApproval, summarizeUsage } from './oracle.mjs';
import { reliabilitySpec } from './reliability-cases.mjs';
import { dailyCompactionSpec, fixtureHistory } from './daily-compaction.mjs';
import { contextBudgetForMode } from '@aisdk-agent/example-cli/dist/context-budget.js';

const here = dirname(fileURLToPath(import.meta.url));
// Before and After use the SAME cases/oracle, but independently frozen runtime code.
const runtime = name => process.env.SERIKA_EVAL_BASELINE === '1'
  ? pathToFileURL(join(here, 'results/baseline-b15a2fd-runtime/cli', `${name}.js`)).href
  : `@aisdk-agent/example-cli/dist/${name}.js`;
const { createRuntimeApp } = await import(runtime('app'));
const { createAssistantController } = await import(runtime('assistant-controller'));
const { createDemoModel } = await import(runtime('demo-model'));
const { configureCliModel } = await import(runtime('model-config'));
const { createTaskStore } = await import(runtime('task-store'));
const { formatLocalTaskTime } = await import(runtime('task-instructions'));
const cases = JSON.parse(await readFile(join(here, 'e2e-cases.json'), 'utf8'));
const compactBudget = { enabled: true, contextWindowTokens: 12000, maxOutputTokens: 1024,
  safetyMarginTokens: 512, keepRecentTokens: 1500, summaryMaxOutputTokens: 2048, summaryInputChunkTokens: 24000 };

export function fixtureConfig(spec, workspace) {
  const memory = spec.category === 'memory';
  return { version: 1, workspace,
    modules: { 'read-file': { enabled: true }, memory: { enabled: memory, autoConsolidate: memory, writePolicy: memory ? 'automatic' : 'review', queryRewrite: { enabled: !!spec.rewrite } },
      task: { enabled: spec.category === 'reminders' } },
    ...(spec.category === 'compaction' ? { contextCompaction: spec.contextBudget ?? (spec.contextMode ? contextBudgetForMode(spec.contextMode) : compactBudget) } : {}), run: { maxSteps: 8, totalTimeoutMs: 120000 } };
}

export function createFixtureApprover(spec, restarted, confirm, approvals, boundary = {}) {
  const confirmed = new Set();
  return event => {
    if (event.type !== 'approval' || !event.approval.preview.trim() || confirmed.has(event.approval.approvalId)) return;
    const allowed = fixtureApproval(spec.kind, restarted, event.approval.toolName, event.approval.input, boundary);
    if (!confirm({ approvalId: event.approval.approvalId, decision: allowed ? 'allow' : 'deny' })) return;
    confirmed.add(event.approval.approvalId);
    approvals.push({ restarted, approvalId: event.approval.approvalId, toolName: event.approval.toolName, input: event.approval.input, allowed });
  };
}

async function settled(controller) {
  const end = Date.now() + 180_000;
  while (controller.getSnapshot().state.kind !== 'idle') {
    if (Date.now() > end) { await controller.cancel(); throw new Error('EVAL_DEADLINE: execution did not settle'); }
    await delay(15);
  }
}
function checked(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.error?.code ?? 'FAILED'} ${result.error?.message ?? ''}`);
  return result.value ?? result.entries;
}

/** Read only isolated fixture data. Absence and errors are not fabricated empty stores. */
export async function collectMemorySnapshot(workspace, app, threadId) {
  const readErrors = [];
  const read = async (field, fn) => { try { return structuredClone(await fn()); }
    catch (cause) { readErrors.push({ field, ...safeError(cause) }); } };
  const raw = await read('rawMemory', async () => {
    try { const text = await readFile(join(workspace, '.runloom/memory.json'), 'utf8'); return { present: true, text }; }
    catch (cause) { if (cause.code === 'ENOENT') return { present: false, text: null }; throw cause; }
  });
  const formal = await read('formalMemory', () => app.memoryStore.list().then(r => checked(r, 'formalMemory')));
  const pending = await read('pendingMemory', () => app.memoryStore.listCandidates({ status: 'pending' }, undefined,
    { boundThreadId: threadId }).then(r => checked(r, 'pendingMemory').candidates));
  return { capturedAt: new Date().toISOString(), raw, formal, pending, readErrors };
}

export async function currentRestoreFixtureFact(workspace, app, threadId, phase, administrativeActions) {
  const snapshot = await collectMemorySnapshot(workspace, app, threadId);
  const currentFact = state => state.formal?.find(m => m.enabled && m.status === 'active' && m.temporalState === 'applicable' &&
    m.scope.kind === 'workspace' && m.assertion?.factIdentity?.attribute === 'coffee' &&
    m.assertion.factIdentity.scenario === 'general' && m.assertion.factIdentity.value === 'sweetened');
  const current = currentFact(snapshot);
  if (current) return current;
  // This is explicit user approval inside an isolated fixture, not automatic
  // product acceptance. Never approve an unrelated candidate to reach restore.
  const matching = snapshot.pending?.filter(c => c.status === 'pending' && c.originThreadId === threadId &&
    c.change.operation === 'add' && c.change.scope.kind === 'workspace' &&
    c.change.factIdentity?.attribute === 'coffee' && c.change.factIdentity.scenario === 'general' &&
    c.change.factIdentity.value === 'sweetened' && (c.sources ?? [c.source]).every(s =>
      s?.kind === 'conversation' && s.threadId === threadId && s.messageId === phase.userMessageId &&
      typeof s.quote === 'string' && s.quote.trim().length > 0 && phase.input.includes(s.quote)));
  if (matching?.length !== 1) throw new Error('EXPECTED_MEMORY_MISSING: expected exactly one source-bound current coffee fact or pending fixture approval');
  const candidate = matching[0];
  const accepted = await app.memoryStore.resolveCandidate({ candidateId: candidate.id,
    expectedCandidateRevision: candidate.revision, decision: 'accept' }, undefined, { boundThreadId: threadId });
  const after = await collectMemorySnapshot(workspace, app, threadId);
  administrativeActions.push({ action: 'approve_fixture_current', candidateId: candidate.id,
    userMessageId: phase.userMessageId, ok: accepted.ok, error: accepted.error ?? null, after });
  if (!accepted.ok) throw new Error(`FIXTURE_APPROVAL_FAILED: ${accepted.error.code}`);
  const approved = currentFact(after);
  if (!approved) throw new Error('EXPECTED_MEMORY_MISSING: approved fixture did not produce the current coffee fact');
  return approved;
}
async function artifact(workspace) {
  try { return await readFile(join(workspace, 'notes/report.md'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function extraFiles(workspace, path = '') {
  const entries = await readdir(join(workspace, path), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.name === '.runloom') continue; // Runtime-owned stores are collected separately.
    const name = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await extraFiles(workspace, name));
    else if (name !== 'notes/report.md') found.push(name);
  }
  return found;
}

// Error text is useful evidence; bearer values are not. Never read the configured key.
export function safeError(cause) {
  return { code: cause?.code ?? null, message: String(cause?.message ?? cause)
    .replace(/(?:Bearer\s+|sk-|user_)[\w.\-=/+]{8,}/gi, '[REDACTED]')
    .replace(/((?:api[_ -]?key|authorization|token)["'\s:=]+)[^\s,;"']+/gi, '$1[REDACTED]').slice(0, 3000) };
}

/** A failed run still keeps its available fixture evidence before cleanup. */
export async function collectEvidence(root, spec, app, controller, context) {
  const readErrors = [];
  const read = async (label, fn) => { try { return await fn(); } catch (cause) { readErrors.push({ field: label, ...safeError(cause) }); } };
  const history = await read('history', () => controller.getHistory());
  const originalHistory = spec.newThread && context.threadId !== 'eval'
    ? await read('originalHistory', () => app.store.getMessages('eval')) : history;
  const users = new Map((originalHistory ?? []).filter(m => m.role === 'user')
    .map(m => [m.id, m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n')]));
  let memories, candidates, coverage, cursor, sourcesValid;
  if (app.memoryStore) {
    const entries = await read('memories', async () => checked(await app.memoryStore.list(), 'memories'));
    const material = await read('material', async () => checked(await app.memoryStore.listConsolidationMaterial(undefined, { boundThreadId: context.threadId }), 'material'));
    if (entries && material) {
      memories = entries.filter(m => m.enabled !== false && m.status === 'active' && m.temporalState === 'applicable').map(m => {
        const assertion = material.find(item => item.id === m.id)?.relatedAssertions.find(a => a.assertionId === m.assertion?.assertionId);
        return { id: m.id, text: m.text, identity: m.assertion?.factIdentity ?? null, scope: m.scope, sources: assertion?.sources ?? [] };
      });
      sourcesValid = !!originalHistory && memories.every(m => m.sources.length > 0 && m.sources.every(s => s.kind === 'conversation' && s.quote && users.get(s.messageId)?.includes(s.quote)));
    }
    candidates = await read('candidates', async () => checked(await app.memoryStore.listCandidates({ status: 'pending' }, undefined, { boundThreadId: context.threadId }), 'candidates').candidates);
    coverage = await read('coverage', async () => checked(await app.memoryStore.getConsolidationReceipt(context.threadId), 'receipt'));
    cursor = await read('cursor', async () => checked(await app.memoryStore.getConsolidationCursor(context.threadId), 'cursor'));
  }
  const taskStore = createTaskStore(join(root, 'workspace'));
  const taskPage = await read('taskList', async () => checked(await taskStore.list({ limit: 50 }), 'tasks'));
  const tasks = taskPage ? await Promise.all(taskPage.tasks.map(t => read(`task:${t.id}`, async () => checked(await taskStore.get(t.id), 'task')))) : undefined;
  return { ...context, pid: process.pid, historyIds: history?.map(m => m.id),
    userClocks: history?.filter(m => m.role === 'user').map(m => ({ messageId: m.id, metadata: m.metadata })), memories, candidates, sourcesValid, coverage, cursor, tasks,
    runs: await read('runs', () => controller.listRuns(50)), usage: await read('usage', () => app.executionRecords.listModelUsage(context.threadId)),
    references: controller.getMemoryReferences(), artifact: await read('artifact', () => artifact(join(root, 'workspace'))),
    extraFiles: await read('extraFiles', () => extraFiles(join(root, 'workspace'))),
    diagnostics: await read('diagnostics', () => controller.getContextDiagnostics()),
    compactions: await read('compactions', () => app.store.getContextCompactions(context.threadId)), readErrors,
    ...(readErrors.length ? { error: context.error ?? { code: 'EVIDENCE_READ_FAILED', message: 'See readErrors; unavailable fixture state is not treated as empty.' } } : {}) };
}

/** Each restart stage uses the existing controller in a distinct process. */
async function stage(root, spec, restarted) {
  const selected = configureCliModel(createDemoModel);
  if (typeof selected.model === 'string' || selected.modelAlias === 'mock/default') throw new Error('Live E2E requires a real configured provider');
  const threadId = restarted && spec.newThread ? 'eval-new' : 'eval';
  const output = new PassThrough();
  let controller;
  output.on('data', chunk => controller?.recordOutput(chunk.toString()));
  const taskService = { available: spec.kind !== 'background_unavailable', registered: false, running: false,
    ready: false, todoistPlanningAvailable: false, message: '隔离验收后台未运行，到点不会执行；这里只验证保存，不声称通知送达。' };
  const app = await createRuntimeApp({ args: ['--tui', join(root, 'transcripts'), '--thread', threadId, '--config', join(root, 'config.json')],
    ...selected, output, cwd: root, env: process.env, allowWorkspaceTaskReads: true,
    taskAutomation: { status: async () => taskService, enable: async () => ({ enabled: false, message: taskService.message }) } });
  controller = createAssistantController(app);
  const phases = [], approvals = [], memorySnapshots = [], administrativeActions = [];
  let withdrawnMemory;
  let error = null, historyAtOpen;
  try {
    await controller.listRuns();
    await settled(controller);
    historyAtOpen = (await controller.getHistory()).map(m => m.id);
    const boundary = { taskIds: [] };
    controller.subscribe(createFixtureApprover(spec, restarted, input => controller.confirm(input), approvals, boundary));
    for (const text of restarted ? [spec.afterRestart] : spec.turns) {
      const tasksBefore = spec.category === 'reminders' ? checked(await createTaskStore(join(root, 'workspace')).list({ limit: 50 }), 'tasksBefore').tasks : null;
      boundary.taskIds = tasksBefore?.map(task => task.id) ?? [];
      const before = app.memoryStore ? await collectMemorySnapshot(join(root, 'workspace'), app, threadId) : null;
      const submittedAt = new Date().toISOString();
      const receivedAt = spec.kind === 'ingress_clock' ? formatLocalTaskTime(new Date(Date.now() - 45_000), 'Asia/Shanghai') : undefined;
      const admission = await controller.run(text, receivedAt ? { receivedAt } : undefined);
      if (!admission.ok) throw new Error(`Admission rejected: ${admission.reason}`);
      await settled(controller);
      const snapshot = controller.getSnapshot();
      const userMessageId = (await controller.getHistory()).findLast(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text === text.trim()))?.id;
      const tasksAfter = spec.category === 'reminders' ? checked(await createTaskStore(join(root, 'workspace')).list({ limit: 50 }), 'tasksAfter').tasks : null;
      phases.push({ submittedAt, userMessageId, ...(receivedAt ? { receivedAt } : {}), ...(tasksBefore ? { tasksBefore, tasksAfter } : {}), input: text, runId: admission.runId, status: snapshot.lastPrimaryResult?.status,
        reply: snapshot.lastPrimaryResult?.text ?? '', error: snapshot.lastPrimaryResult?.error ? safeError(snapshot.lastPrimaryResult.error) : null });
      const maintenance = app.memoryStore ? checked(await controller.getMemoryMaintenance(), 'maintenance') : null;
      if (app.memoryStore) memorySnapshots.push({ turn: phases.length, input: text, userMessageId, runId: admission.runId, before,
        after: await collectMemorySnapshot(join(root, 'workspace'), app, threadId), reply: snapshot.lastPrimaryResult?.text ?? '',
        hostOutput: snapshot.recentOutput,
        consolidation: { rawText: snapshot.lastConsolidationResult?.text ?? null, resultStatus: snapshot.lastConsolidationResult?.status ?? null,
          attempt: maintenance?.consolidation.lastAttempt ?? null } });
      if (maintenance?.consolidation.lastAttempt && ['failed', 'uncertain', 'cancelled'].includes(maintenance.consolidation.lastAttempt.status)) {
        throw new Error(`CONSOLIDATION_FAILED: ${maintenance.consolidation.error ?? maintenance.consolidation.lastAttempt.message}`);
      }
      if (snapshot.lastPrimaryResult?.status !== 'completed') throw new Error(`RUN_FAILED: ${snapshot.lastPrimaryResult?.error?.message ?? snapshot.lastPrimaryResult?.status}`);
      if (spec.kind === 'restore_conflict' && phases.length === 1) {
        const old = before === null ? null : (await collectMemorySnapshot(join(root, 'workspace'), app, threadId)).formal
          .find(m => m.enabled && m.assertion?.factIdentity?.attribute === 'coffee' && m.assertion.factIdentity.value === 'unsweetened');
        if (!old) throw new Error('EXPECTED_MEMORY_MISSING: first real-model extraction did not save the old coffee fact');
        const inspected = checked(await app.memoryStore.inspectMemory(old.id, undefined, { boundThreadId: threadId }), 'inspect old fact');
        const retracted = await app.memoryStore.reviseMemory({ id: old.id, expectedRevision: old.revision, operation: 'retract' }, undefined, { boundThreadId: threadId });
        if (!retracted.ok) throw new Error(`RETRACT_FAILED: ${retracted.error.code}`);
        withdrawnMemory = { id: old.id, expectedRevision: retracted.entry.revision, targetAssertionId: inspected.assertions.find(a => a.assertionId === old.assertion.assertionId).assertionId };
        administrativeActions.push({ action: 'retract_old', ok: true, memoryId: old.id, identity: old.assertion.factIdentity });
      } else if (spec.kind === 'restore_conflict' && phases.length === 2) {
        const current = await currentRestoreFixtureFact(join(root, 'workspace'), app, threadId, phases.at(-1), administrativeActions);
        const path = join(root, 'workspace/.runloom/memory.json'), beforeRestore = await readFile(path, 'utf8');
        const blocked = await app.memoryStore.restoreMemory(withdrawnMemory, undefined, { boundThreadId: threadId });
        administrativeActions.push({ action: 'restore_conflict', ok: blocked.ok, error: blocked.error ?? null, unchanged: await readFile(path, 'utf8') === beforeRestore,
          after: await collectMemorySnapshot(join(root, 'workspace'), app, threadId) });
        if (!blocked.ok) {
          const retracted = await app.memoryStore.reviseMemory({ id: current.id, expectedRevision: current.revision, operation: 'retract' }, undefined, { boundThreadId: threadId });
          if (!retracted.ok) throw new Error(`RETRACT_FAILED: ${retracted.error.code}`);
          const restored = await app.memoryStore.restoreMemory(withdrawnMemory, undefined, { boundThreadId: threadId });
          administrativeActions.push({ action: 'restore_after_explicit_retract', ok: restored.ok, error: restored.error ?? null });
        }
      }
      if (spec.kind === 'compact_incremental' && phases.length === 1) {
        const history = await app.store.getMessages(threadId);
        await app.store.save(threadId, [...history, ...fixtureHistory(spec, 1).messages]);
      }
    }
  } catch (cause) {
    error = safeError(cause);
  }
  const evidence = await collectEvidence(root, spec, app, controller, { threadId, historyAtOpen, phases, approvals, memorySnapshots, administrativeActions, error, taskService,
    model: { alias: selected.modelAlias, provider: selected.model.provider, modelId: selected.model.modelId } });
  try { await controller.shutdown(); } catch (cause) { evidence.error ??= safeError(cause); }
  return evidence;
}

async function restartedStage(root, spec) {
  await writeFile(join(root, 'spec.json'), JSON.stringify(spec));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', root], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGTERM'), 210_000);
  const hardTimer = setTimeout(() => child.kill('SIGKILL'), 215_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (code !== 0) throw new Error(`RESTART_CHILD_FAILED: ${code}: ${stderr}`);
    return JSON.parse(await readFile(join(root, 'child-evidence.json'), 'utf8'));
  } finally { clearTimeout(timer); clearTimeout(hardTimer); }
}

export async function runE2E(caseId, variant = 0) {
  const spec = cases.find(c => c.id === caseId) ?? (/^R[DL]\d\d$/.test(caseId) ? dailyCompactionSpec(caseId) : reliabilitySpec(caseId, variant));
  if (!spec) throw new Error('Unknown frozen E2E case ID');
  const root = await mkdtemp(join(tmpdir(), 'serika-promptfoo-e2e-'));
  const workspace = join(root, 'workspace');
  const id = `${caseId}-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let evidence = {}, error = null, seed;
  try {
    await mkdir(workspace);
    if (['create', 'edit', 'deny', 'approval_restart'].includes(spec.kind)) await mkdir(join(workspace, 'notes'));
    for (const [path, text] of Object.entries(spec.initialFiles ?? {})) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), text);
    }
    await writeFile(join(root, 'config.json'), JSON.stringify(fixtureConfig(spec, workspace)));
    if (spec.category === 'compaction') {
      const store = new JsonlAgentStore({ directory: join(root, 'transcripts') });
      seed = fixtureHistory(spec);
      await store.save('eval', seed.messages);
    }
    const first = await stage(root, spec, false);
    evidence = first;
    if (spec.afterRestart && !first.error) {
      const second = await restartedStage(root, spec);
      evidence = { ...second, phases: [...first.phases, ...second.phases], approvals: [...first.approvals, ...second.approvals],
        memorySnapshots: [...first.memorySnapshots, ...second.memorySnapshots], originMemories: first.memories, originCandidates: first.candidates,
        originReferences: first.references,
        usage: { calls: [...(first.usage?.calls ?? []), ...(second.usage?.calls ?? [])].filter((c, i, all) => all.findIndex(v => v.id === c.id) === i), droppedCount: Math.max(first.usage?.droppedCount ?? 0, second.usage?.droppedCount ?? 0) },
        restart: { parentPid: first.pid, childPid: second.pid, newThread: !!spec.newThread, parentHistoryIds: first.historyIds, historyIds: second.historyAtOpen,
          compactionsBefore: first.compactions?.length, summaryCallsBefore: first.usage.calls.filter(c => c.purpose === 'context_compaction').length,
          childToolStarts: (second.runs ?? []).filter(r => second.phases.some(p => p.runId === r.runId)).flatMap(r => r.tools).filter(t => t.startedAt != null).length } };
      if (spec.newThread) evidence.memories = second.memories;
    }
  } catch (cause) { error = safeError(cause); }
  evidence.error ??= error;
  if (seed?.metadata) evidence.seed = seed.metadata;
  const oracle = evaluateCase(spec, evidence);
  const usage = summarizeUsage(evidence.usage?.calls ?? [], evidence.usage?.droppedCount ?? 0);
  const failureClass = oracle.passed ? null : /API_KEY|ENOENT|memory\.writePolicy|401|429|ENOTFOUND|ECONNREFUSED|quota|insufficient.credit/i.test(evidence.error?.message ?? '') ? 'environment_error' : 'agent_failure';
  const result = { id, caseId, variant: spec.variant ?? null, suite: spec.suite ?? 'seed', fixtureTruth: spec.truth ?? null,
    category: spec.category, title: spec.title, source: spec.source ?? '固定种子集', layer: 'real_model_backend', startedAt,
    finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), failureClass,
    oracle, evidence, usage, model: evidence.model ?? null,
    boundaries: { nativeElectron: 'not_run', telegram: 'not_run', simulatedTelegramIngressClock: spec.kind === 'ingress_clock', realWorker: 'not_run', productionLargeWindow: seed?.metadata ? 'production_budget_synthetic_history' : 'not_run', providerMaximumWindow: 'not_verified', syntheticInputs: true, seededCompactionHistory: spec.category === 'compaction' } };
  // Persist safe synthetic evidence BEFORE cleanup. No user workspace or credentials copied.
  try {
    const base = join(here, 'results');
    const dir = resolve(process.env.SERIKA_EVAL_REPORT_DIR ?? join(base, 'standalone'));
    const rel = relative(base, dir);
    if (!rel || rel.startsWith('..') || rel.startsWith(sep)) throw new Error('Evidence directory must be inside eval/results');
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence', `${id}.json`), JSON.stringify(result, null, 2));
    if (seed?.metadata) {
      const seeds = join(dir, 'fixtures', id); await mkdir(seeds, { recursive: true });
      await writeFile(join(seeds, 'history.json'), JSON.stringify(seed.messages));
      await writeFile(join(seeds, 'metadata.json'), JSON.stringify(seed.metadata, null, 2));
      if (spec.kind === 'compact_incremental') await writeFile(join(seeds, 'incremental-history.json'), JSON.stringify(fixtureHistory(spec, 1).messages));
    }
    if (evidence.memorySnapshots?.length) {
      const snapshots = join(dir, 'snapshots', id); await mkdir(snapshots, { recursive: true });
      for (const [index, turn] of evidence.memorySnapshots.entries()) {
        for (const side of ['before', 'after']) {
          await writeFile(join(snapshots, `turn-${index + 1}-${side}-memory.json`), turn[side]?.raw?.text ?? 'null');
          await writeFile(join(snapshots, `turn-${index + 1}-${side}-pending.json`), JSON.stringify(turn[side]?.pending ?? null, null, 2));
        }
        await writeFile(join(snapshots, `turn-${index + 1}-receipt.json`), JSON.stringify(turn, null, 2));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  return { output: JSON.stringify(result), ...(usage.inputTokens !== null && usage.outputTokens !== null ? { tokenUsage: { prompt: usage.inputTokens, completion: usage.outputTokens, total: usage.inputTokens + usage.outputTokens } } : {}),
    ...(usage.estimatedCost !== null && usage.currency === 'USD' ? { cost: usage.estimatedCost } : {}),
    metadata: { caseId, category: spec.category, layer: result.layer, model: result.model, usage, failureClass, evidenceId: id, boundaries: result.boundaries } };
}

if (process.argv[2] === '--child') {
  const root = resolve(process.argv[3]);
  if (!basename(root).startsWith('serika-promptfoo-e2e-') || (await lstat(root)).isSymbolicLink()) throw new Error('Invalid owned fixture root');
  if (process.env.SERIKA_EVAL_LIVE !== '1') throw new Error('Explicit live opt-in required');
  const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'));
  const result = await stage(root, spec, true);
  await writeFile(join(root, 'child-evidence.json'), JSON.stringify(result));
}
