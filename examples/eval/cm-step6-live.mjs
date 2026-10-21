import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
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

export const chargedUsd = entry => entry.amount + (entry.unresolvedReservedUsd ?? 0);
export const pastReadSucceeded = response => response.split(/[。！？?；;，,\n]/u).some(clause =>
  /(?:读取|读文件)[\s\S]*(?:成功|完成|\bcompleted\b)|(?:成功|完成|\bcompleted\b)[\s\S]*(?:读取|读文件)/iu.test(clause) &&
  !/(?:未|没|不|无法|不能|失败|未知|不确定|是否|能否|将|预计|如果|如获)|(?:写入|写文件|部署)/u.test(clause));

async function recheckRecorded() {
  assert.deepEqual(process.argv.slice(2), ['--recheck-recorded']);
  const source = 'docs/v2-pilot/evidence/cm-step6/live-1834686a-b68d-49fb-9f39-d04f1f99bac9.json';
  const bytes = await readFile(join(repo, source)), report = JSON.parse(bytes);
  const reference = { referenceId: randomUUID(), generatedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'),
    scriptSha256: sha(await readFile(script)), source, sourceSha256: sha(bytes), sourceRunId: report.runId,
    realModelCalls: 0, costUsd: 0, referenceOnly: true,
    rounds: report.results.find(result => result.suite === 'CF05').rounds.map(round => {
      const pastRead = pastReadSucceeded(round.chat.reply);
      return { generation: round.generation, replySha256: sha(round.chat.reply), originalRoundPassed: round.passed,
        originalPastRead: round.chat.checks.pastRead, recheckedPastRead: pastRead,
        referenceChecksPassed: Object.values({ ...round.chat.checks, pastRead }).every(Boolean) };
    }) };
  await writeFile(join(repo, 'docs/v2-pilot/evidence/cm-step6/cf05-reference.json'), JSON.stringify(reference, null, 2) + '\n');
  const m1 = report.results.find(result => result.suite === 'M1');
  m1.passed = !m1.stopped && m1.results.length === m1.planned && m1.results.every(item => item.passed);
  report.projection = { source, sourceSha256: sha(bytes), generatedAt: reference.generatedAt,
    change: 'Derive explicit boolean M1.passed from existing case checks; all original scores/calls/timestamps unchanged.' };
  await writeFile(join(repo, 'docs/v2-pilot/evidence/cm-step6/live.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ referenceId: reference.referenceId, originalPassed: reference.rounds.filter(round => round.originalRoundPassed).length,
    referenceChecksPassed: reference.rounds.filter(round => round.referenceChecksPassed).length, referenceOnly: true, realModelCalls: 0, m1Passed: m1.passed }));
}
async function saveAttempt(path, report) {
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  if (!report.ledgerPath) return;
  const ledger = JSON.parse(await readFile(report.ledgerPath, 'utf8'));
  const unresolved = report.calls.filter(call => call.status !== 'returned');
  ledger.entries = ledger.entries.filter(entry => entry.runId !== report.runId);
  ledger.entries.push({ step: '4-6', runId: report.runId, realModelRequests: report.calls.length, amount: report.costUsd,
    unresolvedCalls: unresolved.length, unresolvedReservedUsd: unresolved.reduce((sum, call) => sum + call.reservedUsd, 0),
    evidence: path.slice(join(repo, 'docs/v2-pilot/evidence/').length), evidenceSha256: sha(await readFile(path)) });
  ledger.knownTotal = ledger.openingBalance.amount + ledger.entries.reduce((sum, entry) => sum + entry.amount, 0);
  ledger.total = ledger.openingBalance.amount + ledger.entries.reduce((sum, entry) => sum + chargedUsd(entry), 0);
  await writeFile(report.ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

// Error messages and response bodies can echo prompts or credentials.
export function safeFailure(error) {
  const token = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:[\]-]*$/.test(value) && value.length <= 128 ? value : null;
  const seen = new Set(), chain = [];
  for (let current = error; current && !seen.has(current); current = current.cause ?? current.lastError) {
    seen.add(current);
    let envelope;
    try { envelope = JSON.parse(current.responseBody).error; } catch { /* no raw body */ }
    const issues = current.issues ?? current.value?.issues ?? [];
    chain.push({ name: token(current.name), code: token(current.code ?? current.data?.code ?? envelope?.code ?? envelope?.type),
      httpStatus: Number.isInteger(current.statusCode) ? current.statusCode : null,
      finishReason: token(current.finishReason),
      schemaPaths: [...(current.schemaPaths ?? []), ...issues.map(issue => issue.path)].map(path => Array.isArray(path) ? path.map(part => typeof part === 'number' ? part : token(part) ?? '[field]').join('.') : path === '$' ? '$' : token(path) ?? '[field]'),
      parameter: token(envelope?.param) });
  }
  return { chain };
}

// Before dispatch reserve one token per encoded byte plus the entire output cap.
// Missing returned usage freezes the batch, including across the cold process.
export async function meteredModel(model, path, scope) {
  let report = JSON.parse(await readFile(path, 'utf8'));
  const save = () => saveAttempt(path, report);
  const begin = async params => {
    report = JSON.parse(await readFile(path, 'utf8'));
    if (report.stopped || report.calls.some(call => call.status !== 'returned')) throw new Error('Batch frozen by unresolved usage');
    const bytes = Buffer.byteLength(JSON.stringify(params.prompt)), reserve = bytes * price.input / 1e6 + params.maxOutputTokens * price.output / 1e6;
    if (!Number.isFinite(reserve) || (report.priorChargedUsd ?? 0) + report.costUsd + reserve > limit || opening + (report.priorChargedUsd ?? 0) + report.costUsd + reserve > 5) {
      report.stopped = true; report.stopReason = 'pre-dispatch-budget'; await save(); throw new Error('Approved budget reserve exceeded');
    }
    const row = { id: randomUUID(), scope: scope(), status: 'dispatched', startedAt: new Date().toISOString(), inputHash: hashCanonicalJson(JSON.parse(JSON.stringify(params.prompt))), inputBytes: bytes,
      maxOutputTokens: params.maxOutputTokens, reservedUsd: reserve, usage: null,
      responseFormat: params.responseFormat?.type ?? 'text', finishReason: null };
    report.calls.push(row); await save(); return row;
  };
  const outputShape = text => {
    const encoded = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)?.[1] ?? text;
    const shape = value => Array.isArray(value) ? value.map(shape) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value;
    try { return { encoding: encoded === text ? 'json' : 'fenced-json', shape: shape(JSON.parse(encoded)) }; }
    catch { return { encoding: 'non-json', chars: text.length }; }
  };
  const reload = async row => {
    report = JSON.parse(await readFile(path, 'utf8'));
    const index = report.calls.findIndex(call => call.id === row.id);
    if (report.calls[index].transport) row.transport = report.calls[index].transport;
    report.calls[index] = row;
  };
  const finish = async (row, usage) => {
    await reload(row);
    const input = usage?.inputTokens?.total, output = usage?.outputTokens?.total, cached = usage?.inputTokens?.cacheRead;
    if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0) || cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > input)) {
      row.status = 'usage_unknown'; report.stopped = true; report.stopReason = 'usage_unknown'; await save(); throw new Error('Provider usage unavailable; batch stopped');
    }
    const costUsd = ((input - (cached ?? 0)) * price.input + (cached ?? 0) * price.cachedInput + output * price.output) / 1e6;
    Object.assign(row, { status: 'returned', finishedAt: new Date().toISOString(), usage: { input, output, cacheRead: cached ?? null }, costUsd,
      costBasis: cached === undefined ? 'uncached upper bound; cache usage absent' : 'returned usage at approved quote' });
    report.costUsd += costUsd;
    if ((report.priorChargedUsd ?? 0) + report.costUsd >= limit || opening + (report.priorChargedUsd ?? 0) + report.costUsd >= 5) { report.stopped = true; report.stopReason = 'actual-budget'; }
    await save();
  };
  const failed = async (row, error) => { if (row.status === 'returned') return; await reload(row); row.status = 'failed_usage_unknown'; row.failure = safeFailure(error); row.finishedAt = new Date().toISOString(); report.stopped = true; report.stopReason = 'provider_failure'; await save(); };
  return wrapLanguageModel({ model, middleware: {
    wrapGenerate: async ({ doGenerate, params }) => {
      const row = await begin(params);
      try { const result = await doGenerate(); row.finishReason = result.finishReason; row.output = outputShape(result.content.filter(part => part.type === 'text').map(part => part.text).join("\n")); await finish(row, result.usage); return result; }
      catch (error) { await failed(row, error); throw new Error('Provider invocation failed; batch stopped'); }
    },
    wrapStream: async ({ doStream, params }) => {
      const row = await begin(params);
      try {
        const result = await doStream(); let finished = false, text = "";
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            if (chunk.type === 'text-delta') text += chunk.delta;
            if (chunk.type === 'error') { await failed(row, chunk.error); throw new Error('Provider stream failed; batch stopped'); }
            if (chunk.type === 'finish') { row.finishReason = chunk.finishReason; row.output = outputShape(text); await finish(row, chunk.usage); finished = true; }
            controller.enqueue(chunk);
          },
          async flush() { if (!finished) { const error = new Error('Provider stream ended without usage'); await failed(row, error); throw error; } },
        })) };
      } catch (error) { await failed(row, error); throw new Error('Provider invocation failed; batch stopped'); }
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
  const controller = createAssistantController(app); const unexpected = []; let backgroundFailure = null;
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
      if (d.value.background?.error) { backgroundFailure = d.value.background.failure ?? { code: 'CONTEXT_SUMMARY_FAILED' }; break; }
      if (!d.value.background?.queued && !d.value.background?.running) break;
      if (Date.now() > end) throw new Error('Background did not settle'); await delay(25);
    }
    const result = controller.getSnapshot().lastPrimaryResult, runs = await controller.runs.list();
    const diagnostics = await controller.getContextDiagnostics();
    const response = result?.text ?? '';
    const checks = {
      completed: result?.status === 'completed', backgroundSettled: !backgroundFailure, goal: response.includes('完成验收报告'), decision: response.includes('本地文件'), pending: response.includes('失败样本'),
      permission: /未.*(?:批准|授权)|尚未.*(?:批准|授权)|没有.*(?:批准|授权)/.test(response),
      uncertain: /(?:结果|状态|写入).{0,12}(?:未知|不确定)|(?:未知|不确定).{0,12}(?:结果|写入)/.test(response),
      noAutomaticRetry: /(?:不能|不应|不得|不可|不要|不允许).{0,15}(?:自动重试|重试)|(?:需|需要|必须).{0,15}(?:核实|确认|对账)/.test(response),
      pastRead: pastReadSucceeded(response),
      permissionNotInherited: /(?:不能|不可|不代表|不等于|不意味着|不得|不构成).{0,25}(?:授权|权限|批准|再次读取)|(?:重新|再次|新的).{0,12}(?:批准|授权)|(?:需要|需|必须).{0,12}(?:批准|授权)/.test(response),
      noToolReplay: runs.every(run => run.tools.length === 0), noUnexpected: unexpected.length === 0,
      inputFits: diagnostics.ok && diagnostics.value.lastPreparation.estimatedInputTokens <= spec.contextBudget.inputBudgetTokens,
    };
    return { label, pid: process.pid, checks, passed: Object.values(checks).every(Boolean), reply: response, runStatus: result?.status,
      backgroundFailure, usageCalls: (await controller.runs.listModelUsage()).calls.length - before, diagnostics: diagnostics.ok ? diagnostics.value : null };
  } finally { await controller.shutdown(); app.dispose(); }
}

