import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = resolve(process.argv[2]);
const sha = data => createHash('sha256').update(data).digest('hex');
const reportBytes = await readFile(join(root, 'result.json')), report = JSON.parse(reportBytes);
const calls = report.calls.filter(row => row.status === 'returned');
let cost = 0;
for (const row of calls) {
  const u = row.usage, p = report.pricePerMillionUsd;
  const amount = ((u.input - u.cacheRead) * p.input + u.cacheRead * p.cachedInput + u.output * p.output) / 1e6;
  assert.ok(Math.abs(amount - row.costUsd) < 1e-10);
  assert.ok(amount <= row.reservedUsd); cost += amount;
}
assert.ok(Math.abs(cost - report.costUsd) < 1e-10);
assert.ok(cost + report.unresolvedReservedUsd <= report.capUsd);
const messages = report.finalHistory ?? report.turns.findLast(row => row.history)?.history ?? [];
const ids = values => [...new Set(values.filter(Boolean))];
const tools = messages.flatMap(message => message.parts.filter(part => part.type === 'dynamic-tool').map(part => ({ messageId: message.id, ...part })));
const latest = report.diagnostics.filter(row => row.data.ok).map(row => ({ stage: row.stage, ...row.data.value }));
const audit = { runId: randomUUID(), generatedAt: new Date().toISOString(), sourceRunId: report.runId, sourceSha256: sha(reportBytes), scoredByChecker: false,
  status: report.status, actualRequests: report.calls.length, returnedRequests: calls.length, costUsd: cost, unresolvedReservedUsd: report.unresolvedReservedUsd,
  compactionIds: ids(latest.map(row => row.latestValidCompaction?.id)),
  prepareFailures: latest.filter(row => row.lastPreparation?.error?.code === 'CONTEXT_PREPARE_FAILED' || row.background?.failure?.code === 'CONTEXT_PREPARE_FAILED'),
  emergencyMasking: latest.flatMap(row => (row.lastPreparation?.degradation?.emergencyMasking ?? []).map(event => ({ stage: row.stage, at: row.lastPreparation.at, ...event }))).filter((row, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(row)) === i),
  toolReceipts: tools.map(({ messageId, toolCallId, toolName, state, input, output, errorText }) => ({ messageId, toolCallId, toolName, state, input, output, errorText })),
  questionStages: report.turns.filter(row => /question/.test(row.stage)).map(row => ({ stage: row.stage, text: row.text, finished: !!row.finishedAt })),
  memoryPage: report.memoryPage ?? null, realModelCallsInThisAudit: 0 };
await writeFile(join(root, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
let dialogue = '# 完整对话原文\n\n从原 IPC 的完整 history 导出；工具部分保留原对象，不用摘要替代。\n';
for (const message of messages) {
  dialogue += `\n## ${message.role} ${message.id}\n\n`;
  for (const part of message.parts) dialogue += part.type === 'text' ? part.text + '\n\n' : '```json\n' + JSON.stringify(part, null, 2) + '\n```\n\n';
}
await writeFile(join(root, 'dialogue.md'), dialogue);
const hashes = {};
async function scan(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await scan(join(directory, entry.name), relative + '/');
    else if (entry.name !== 'manifest.json') hashes[relative] = sha(await readFile(join(directory, entry.name)));
  }
}
await scan(root);
await writeFile(join(root, 'manifest.json'), JSON.stringify({ runId: audit.runId, sourceRunId: report.runId, hashes }, null, 2) + '\n');
if (process.argv.includes('--record-ledger')) {
  const path = join(repo, 'docs/v2-pilot/evidence/cost-ledger.json'), ledger = JSON.parse(await readFile(path));
  const evidence = join(root, 'result.json').slice(join(repo, 'docs/v2-pilot/evidence/').length);
  assert.ok(!evidence.startsWith('/') && !evidence.startsWith('..'));
  const entry = { step: '4-6', runId: report.runId, realModelRequests: report.calls.length, amount: cost,
    unresolvedCalls: report.calls.length - calls.length, unresolvedReservedUsd: report.unresolvedReservedUsd, evidence, evidenceSha256: sha(reportBytes) };
  const index = ledger.entries.findIndex(row => row.runId === report.runId);
  if (index >= 0) ledger.entries[index] = entry; else ledger.entries.push(entry);
  ledger.knownTotal = ledger.openingBalance.amount + ledger.entries.reduce((n, row) => n + row.amount, 0);
  ledger.total = ledger.knownTotal + ledger.entries.reduce((n, row) => n + (row.unresolvedReservedUsd ?? 0), 0);
  assert.ok(ledger.entries.filter(row => row.step === '4-6').reduce((n, row) => n + row.amount + (row.unresolvedReservedUsd ?? 0), 0) <= ledger.limits.combinedSteps4To6);
  assert.ok(ledger.total <= ledger.limits.entirePlan);
  await writeFile(path, JSON.stringify(ledger, null, 2) + '\n');
}
console.log(JSON.stringify({ sourceRunId: report.runId, actualRequests: audit.actualRequests, costUsd: cost, compactions: audit.compactionIds.length, prepareFailures: audit.prepareFailures.length, toolReceipts: audit.toolReceipts.map(row => [row.toolName, row.state]), status: audit.status }));
