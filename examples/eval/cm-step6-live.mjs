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
import { blockLimits, layerMessage } from '@serika/assistant/internal/context-blocks.js';
import { estimateMessageTokens } from '@serika/assistant/internal/context-budget.js';
import { createRuntimeApp } from '@serika/assistant/internal/app.js';
import { createAssistantController } from '@serika/assistant/internal/assistant-controller.js';
import { m1Cases, evaluateM1 } from './cm-step4.mjs';
import { compactionFidelitySpec, effectiveCompactionFidelitySpec, compactionFidelityHistory } from './compaction-fidelity.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const price = { input: 0.16, cachedInput: 0.02, output: 0.58 };
const limit = 2.75, opening = 0.36;
const script = fileURLToPath(import.meta.url);

export const oldGoalMentioned = response => response.includes('完成验收报告');
export const CHECKER_VERSION = 'cm-step6-offline-v5';
export const goalContentMentioned = sentence => {
  const completion = sentence.indexOf('完成');
  return completion >= 0 && /验收[^。！？?；;\n]*报告/u.test(sentence) &&
    !/(?:未知|不明|(?:无法|不能)确认(?:是否)?|不再(?:需要)?|取消|放弃|是否(?:需要)?|不是(?:要)?|(?:尚|并)?未|不(?:需要|必|应|要)?|无需|不可能|无法|不能|没有必要)(?:再|继续|进一步|去|要|需要)*\s*$/u.test(sentence.slice(0, completion)) &&
    !/(?:不再(?:需要)?|取消|放弃|不是(?:要)?|不(?:需要|必|应|要)?|无需|无法|不能)(?:再|继续|进一步|去|要|需要)*\s*完成[^，,。！？?；;\n]*(?:主项目|验收[^，,。！？?；;\n]*报告)/u.test(sentence) &&
    !/(?:不再(?:需要)?|取消|放弃|不是(?:要)?|不(?:需要|必|应|要)?|无需|无法|不能)(?:再|继续|进一步|去|要|需要)*(?:完成|给出|提供|提交|生成|出具)?\s*(?:主项目|验收[^，,。！？?；;\n]*报告)/u.test(sentence) &&
    !/(?:另一|其他|别的)个?项目|(?:主项目|验收[^，,。！？?；;\n]*报告)\s*(?:并非|不是|不再是|已取消|已放弃)/u.test(sentence);
};
export const summaryGoalMentioned = ({ goal, projectedText }) => goalContentMentioned(goal) &&
  [goal, JSON.stringify(goal).slice(1, -1)].some(text => projectedText.includes(text));
