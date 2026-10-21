import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { wrapLanguageModel } from 'ai';
import { JsonlAgentStore, hashCanonicalJson } from '@serika/core';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';
import { ContextCompactor } from '@serika/assistant/internal/context-compactor.js';
import { createAiSdkSummarizer } from '@serika/assistant/internal/context-compaction.js';
import { layerMessage, blockLimits } from '@serika/assistant/internal/context-blocks.js';
import { estimateMessageTokens } from '@serika/assistant/internal/context-budget.js';
import { createRuntimeApp } from '@serika/assistant/internal/app.js';
import { createAssistantController } from '@serika/assistant/internal/assistant-controller.js';
import { m1Cases, evaluateM1 } from './cm-step4.mjs';
import { compactionFidelitySpec, effectiveCompactionFidelitySpec, compactionFidelityHistory } from './compaction-fidelity.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const price = { input: 0.16, cachedInput: 0.02, output: 0.58 };
const limit = 2, opening = 0.36;
const script = fileURLToPath(import.meta.url);

// Before dispatch reserve one token per encoded byte plus the entire output cap.
// Missing returned usage freezes the batch, including across the cold process.
export async function meteredModel(model, path, scope) {
  let report = JSON.parse(await readFile(path, 'utf8'));
  const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n');
  const begin = async params => {
    report = JSON.parse(await readFile(path, 'utf8'));
    if (report.stopped || report.calls.some(call => call.status !== 'returned')) throw new Error('Batch frozen by unresolved usage');
    const bytes = Buffer.byteLength(JSON.stringify(params.prompt)), reserve = bytes * price.input / 1e6 + params.maxOutputTokens * price.output / 1e6;
    if (!Number.isFinite(reserve) || report.costUsd + reserve > limit || opening + report.costUsd + reserve > 5) {
      report.stopped = true; report.stopReason = 'pre-dispatch-budget'; await save(); throw new Error('Approved budget reserve exceeded');
    }
    const row = { id: randomUUID(), scope: scope(), status: 'dispatched', startedAt: new Date().toISOString(), inputHash: hashCanonicalJson(params.prompt), inputBytes: bytes,
      maxOutputTokens: params.maxOutputTokens, reservedUsd: reserve, usage: null };
    report.calls.push(row); await save(); return row;
  };
  const finish = async (row, usage) => {
    const input = usage?.inputTokens?.total, output = usage?.outputTokens?.total, cached = usage?.inputTokens?.cacheRead;
    if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0) || cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > input)) {
      row.status = 'usage_unknown'; report.stopped = true; report.stopReason = 'usage_unknown'; await save(); throw new Error('Provider usage unavailable; batch stopped');
    }
    const costUsd = ((input - (cached ?? 0)) * price.input + (cached ?? 0) * price.cachedInput + output * price.output) / 1e6;
    Object.assign(row, { status: 'returned', finishedAt: new Date().toISOString(), usage: { input, output, cacheRead: cached ?? null }, costUsd,
      costBasis: cached === undefined ? 'uncached upper bound; cache usage absent' : 'returned usage at approved quote' });
    report.costUsd += costUsd;
    if (report.costUsd >= limit || opening + report.costUsd >= 5) { report.stopped = true; report.stopReason = 'actual-budget'; }
    await save();
  };
  const failed = async row => { if (row.status === 'returned') return; row.status = 'failed_usage_unknown'; report.stopped = true; report.stopReason = 'provider_failure'; await save(); };
  return wrapLanguageModel({ model, middleware: {
    wrapGenerate: async ({ doGenerate, params }) => {
      const row = await begin(params);
      try { const result = await doGenerate(); await finish(row, result.usage); return result; }
      catch { await failed(row); throw new Error('Provider invocation failed; batch stopped (details redacted)'); }
    },
    wrapStream: async ({ doStream, params }) => {
      const row = await begin(params);
      try {
        const result = await doStream(); let finished = false;
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            if (chunk.type === 'error') { await failed(row); throw new Error('Provider stream failed; batch stopped'); }
            if (chunk.type === 'finish') { await finish(row, chunk.usage); finished = true; }
            controller.enqueue(chunk);
          },
          async flush() { if (!finished) { await failed(row); throw new Error('Provider stream ended without usage'); } },
        })) };
      } catch { await failed(row); throw new Error('Provider invocation failed; batch stopped (details redacted)'); }
    },
  } });
}

