import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitSummaryLayer, layerMessage, blockLimits, summaryText } from '@serika/assistant/internal/context-blocks.js';
import { estimateMessageTokens, estimateSerializedTokens } from '@serika/assistant/internal/context-budget.js';
import { effectiveCompactionFidelitySpec } from './compaction-fidelity.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd();
const dirtyPaths = git('status', '--porcelain').split('\n').filter(Boolean);
assert.ok(dirtyPaths.every(line => line.slice(3).startsWith('docs/v2-pilot/evidence/')), 'Commit source before offline audit');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'docs/v2-pilot/evidence/cm-step6/live-7c5b4116-0378-4286-afc2-ac9b00eafe0b.json';
const bytes = await readFile(join(repo, source)), previous = JSON.parse(bytes);
const spec = effectiveCompactionFidelitySpec('CE05'), limits = blockLimits(spec.contextBudget), checklistTokens = 193;
assert.equal(limits.totalSummary, 1248);
const item = text => ({ text, evidenceMessageIds: ['fidelity-contract'] });
const core = { version: 2, goal: item(spec.truth.goal), constraints: [item(spec.truth.permission + '，不能把旧工具回执当作新的读取授权')],
  decisions: [{ ...item(spec.truth.decision), source: 'user', status: 'confirmed' }], pending: [item(spec.truth.pending)], actions: [], files: [], nextStep: null };
function measure(name, summaries, indexText) {
  const record = { firstKeptMessageIndex: 73, summary: summaries.at(-1), layers: {
    index: [{ firstMessageId: 'fidelity-contract', lastMessageId: 'daily-a-0-8', timeRange: [null, null], text: indexText }],
    recent: summaries.map((summary, i) => ({ firstMessageId: `daily-u-${i}-0`, lastMessageId: `daily-a-${i}-8`, timeRange: [null, null], summary })) } };
  const before = JSON.stringify(record), fitted = fitSummaryLayer(record, limits.totalSummary - checklistTokens);
  assert.equal(JSON.stringify(record), before);
  return { name, sectionTokens: summaries.map(summary => estimateSerializedTokens(summaryText(summary))),
    indexTokens: estimateSerializedTokens(record.layers.index), storedLayerTokens: estimateMessageTokens([layerMessage(record)]),
    checklistTokens, totalBudget: limits.totalSummary, projectedTokens: estimateMessageTokens([fitted.message]) + checklistTokens,
    fits: fitted.fits, ...fitted.diagnostics };
}
const capacity = [measure('CE05 required truth repeated across four segments', Array(4).fill(core), '验收主项目早期约定；原件消息1–73'),
  measure('CE05 old nonessential file details crowd out truth', Array(4).fill({ ...core, files: [{ ...item('read receipt'), path: 'notes/fixture.txt', purpose: 'x'.repeat(300) }] }), '验收主项目早期约定；原件消息1–73')];
// Distinct essential clauses at each valid section cap cannot be deduplicated.
const saturated = Array.from({ length: 4 }, (_, i) => {
  const summary = { ...core, goal: item(`${i}:`), constraints: [], decisions: [], pending: [] };
  summary.goal.text += String(i).repeat((limits.section - estimateSerializedTokens(summaryText(summary))) * 2);
  assert.ok(estimateSerializedTokens(summaryText(summary)) <= limits.section);
  return summary;
});
capacity.push(measure('valid capped unique essential sections plus opaque index', saturated, 'index:'.repeat(40)));
const datedRecord = { firstKeptMessageIndex: 73, summary: saturated.at(-1), layers: {
  index: [{ firstMessageId: '00000000-0000-0000-0000-000000000000', lastMessageId: '10000000-0000-0000-0000-000000000000',
    timeRange: ['2026-10-20T00:00:00.000Z', '2026-10-20T12:00:00.000Z'], text: '' }],
  recent: saturated.map((summary, i) => ({ firstMessageId: `${i}0000000-0000-0000-0000-000000000000`, lastMessageId: `${i}0000000-0000-0000-0000-000000000001`,
    timeRange: ['2026-10-20T12:00:00.000Z', '2026-10-21T12:00:00.000Z'], summary })) } };
const framing = estimateSerializedTokens(datedRecord.layers.index);
datedRecord.layers.index[0].text = '索'.repeat((limits.section - framing) * 2);
const dated = fitSummaryLayer(datedRecord, limits.totalSummary - checklistTokens);
capacity.push({ name: 'valid full sections and full index with UUID ranges and timestamps', sectionTokens: saturated.map(summary => estimateSerializedTokens(summaryText(summary))),
  indexTokens: estimateSerializedTokens(datedRecord.layers.index), checklistTokens, totalBudget: limits.totalSummary,
  projectedTokens: estimateMessageTokens([dated.message]) + checklistTokens, fits: dated.fits, ...dated.diagnostics });
assert.ok(capacity.at(-1).indexTokens <= limits.section);

assert.ok(capacity[0].fits && capacity[1].fits);
const m1 = previous.results.find(result => result.suite === 'M1');
const m1Calls = previous.calls.filter(call => call.scope === 'm1');
const failures = m1.results.map((row, i) => ({ ...row, call: m1Calls[i] })).filter(row => !row.passed).map(row => ({ callId: row.call?.id, outputShape: row.call?.output, case: row.case, window: row.window,
  failedChecks: Object.keys(row.checks).filter(key => !row.checks[key]), error: row.diagnostics.error ?? null,
  outputHash: row.rows[0]?.outputHash, originalOutputRetained: false, originalExcerpt: null }));
const report = { runId: randomUUID(), generatedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'),
  scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), sourceWorktreeDirty: false, evidenceWorktreeDirty: dirtyPaths.length > 0, realModelCalls: 0, costUsd: 0,
  ledgerPath: 'docs/v2-pilot/evidence/cost-ledger.json', source, sourceSha256: sha(bytes),
  capacity, m1: { passed: m1.passed, failures, failureRows: failures.length, remainingAfterReplay: failures.filter(row => row.case !== 'replay-9').length },
  nextBatchEstimate: { basis: 'two previous full usage-metered attempts; same quoted prices; no new provider request',
    previousCalls: [122, 145], previousUsd: [0.68218348, 0.59343940], expectedUsd: [0.60, 0.85], conservativePlanningUsd: 1.0,
    currentCombinedChargedUsd: 1.29894714, proposedCombinedCapUsd: 2.5, availableAfterApprovalUsd: 2.5 - 1.29894714,
    authorizedNow: false } };
await writeFile(join(repo, 'docs/v2-pilot/evidence/cm-step6/offline-audit.json'), JSON.stringify(report, null, 2) + '\n');
const projection = { ...previous, ledgerPath: report.ledgerPath,
  projection: { source, sourceSha256: report.sourceSha256, generatedAt: report.generatedAt, sourceCommit: report.sourceCommit,
    change: 'Repository-relative ledgerPath only; original run metadata, calls, usage and scores unchanged.' } };
await writeFile(join(repo, 'docs/v2-pilot/evidence/cm-step6/live.json'), JSON.stringify(projection, null, 2) + '\n');
console.log(JSON.stringify({ runId: report.runId, capacity, m1FailureRows: failures.length, realModelCalls: 0, costUsd: 0 }));