export const goalMentioned = response => {
  const text = response.replaceAll("\\n", "\n").replace(/[「」『』“”"`*]/gu, '').replace(/(目标[：:]?)\s*\n+\s*/gu, '$1：');
  const sentence = text.split(/[。！？?；;\n]/u).find(part => /目标/u.test(part));
  return sentence !== undefined && goalContentMentioned(sentence);
};
export const uncertainMentioned = response => {
  const text = response.replace(/[*`]/gu, '');
  let heading = false, uncertain = false, succeeded = false;
  for (const paragraph of text.split(/\n\s*\n/u)) {
    let write = heading;
    for (const clause of paragraph.split(/[。！？?；;，,\n]/u)) {
      if (/写入|write_file|fidelity-write/iu.test(clause)) write = true;
      else if (/读取|读文件|read_file/iu.test(clause)) write = false;
      else if (/\b(?:unknown|TOOL_OUTCOME_UNKNOWN)\b|效果未知|结果未知|不确定/iu.test(clause) &&
        !/^[\s\-–—\d.（）()]*?(?:结果|状态|效果|不确定|unknown|TOOL_OUTCOME_UNKNOWN|即|当前|该|其|这|那|此次|可能|或许|也许|outcome|status|effect)/iu.test(clause) &&
        !/^\s*[^\s，,。！？?；;]+[）)](?:状态|结果|效果)/u.test(clause)) write = false;
      if (!write) continue;
      if (/\b(?:unknown|TOOL_OUTCOME_UNKNOWN)\b|效果未知|结果未知|不确定/iu.test(clause)) uncertain = true;
      const assertion = clause.replace(/(?:不能|不可|不得|不应|不确定|不确认|未确认|不能声称|不能报告|不能视为|不代表|不等于)[^。！？?；;]*?(?:成功|已完成|已写入)/gu, '').replace(/(?:可能|或许|也许|未必)[^。！？?；;]*?(?:成功|已完成|已写入)/gu, '');
      if (/成功|已完成|已写入/u.test(assertion)) succeeded = true;
    }
    heading = /写入|write_file|fidelity-write/iu.test(paragraph) && !/[。！？?；;，,：:]/u.test(paragraph);
  }
  return uncertain && !succeeded;
};

export const noAutomaticRetryMentioned = response => {
  const text = response.replace(/[*`]/gu, '');
  const unsafe = [...text.matchAll(/(?:可以|建议|应该|应当|允许)\s*(?:自动|直接)?重试/gu)].some(match =>
    !/(?:不|未|没|不能|不应|不得|不可|不要|不允许|禁止)\s*$/u.test(text.slice(0, match.index)));
  return !unsafe && /(?:不能|不应|不得|不可|不要|不允许|不建议|禁止).{0,15}(?:自动重试|重试)|(?:需|需要|必须|须).{0,15}(?:核实|确认|对账)/u.test(text);
};

export const chargedUsd = entry => entry.amount + (entry.unresolvedReservedUsd ?? 0);
export const pastReadSucceeded = response => response.split(/[。！？?；;\n]/u).some(sentence => {
  let candidate = '';
  for (const clause of sentence.split(/[，,]/u)) {
    const statement = clause.replace(/^[^：:]*?(?:是否|能否)[^：:]*[：:]/u, '');
    if (/(?:未|没|不|无法|不能|失败|未知|不确定|是否|能否|将|预计|如果|如获)|(?:写入|写文件|部署)/u.test(statement)) { candidate = ''; continue; }
    candidate += statement;
    if (/(?:读取|读文件)[\s\S]*(?:成功|完成|\bcompleted\b)|(?:成功|完成|\bcompleted\b)[\s\S]*(?:读取|读文件)/iu.test(candidate)) return true;
  }
  return false;
});

export const responseChecks = response => ({
  goal: goalMentioned(response), decision: response.includes('本地文件'), pending: response.includes('失败样本'),
  permission: /未.*(?:批准|授权)|尚未.*(?:批准|授权)|没有.*(?:批准|授权)/.test(response),
  uncertain: uncertainMentioned(response), noAutomaticRetry: noAutomaticRetryMentioned(response), pastRead: pastReadSucceeded(response),
  permissionNotInherited: /(?:不能|不可|不代表|不等于|不意味着|不得|不构成).{0,25}(?:授权|权限|批准|再次读取)|(?:重新|再次|新的).{0,12}(?:批准|授权)|(?:需要|需|必须).{0,12}(?:批准|授权)/.test(response),
});

export function summaryChecks({ record, view, prepared, budget, preparation }) {
  const viewText = view?.parts.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  const bounds = blockLimits(budget);
  return { goal: !!record && summaryGoalMentioned({ goal: record.summary.goal.text, projectedText: viewText }), decision: viewText.includes('本地文件'), pending: viewText.includes('失败样本'),
          permission: viewText.includes('批准'), unknown: !!record?.summary.actions.some(action => action.toolCallIds.includes('fidelity-write') && action.status === 'unknown'),
          recent: !!record && record.layers.recent.length <= 4, index: !!record && record.layers.index.length <= 1,
          total: !!view && estimateMessageTokens(prepared.filter(message => ["runloom-context-summary", "runloom-compaction-checklist"].includes(message.id))) <= bounds.totalSummary + (preparation?.summaryLayer?.borrowedTokens ?? 0) && (preparation?.summaryLayer?.borrowedTokens ?? 0) <= Math.floor(bounds.recent / 2) };
}

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
  const ledger = JSON.parse(await readFile(resolve(repo, report.ledgerPath), 'utf8'));
  const unresolved = report.calls.filter(call => call.status !== 'returned');
  ledger.entries = ledger.entries.filter(entry => entry.runId !== report.runId);
  ledger.entries.push({ step: '4-6', runId: report.runId, realModelRequests: report.calls.length, amount: report.costUsd,
    unresolvedCalls: unresolved.length, unresolvedReservedUsd: unresolved.reduce((sum, call) => sum + call.reservedUsd, 0),
    evidence: path.slice(join(repo, 'docs/v2-pilot/evidence/').length), evidenceSha256: sha(await readFile(path)) });
  ledger.knownTotal = ledger.openingBalance.amount + ledger.entries.reduce((sum, entry) => sum + entry.amount, 0);
  ledger.total = ledger.openingBalance.amount + ledger.entries.reduce((sum, entry) => sum + chargedUsd(entry), 0);
  await writeFile(resolve(repo, report.ledgerPath), JSON.stringify(ledger, null, 2) + '\n');
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

export function summarizeBatch(results) {
  const reasonCounts = Object.fromEntries(['QUOTE_VALUE_MISSING', 'SOURCE_VALUE_MISSING', 'BODY_VALUE_MISSING', 'NUMBER_UNIT_MISMATCH', 'CONDITION_CLAUSE_MISSING'].map(code => [code, 0]));
  const scores = [], qualifiedAnswers = [], c5 = [];
  const preparation = (suite, stage, diagnostic) => {
    const item = diagnostic?.lastPreparation ?? diagnostic;
    if (item?.summaryLayer?.borrowedTokens > 0) c5.push({ suite, stage, ...item.summaryLayer, ...item.degradation, outcome: item.outcome });
  };
  const answer = (suite, stage, chat) => {
    if (!chat) return;
    preparation(suite, stage, chat.diagnostics);
    if (!oldGoalMentioned(chat.reply ?? '') && goalMentioned(chat.reply ?? '')) qualifiedAnswers.push({ suite, stage, reply: chat.reply,
      oldGoal: false, newGoal: true, answerPassedOnlyNew: chat.passedByRule?.old === false && chat.passedByRule?.new === true });
  };
  for (const result of results) {
    if (result.suite === 'M1') {
      for (const row of result.results) {
        const code = row.diagnostics?.validationFailure?.reasonCode;
        if (code in reasonCounts) reasonCounts[code]++;
      }
      scores.push({ suite: 'M1', passed: result.results.filter(row => row.passed).length, total: result.planned, suitePassed: result.passed });
      continue;
    }
    for (const round of result.rounds) {
      for (const item of round.preparations ?? []) preparation(result.suite, `${round.generation}/${item.stage}`, item.diagnostics);
      answer(result.suite, `${round.generation}/chat`, round.chat);
    }
    answer(result.suite, 'cold', result.cold);
    const spec = result.suite.startsWith('CE') ? effectiveCompactionFidelitySpec(result.suite) : compactionFidelitySpec(result.suite);
    scores.push({ suite: result.suite, newRule: { passed: result.rounds.filter(round => round.passed).length, total: spec.rounds,
      cold: result.cold?.passed ?? false, suitePassed: result.passed },
      oldRule: { passed: result.rounds.filter(round => round.passedOldRule).length, total: spec.rounds,
        cold: result.cold?.passedByRule?.old ?? false, suitePassed: result.rounds.length === spec.rounds && result.rounds.every(round => round.passedOldRule) && result.cold?.passedByRule?.old === true } });
  }
  return { scores, keyValueFailures: reasonCounts, qualifiedAnswers,
    c5: { count: c5.length, providerPreparationCount: c5.filter(item => item.stage.endsWith('/chat') || item.stage === 'cold').length,
      totalBorrowedTokensAcrossPreparations: c5.reduce((sum, item) => sum + item.borrowedTokens, 0), preparations: c5 } };
}

export async function runChat({ model, modelAlias, root, spec, question, label, answerArchive }) {
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
    const result = controller.getSnapshot().lastPrimaryResult;
    if (answerArchive) await writeFile(answerArchive, JSON.stringify({ label, pid: process.pid, reply: result?.text ?? '', runStatus: result?.status,
      stage: 'primary-returned', backgroundSettled: false }, null, 2) + '\n');
    // Preserve the returned answer before waiting for separately metered background work.
    try {
      while (true) {
      const d = await controller.getContextDiagnostics(); assert.ok(d.ok);
      if (d.value.background?.error) { backgroundFailure = d.value.background.failure ?? { code: 'CONTEXT_SUMMARY_FAILED' }; break; }
      if (!d.value.background?.queued && !d.value.background?.running) break;
      if (Date.now() > end) throw new Error('Background did not settle'); await delay(25);
      }
    } catch (error) { backgroundFailure = safeFailure(error); }
    const runs = await controller.runs.list();
    const diagnostics = await controller.getContextDiagnostics();
    const response = result?.text ?? '';
    const checks = {
      completed: result?.status === 'completed', backgroundSettled: !backgroundFailure, ...responseChecks(response),
      noToolReplay: runs.every(run => run.tools.length === 0), noUnexpected: unexpected.length === 0,
      inputFits: diagnostics.ok && diagnostics.value.lastPreparation.estimatedInputTokens <= spec.contextBudget.inputBudgetTokens,
    };
    return { label, pid: process.pid, checks, goalChecks: { old: oldGoalMentioned(response), new: checks.goal },
      passedByRule: { old: Object.entries(checks).every(([key, passed]) => key === 'goal' ? oldGoalMentioned(response) : passed), new: Object.values(checks).every(Boolean) },
      passed: Object.values(checks).every(Boolean), reply: response, runStatus: result?.status,
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
    const gate = JSON.parse(await readFile(join(repo, 'docs/v2-pilot/evidence/cm-step6/verification-three.json'), 'utf8'));
    assert.equal(gate.runs.length, 3, 'Three consecutive offline runs required');
    assert.equal(new Set(gate.runs.map(run => run.runId)).size, 3);
    assert.equal(git('diff', '--name-only', gate.sourceCommit, 'HEAD', '--', 'apps', 'packages', 'examples'), '', 'Offline runs must cover the current source');
    for (const run of gate.runs) {
      const bytes = await readFile(join(repo, run.file)), proof = JSON.parse(bytes);
      assert.equal(sha(bytes), run.sha256); assert.equal(proof.status, 'passed');
      assert.equal(proof.sourceCommit, gate.sourceCommit); assert.equal(proof.sourceStayedCleanDuringVerification, true);
      assert.equal(proof.scriptSha256, sha(await readFile(join(repo, 'packages/assistant/scripts/cm-step6-verify.mjs'))));
    }
    const ledgerPath = 'docs/v2-pilot/evidence/cost-ledger.json';
    const ledger = JSON.parse(await readFile(resolve(repo, ledgerPath), 'utf8'));
    if (ledger.entries.some(entry => entry.step === '4-6')) assert.ok(process.argv.includes('--rerun-approved-batch'), 'Existing spend requires approved full rerun');
    // Preserve the old mixed report byte-for-byte; its missing metadata cannot be reconstructed.
    let previous;
    try { previous = JSON.parse(await readFile(latestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(previous?.verificationGateRunId, gate.runId, 'This offline gate already dispatched its one approved batch');
    if (previous && !previous.attemptVersion) {
      const archived = join(dirname(latestPath), 'live-legacy-mixed.json');
      await copyFile(latestPath, archived);
      for (const entry of ledger.entries.filter(entry => entry.evidence === 'cm-step6/live.json')) {
        entry.evidence = 'cm-step6/live-legacy-mixed.json'; entry.evidenceSha256 = sha(await readFile(archived));
      }
      await writeFile(resolve(repo, ledgerPath), JSON.stringify(ledger, null, 2) + '\n');
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
    await saveAttempt(evidencePath, { attemptVersion: 2, checkerVersion: CHECKER_VERSION, verificationGateRunId: gate.runId, runId, startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
      scriptSha256: sha(await readFile(script)), platform: process.platform, parentPid: process.pid, approval: 'User review at 16da181: one final full batch under cumulative $2.75, only after this offline change is reviewed and checker rules are frozen; every dispatch reserves budget first; stop at cap, incomplete batch cannot pass, no retries; old unknown reserve remains charged',
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
    catch (error) {
      let primary = {};
      try { primary = JSON.parse(await readFile(job.answerArchive, 'utf8')); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      result = { ...primary, pid: process.pid, passed: false, error: safeFailure(error) };
    }
    await writeFile(process.env.SERIKA_CM6_COLD_RESULT, JSON.stringify(result, null, 2));
    await writeFile(job.answerArchive, JSON.stringify(result, null, 2) + '\n');
    const archive = JSON.parse(await readFile(evidencePath, 'utf8'));
    archive.results.find(item => item.suite === job.spec.id).cold = result; await saveAttempt(evidencePath, archive); return;
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
        const round = { generation, startedAt: new Date().toISOString(), backgroundItems: [], preparations: [], passed: false }; rounds.push(round);
        try {
        current = `${id}/background/${generation}`;
        messages = [...await store.getModelMessages('eval'), ...compactionFidelityHistory(spec, generation).messages,
          { id: `${id}-probe-${generation}`, role: 'user', parts: [{ type: 'text', text: spec.turns[generation] }] }];
        await store.save('eval', messages);
        const before = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
        const projection = await compactor.prepare(messages, AbortSignal.timeout(30000));
        round.preparations.push({ stage: 'mask', diagnostics: (await compactor.getDiagnostics()).value.lastPreparation });
        const foregroundAuxiliaryCalls = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length - before;
        round.foregroundAuxiliaryCalls = foregroundAuxiliaryCalls;
        assert.equal(foregroundAuxiliaryCalls, 0);
        assert.ok(compactor.pending || (await store.getContextCompactions('eval')).length > 0, 'Background work is queued or a covering summary is published');
        while (compactor.pending) {
          const callsBefore = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
          await compactor.runPending(AbortSignal.timeout(120000));
          const report = JSON.parse(await readFile(evidencePath, 'utf8'));
          const item = { index: round.backgroundItems.length, callIds: report.calls.slice(callsBefore).map(call => call.id),
            normalizations: compactor.backgroundNormalizations, failure: compactor.backgroundFailure ?? null, reason: compactor.backgroundFailure?.code === 'CONTEXT_PREPARE_FAILED' ? compactor.backgroundError : null };
          round.backgroundItems.push(item);
          if (compactor.backgroundError) caseResult.backgroundFailure = { generation, item: item.index, ...item.failure, reason: item.reason };
          report.results = results; await saveAttempt(evidencePath, report);
          if (compactor.backgroundError) break;
        }
        const records = await store.getContextCompactions('eval'), record = records.at(-1);
        const prepared = await compactor.prepare(messages, AbortSignal.timeout(30000));
        round.preparations.push({ stage: 'summary', diagnostics: (await compactor.getDiagnostics()).value.lastPreparation });
        const view = prepared.find(message => message.id === "runloom-context-summary"), viewText = view?.parts.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
        const preparation = (await compactor.getDiagnostics()).value.lastPreparation;
        const layerChecks = summaryChecks({ record, view, prepared, budget: spec.contextBudget, preparation });
        current = `${id}/chat/${generation}`;
        const chat = await runChat({ ...selected, model, root: caseRoot, spec, question: spec.turns[generation], label: `round-${generation}` });
        Object.assign(round, { storedLayerTokens: record ? estimateMessageTokens([layerMessage(record), record.checklist]) : null, finishedAt: new Date().toISOString(), records: records.length, layerChecks, chat, goalChecks: { old: viewText.includes(spec.truth.goal), new: layerChecks.goal },
          passedOldRule: !compactor.backgroundError && Object.entries(layerChecks).every(([key, passed]) => key === "goal" ? viewText.includes(spec.truth.goal) : passed) && chat.passedByRule.old,
          passed: !compactor.backgroundError && Object.values(layerChecks).every(Boolean) && chat.passed });
        } catch (error) { round.error = safeFailure(error); round.preparations.push({ stage: 'failed', diagnostics: (await compactor.getDiagnostics()).value.lastPreparation }); }
        const roundReport = JSON.parse(await readFile(evidencePath, 'utf8')); roundReport.results = results; await saveAttempt(evidencePath, roundReport);
        if (roundReport.stopped) throw new Error('Batch stopped after provider failure');
        console.log(JSON.stringify({ case: id, generation, passed: round.passed, backgroundFailure: round.backgroundItems.find(item => item.failure)?.failure ?? null }));
        // Each fresh object reopens committed layers; the final check uses a separate OS process.
        compactor = new ContextCompactor({ store, threadId: 'eval', modelId: selected.modelAlias, budget: spec.contextBudget,
          modelContextWindowTokens: spec.contextBudget.contextWindowTokens, fixedContext: () => ({}), summarizer: createAiSdkSummarizer(model) });
      }
      const state = JSON.parse(await readFile(evidencePath, 'utf8')); if (state.stopped) throw new Error('Batch stopped after provider failure');
      const childJob = join(root, `${id}-cold-job.json`), childResult = join(root, `${id}-cold-result.json`);
      await writeFile(childJob, JSON.stringify({ root: caseRoot, spec, question: spec.afterRestart,
        answerArchive: join(dirname(evidencePath), `cold-${JSON.parse(await readFile(evidencePath, 'utf8')).runId}-${id}.json`) }));
      const callsBefore = JSON.parse(await readFile(evidencePath, 'utf8')).calls.length;
      const child = spawn(process.execPath, [script, '--cold'], { cwd: repo, env: { ...process.env, SERIKA_CM6_COLD_JOB: childJob, SERIKA_CM6_COLD_RESULT: childResult }, stdio: ['ignore', 'ignore', 'ignore'] });
      const exitCode = await new Promise(resolve => child.once('exit', resolve)); assert.equal(exitCode, 0, 'Cold process failed; inspect metered status, no provider exception text retained');
      const coldResult = JSON.parse(await readFile(childResult, 'utf8')); assert.notEqual(coldResult.pid, process.pid);
      const childCalls = JSON.parse(await readFile(evidencePath, 'utf8')).calls.slice(callsBefore);
      const coldChecks = { actualNewProcess: coldResult.pid !== process.pid, noSummaryRegeneration: childCalls.length === 1, answer: coldResult.passed };
      Object.assign(caseResult, { cold: coldResult, coldChecks, passed: rounds.length === spec.rounds && rounds.every(round => round.passed) && Object.values(coldChecks).every(Boolean) });
      const completedCase = JSON.parse(await readFile(evidencePath, 'utf8')); completedCase.results = results; await saveAttempt(evidencePath, completedCase);
      } catch (error) { caseResult.error = safeFailure(error); if (JSON.parse(await readFile(evidencePath, 'utf8')).stopped) throw error; }
    }
  } catch (cause) { error = safeFailure(cause); }
  const report = JSON.parse(await readFile(evidencePath, 'utf8'));
  report.results = results; await saveAttempt(evidencePath, report);
  Object.assign(report, { results, summary: summarizeBatch(results), error, finishedAt: new Date().toISOString(), passed: !error && results.length === 5 && results.every(result => result.suite === 'M1' ? result.results.every(item => item.passed) : result.passed) });
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