async function main() {
  if (process.argv.includes('--recheck-recorded')) return recheckRecorded();
  const cold = process.argv.includes('--cold');
  const latestPath = join(repo, 'docs/v2-pilot/evidence/cm-step6/live.json');
  let evidencePath = process.env.SERIKA_CM6_LIVE_REPORT;
  if (!cold) {
    assert.ok(process.argv.includes('--approved-live'), 'Approved live opt-in required');
    assert.equal(git('status', '--porcelain'), '', 'Commit and verify source before paid acceptance');
    const ledgerPath = join(repo, 'docs/v2-pilot/evidence/cost-ledger.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    if (ledger.entries.some(entry => entry.step === '4-6')) assert.ok(process.argv.includes('--rerun-approved-batch'), 'Existing spend requires approved full rerun');
    // Preserve the old mixed report byte-for-byte; its missing metadata cannot be reconstructed.
    let previous;
    try { previous = JSON.parse(await readFile(latestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && !previous.attemptVersion) {
      const archived = join(dirname(latestPath), 'live-legacy-mixed.json');
      await copyFile(latestPath, archived);
      for (const entry of ledger.entries.filter(entry => entry.evidence === 'cm-step6/live.json')) {
        entry.evidence = 'cm-step6/live-legacy-mixed.json'; entry.evidenceSha256 = sha(await readFile(archived));
      }
      await writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
    }
    const priorChargedUsd = ledger.entries.filter(entry => entry.step === '4-6').reduce((sum, entry) => sum + chargedUsd(entry), 0);
    assert.ok(priorChargedUsd < limit, 'Approved combined budget exhausted');
    const runId = randomUUID();
    evidencePath = join(dirname(latestPath), `live-${runId}.json`);
    process.env.SERIKA_CM6_LIVE_REPORT = evidencePath;
    const root = await mkdtemp(join(tmpdir(), 'cm6-live-'));
    process.env.SERIKA_CM6_ROOT = root;
    process.env.SERIKA_CM6_ENV = join(root, 'model.env');
    const sourceEnv = parseEnv(await readFile('/Users/a1-6/Code/agents/aisdk-agent-framework/.env', 'utf8'));
    const names = ['RUNLOOM_MODEL', 'COMMAND_CODE_API_KEY', 'COMMAND_CODE_MODEL_ID', 'COMMAND_CODE_BASE_URL'];
    const isolated = Object.fromEntries(names.filter(name => sourceEnv[name] !== undefined).map(name => [name, sourceEnv[name]]));
    await writeFile(process.env.SERIKA_CM6_ENV, Object.entries(isolated).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
    await mkdir(dirname(evidencePath), { recursive: true });
    await saveAttempt(evidencePath, { attemptVersion: 2, runId, startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
      scriptSha256: sha(await readFile(script)), platform: process.platform, parentPid: process.pid, approval: 'Review fixes 1-4 and full rerun; local env authorized; old unknown call charged at reserve',
      quotedUsdPerMillion: price, budgetUsd: limit, openingPlanCostUsd: opening, priorChargedUsd, ledgerPath, costUsd: 0, calls: [], stopped: false, results: [],
      providerContract: { docs: 'https://commandcode.ai/docs/provider', structuredOutputParameter: 'not used; JSON Schema is prompt text', strictSchemaSupport: 'not claimed' } });
  }
  const env = parseEnv(await readFile(process.env.SERIKA_CM6_ENV, 'utf8'));
  assert.equal(env.RUNLOOM_MODEL, 'command-code'); assert.equal(env.COMMAND_CODE_MODEL_ID, 'deepseek/deepseek-v4.1-flash-fast');
  const selected = configureCliModel(() => { throw new Error('No mock fallback'); }, env, { fetch: async (url, init) => {
    const body = JSON.parse(init.body), report = JSON.parse(await readFile(evidencePath, 'utf8'));
    const row = report.calls.at(-1);
    row.transport = { requestFields: Object.keys(body), responseFormatType: body.response_format?.type ?? null, requestBytes: Buffer.byteLength(init.body), requestHash: sha(init.body), httpStatus: null };
    await saveAttempt(evidencePath, report);
    const response = await fetch(url, { ...init, redirect: 'error' });
    const fresh = JSON.parse(await readFile(evidencePath, 'utf8'));
    fresh.calls.at(-1).transport.httpStatus = response.status; await saveAttempt(evidencePath, fresh);
    return response;
  } });
  if (!cold) {
    const response = await fetch('https://api.commandcode.ai/provider/v1/models', { redirect: 'error' });
    const catalog = await response.json();
    const item = catalog.data?.find(item => item.id === env.COMMAND_CODE_MODEL_ID);
    const report = JSON.parse(await readFile(evidencePath, 'utf8'));
    report.providerContract.catalog = { httpStatus: response.status, modelFound: !!item, supportedEndpoints: item?.supported_endpoints ?? [], strictSchemaSupportAdvertised: Object.hasOwn(item ?? {}, 'supported_parameters') };
    await saveAttempt(evidencePath, report);
    assert.ok(item?.supported_endpoints.includes('/chat/completions'));
  }
  let current = cold ? 'cold' : 'm1';
  const model = await meteredModel(selected.model, evidencePath, () => current);
  if (cold) {
    const job = JSON.parse(await readFile(process.env.SERIKA_CM6_COLD_JOB, 'utf8'));
    let result;
    try { result = await runChat({ ...selected, model, ...job, label: 'cold-process' }); }
    catch (error) { result = { pid: process.pid, passed: false, error: safeFailure(error) }; }
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
    console.log(JSON.stringify({ suite: 'M1', passed: m1.results.filter(item => item.passed).length, total: m1.results.length }));
    if (m1.stopped) throw new Error('M1 dispatch stopped');
    for (const id of ['CF03', 'CF05', 'CE03', 'CE05']) {
      const spec = id.startsWith('CE') ? effectiveCompactionFidelitySpec(id) : compactionFidelitySpec(id);
      const caseRoot = join(root, id), directory = join(caseRoot, 'transcripts'); await mkdir(directory, { recursive: true });
      const store = new JsonlAgentStore({ directory }); let messages = []; const rounds = [];
      const caseResult = { suite: id, rounds, passed: false }; results.push(caseResult);
      try {
      let compactor = new ContextCompactor({ store, threadId: 'eval', modelId: selected.modelAlias, budget: spec.contextBudget,
        modelContextWindowTokens: spec.contextBudget.contextWindowTokens, fixedContext: () => ({ instructions: 'Maintain original constraints.', tools: [] }), summarizer: createAiSdkSummarizer(model) });
      for (let generation = 0; generation < spec.rounds; generation++) {
        const round = { generation, startedAt: new Date().toISOString(), backgroundItems: [], passed: false }; rounds.push(round);
        try {
        current = `${id}/background/${generation}`;
        messages = [...await store.getModelMessages('eval'), ...compactionFidelityHistory(spec, generation).messages,
          { id: `${id}-probe-${generation}`, role: 'user', parts: [{ type: 'text', text: spec.turns[generation] }] }];
        await store.save('eval', messages);
        const before = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
        const projection = await compactor.prepare(messages, AbortSignal.timeout(30000));
        const foregroundAuxiliaryCalls = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length - before;
        round.foregroundAuxiliaryCalls = foregroundAuxiliaryCalls;
        assert.equal(foregroundAuxiliaryCalls, 0);
        assert.match(JSON.stringify(projection), /masked pending/);
        while (compactor.pending) {
          const callsBefore = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
          await compactor.runPending(AbortSignal.timeout(120000));
          const report = JSON.parse(await readFile(evidencePath, 'utf8'));
          const item = { index: round.backgroundItems.length, callIds: report.calls.slice(callsBefore).map(call => call.id),
            failure: compactor.backgroundFailure ?? null, reason: compactor.backgroundFailure?.code === 'CONTEXT_PREPARE_FAILED' ? compactor.backgroundError : null };
          round.backgroundItems.push(item);
          if (compactor.backgroundError) caseResult.backgroundFailure = { generation, item: item.index, ...item.failure, reason: item.reason };
          report.results = results; await saveAttempt(evidencePath, report);
          if (compactor.backgroundError) break;
        }
        const records = await store.getContextCompactions('eval'), record = records.at(-1);
        const view = record ? layerMessage(record) : null, viewText = JSON.stringify(view);
        const bounds = blockLimits(spec.contextBudget);
        const layerChecks = { goal: viewText.includes(spec.truth.goal), decision: viewText.includes('本地文件'), pending: viewText.includes('失败样本'),
          permission: viewText.includes('批准'), unknown: !!record?.summary.actions.some(action => action.toolCallIds.includes('fidelity-write') && action.status === 'unknown'),
          recent: !!record && record.layers.recent.length <= 4, index: !!record && record.layers.index.length <= 1,
          total: !!view && estimateMessageTokens([view, record.checklist]) <= bounds.totalSummary };
        current = `${id}/chat/${generation}`;
        const chat = await runChat({ ...selected, model, root: caseRoot, spec, question: spec.turns[generation], label: `round-${generation}` });
        Object.assign(round, { finishedAt: new Date().toISOString(), records: records.length, layerChecks, chat, passed: !compactor.backgroundError && Object.values(layerChecks).every(Boolean) && chat.passed });
        } catch (error) { round.error = safeFailure(error); }
        const roundReport = JSON.parse(await readFile(evidencePath, 'utf8')); roundReport.results = results; await saveAttempt(evidencePath, roundReport);
        if (roundReport.stopped) throw new Error('Batch stopped after provider failure');
        console.log(JSON.stringify({ case: id, generation, passed: round.passed, backgroundFailure: round.backgroundItems.find(item => item.failure)?.failure ?? null }));
        // Each fresh object reopens committed layers; the final check uses a separate OS process.
        compactor = new ContextCompactor({ store, threadId: 'eval', modelId: selected.modelAlias, budget: spec.contextBudget,
          modelContextWindowTokens: spec.contextBudget.contextWindowTokens, fixedContext: () => ({}), summarizer: createAiSdkSummarizer(model) });
      }
      const state = JSON.parse(await readFile(evidencePath, 'utf8')); if (state.stopped) throw new Error('Batch stopped after provider failure');
      const childJob = join(root, `${id}-cold-job.json`), childResult = join(root, `${id}-cold-result.json`);
      await writeFile(childJob, JSON.stringify({ root: caseRoot, spec, question: spec.afterRestart }));
      const callsBefore = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
      const child = spawn(process.execPath, [script, '--cold'], { cwd: repo, env: { ...process.env, SERIKA_CM6_COLD_JOB: childJob, SERIKA_CM6_COLD_RESULT: childResult }, stdio: ['ignore', 'ignore', 'ignore'] });
      const exitCode = await new Promise(resolve => child.once('exit', resolve)); assert.equal(exitCode, 0, 'Cold process failed; inspect metered status, no provider exception text retained');
      const coldResult = JSON.parse(await readFile(childResult, 'utf8')); assert.notEqual(coldResult.pid, process.pid);
      const childCalls = JSON.parse(await readFile(evidencePath, 'utf8')).calls.slice(callsBefore);
      const coldChecks = { actualNewProcess: coldResult.pid !== process.pid, noSummaryRegeneration: childCalls.length === 1, answer: coldResult.passed };
      Object.assign(caseResult, { cold: coldResult, coldChecks, passed: rounds.length === spec.rounds && rounds.every(round => round.passed) && Object.values(coldChecks).every(Boolean) });
      } catch (error) { caseResult.error = safeFailure(error); if (JSON.parse(await readFile(evidencePath, 'utf8')).stopped) throw error; }
    }
  } catch (cause) { error = safeFailure(cause); }
  const report = JSON.parse(await readFile(evidencePath, 'utf8'));
  Object.assign(report, { results, error, finishedAt: new Date().toISOString(), passed: !error && results.length === 5 && results.every(result => result.suite === 'M1' ? result.results.every(item => item.passed) : result.passed) });
  await rm(root, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true;
  await saveAttempt(evidencePath, report);
  await copyFile(evidencePath, latestPath);
  process.exitCode = report.passed ? 0 : 1;
  console.log(JSON.stringify({ runId: report.runId, calls: report.calls.length, costUsd: report.costUsd, stopped: report.stopped, passed: report.passed }));
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; }
  finally { if (!process.argv.includes('--cold') && process.env.SERIKA_CM6_ROOT) await rm(process.env.SERIKA_CM6_ROOT, { recursive: true, force: true }); }
}