async function runChat({ model, modelAlias, root, spec, question, label }) {
  const output = new PassThrough(); output.resume();
  const configPath = join(root, 'config.json'), workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: false }, 'read-file': { enabled: false } }, contextCompaction: spec.contextBudget,
    modelContextWindows: [{ provider: 'openai-compatible.chat', modelId: model.modelId, contextWindowTokens: spec.contextBudget.contextWindowTokens }], run: { maxSteps: 1, totalTimeoutMs: 120000 } }));
  const app = await createRuntimeApp({ directory: join(root, 'transcripts'), assistant: { threadId: 'eval', configPath }, model, modelAlias, output, env: {}, cwd: root });
  const controller = createAssistantController(app); const unexpected = [];
  controller.subscribe(event => { if (event.type === 'error' || event.type === 'approval') unexpected.push(event.type); });
  try {
    await controller.runs.list(); await app.background.pause();
    const before = (await controller.runs.listModelUsage()).calls.length;
    const started = await controller.run(question); assert.ok(started.ok);
    const end = Date.now() + 125000;
    while (controller.getSnapshot().state.kind !== 'idle') { if (Date.now() > end) throw new Error('Primary did not settle'); await delay(25); }
    // Let the queue finish its item before closing, so usage never becomes an assumed zero.
    while (true) {
      const d = await controller.getContextDiagnostics(); assert.ok(d.ok);
      if (d.value.background?.error) throw new Error('Background rejected summary');
      if (!d.value.background?.queued && !d.value.background?.running) break;
      if (Date.now() > end) throw new Error('Background did not settle'); await delay(25);
    }
    const result = controller.getSnapshot().lastPrimaryResult, runs = await controller.runs.list();
    const diagnostics = await controller.getContextDiagnostics();
    const response = result?.text ?? '';
    const checks = {
      completed: result?.status === 'completed', goal: response.includes('完成验收报告'), decision: response.includes('本地文件'), pending: response.includes('失败样本'),
      permission: /未.*(?:批准|授权)|尚未.*(?:批准|授权)|没有.*(?:批准|授权)/.test(response),
      uncertain: /(?:结果|状态|写入).{0,12}(?:未知|不确定)|(?:未知|不确定).{0,12}(?:结果|写入)/.test(response),
      noAutomaticRetry: /(?:不能|不应|不得|不可|不要|不允许).{0,15}(?:自动重试|重试)|(?:需|需要|必须).{0,15}(?:核实|确认|对账)/.test(response),
      pastRead: /(?:读取|读文件).{0,12}(?:成功|完成)|(?:成功|完成).{0,12}读取/.test(response),
      permissionNotInherited: /(?:不能|不可|不代表|不等于|不意味着|不得|不构成).{0,25}(?:授权|权限|批准|再次读取)|(?:重新|再次|新的).{0,12}(?:批准|授权)|(?:需要|需|必须).{0,12}(?:批准|授权)/.test(response),
      noToolReplay: runs.every(run => run.tools.length === 0), noUnexpected: unexpected.length === 0,
      inputFits: diagnostics.ok && diagnostics.value.lastPreparation.estimatedInputTokens <= spec.contextBudget.inputBudgetTokens,
    };
    return { label, pid: process.pid, checks, passed: Object.values(checks).every(Boolean), reply: response, runStatus: result?.status,
      usageCalls: (await controller.runs.listModelUsage()).calls.length - before, diagnostics: diagnostics.ok ? diagnostics.value : null };
  } finally { await controller.shutdown(); app.dispose(); }
}

async function main() {
  const cold = process.argv.includes('--cold');
  const evidencePath = process.env.SERIKA_CM6_LIVE_REPORT ?? join(repo, 'docs/v2-pilot/evidence/cm-step6/live.json');
  process.env.SERIKA_CM6_LIVE_REPORT = evidencePath;
  if (!cold) {
    assert.ok(process.argv.includes('--approved-live'), 'Approved live opt-in required');
    assert.equal(git('status', '--porcelain'), '', 'Commit and verify source before paid acceptance');
    try { await readFile(evidencePath); throw new Error('Existing batch cannot be rerun under the same approval'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const root = await mkdtemp(join(tmpdir(), 'cm6-live-'));
    process.env.SERIKA_CM6_ROOT = root;
    process.env.SERIKA_CM6_ENV = join(root, 'model.env');
    const sourceEnv = parseEnv(await readFile('/Users/a1-6/Code/agents/aisdk-agent-framework/.env', 'utf8'));
    const names = ['RUNLOOM_MODEL', 'COMMAND_CODE_API_KEY', 'COMMAND_CODE_MODEL_ID', 'COMMAND_CODE_BASE_URL'];
    const isolated = Object.fromEntries(names.filter(name => sourceEnv[name] !== undefined).map(name => [name, sourceEnv[name]]));
    await writeFile(process.env.SERIKA_CM6_ENV, Object.entries(isolated).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ runId: randomUUID(), startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
      scriptSha256: sha(await readFile(script)), platform: process.platform, parentPid: process.pid, approval: 'Combined steps 4-6; current local env authorized by user',
      quotedUsdPerMillion: price, budgetUsd: limit, openingPlanCostUsd: opening, costUsd: 0, calls: [], stopped: false, results: [] }, null, 2));
  }
  const env = parseEnv(await readFile(process.env.SERIKA_CM6_ENV, 'utf8'));
  assert.equal(env.RUNLOOM_MODEL, 'command-code'); assert.equal(env.COMMAND_CODE_MODEL_ID, 'deepseek/deepseek-v4.1-flash-fast');
  const selected = configureCliModel(() => { throw new Error('No mock fallback'); }, env, { fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }) });
  let current = cold ? 'cold' : 'm1';
  const model = await meteredModel(selected.model, evidencePath, () => current);
  if (cold) {
    const job = JSON.parse(await readFile(process.env.SERIKA_CM6_COLD_JOB, 'utf8'));
    const result = await runChat({ ...selected, model, ...job, label: 'cold-process' });
    await writeFile(process.env.SERIKA_CM6_COLD_RESULT, JSON.stringify(result, null, 2)); return;
  }
  assert.equal(git('branch', '--show-current'), 'experiment/architecture-v2');
  const root = process.env.SERIKA_CM6_ROOT, results = []; let error = null;
  try {
    const cases = m1Cases(), replay = JSON.parse(await readFile(process.env.SERIKA_CM4_REPLAY, 'utf8'));
    const plan = JSON.parse(await readFile(join(repo, 'docs/v2-pilot/evidence/cm-step4/plan.json'), 'utf8'));
    assert.equal(hashCanonicalJson(replay.messages), plan.results.find(item => item.case === 'replay-9').sourceHash);
    cases.push({ id: 'replay-9', messages: replay.messages, proposals: [], replay: true, question: replay.question });
    const m1 = await evaluateM1({ cases, model }); results.push({ suite: 'M1', ...m1 });
    if (m1.stopped) throw new Error('M1 dispatch stopped');
    for (const id of ['CF03', 'CF05', 'CE03', 'CE05']) {
      const spec = id.startsWith('CE') ? effectiveCompactionFidelitySpec(id) : compactionFidelitySpec(id);
      const caseRoot = join(root, id), directory = join(caseRoot, 'transcripts'); await mkdir(directory, { recursive: true });
      const store = new JsonlAgentStore({ directory }); let messages = []; const rounds = [];
      const caseResult = { suite: id, rounds, passed: false }; results.push(caseResult);
      let compactor = new ContextCompactor({ store, threadId: 'eval', modelId: selected.modelAlias, budget: spec.contextBudget,
        modelContextWindowTokens: spec.contextBudget.contextWindowTokens, fixedContext: () => ({ instructions: 'Maintain original constraints.', tools: [] }), summarizer: createAiSdkSummarizer(model) });
      for (let generation = 0; generation < spec.rounds; generation++) {
        current = `${id}/background/${generation}`;
        messages = [...await store.getModelMessages('eval'), ...compactionFidelityHistory(spec, generation).messages,
          { id: `${id}-probe-${generation}`, role: 'user', parts: [{ type: 'text', text: spec.turns[generation] }] }];
        await store.save('eval', messages);
        const before = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
        const projection = await compactor.prepare(messages, AbortSignal.timeout(30000));
        assert.equal(JSON.parse(await readFile(evidencePath, 'utf8')).calls.length, before);
        assert.match(JSON.stringify(projection), /masked pending/);
        while (compactor.pending) { await compactor.runPending(AbortSignal.timeout(120000)); if (compactor.backgroundError) throw new Error(`Summary rejected in ${id}`); }
        const records = await store.getContextCompactions('eval'), record = records.at(-1);
        assert.ok(record); const view = layerMessage(record), viewText = JSON.stringify(view);
        const bounds = blockLimits(spec.contextBudget);
        const layerChecks = { goal: viewText.includes(spec.truth.goal), decision: viewText.includes('本地文件'), pending: viewText.includes('失败样本'),
          permission: viewText.includes('批准'), unknown: record.summary.actions.some(action => action.toolCallIds.includes('fidelity-write') && action.status === 'unknown'),
          recent: record.layers.recent.length <= 4, index: record.layers.index.length <= 1,
          total: estimateMessageTokens([view, record.checklist]) <= bounds.totalSummary };
        current = `${id}/chat/${generation}`;
        const chat = await runChat({ ...selected, model, root: caseRoot, spec, question: spec.turns[generation], label: `round-${generation}` });
        rounds.push({ generation, foregroundAuxiliaryCalls: 0, records: records.length, layerChecks, chat, passed: Object.values(layerChecks).every(Boolean) && chat.passed });
        console.log(JSON.stringify({ case: id, generation, passed: rounds.at(-1).passed }));
        // Each fresh object reopens committed layers; the final check uses a separate OS process.
        compactor = new ContextCompactor({ store, threadId: 'eval', modelId: selected.modelAlias, budget: spec.contextBudget,
          modelContextWindowTokens: spec.contextBudget.contextWindowTokens, fixedContext: () => ({}), summarizer: createAiSdkSummarizer(model) });
      }
      const childJob = join(root, `${id}-cold-job.json`), childResult = join(root, `${id}-cold-result.json`);
      await writeFile(childJob, JSON.stringify({ root: caseRoot, spec, question: spec.afterRestart }));
      const callsBefore = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
      const child = spawn(process.execPath, [script, '--cold'], { cwd: repo, env: { ...process.env, SERIKA_CM6_COLD_JOB: childJob, SERIKA_CM6_COLD_RESULT: childResult }, stdio: ['ignore', 'ignore', 'ignore'] });
      const exitCode = await new Promise(resolve => child.once('exit', resolve)); assert.equal(exitCode, 0, 'Cold process failed; inspect metered status, no provider exception text retained');
      const coldResult = JSON.parse(await readFile(childResult, 'utf8')); assert.notEqual(coldResult.pid, process.pid);
      const childCalls = JSON.parse(await readFile(evidencePath, 'utf8')).calls.slice(callsBefore);
      const coldChecks = { actualNewProcess: coldResult.pid !== process.pid, noSummaryRegeneration: childCalls.length === 1, answer: coldResult.passed };
      Object.assign(caseResult, { cold: coldResult, coldChecks, passed: rounds.every(round => round.passed) && Object.values(coldChecks).every(Boolean) });
    }
  } catch (cause) { error = { name: cause.name, message: /Summary rejected in|M1 dispatch stopped|Cold process failed/.test(cause.message) ? cause.message : 'Batch stopped; see request status and checks. Provider detail omitted.' }; }
  const report = JSON.parse(await readFile(evidencePath, 'utf8'));
  Object.assign(report, { results, error, finishedAt: new Date().toISOString(), passed: !error && results.length === 5 && results.every(result => result.suite === 'M1' ? result.results.every(item => item.passed) : result.passed) });
  await rm(root, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true;
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n');
  const ledgerPath = join(repo, 'docs/v2-pilot/evidence/cost-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.limits.combinedSteps4To6 = 2;
  ledger.entries.push({ step: '4-6', runId: report.runId, realModelRequests: report.calls.length, amount: report.costUsd,
    unresolvedCalls: report.calls.filter(call => call.status !== 'returned').length,
    unresolvedReservedUsd: report.calls.filter(call => call.status !== 'returned').reduce((sum, call) => sum + call.reservedUsd, 0),
    evidence: 'cm-step6/live.json', evidenceSha256: sha(await readFile(evidencePath)) });
  ledger.total = ledger.openingBalance.amount + ledger.entries.reduce((sum, entry) => sum + entry.amount, 0);
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
  console.log(JSON.stringify({ runId: report.runId, calls: report.calls.length, costUsd: report.costUsd, stopped: report.stopped, passed: report.passed }));
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try { await main(); }
  catch { console.error('Acceptance runner stopped; provider details omitted.'); process.exitCode = 1; }
  finally { if (!process.argv.includes('--cold') && process.env.SERIKA_CM6_ROOT) await rm(process.env.SERIKA_CM6_ROOT, { recursive: true, force: true }); }
}
