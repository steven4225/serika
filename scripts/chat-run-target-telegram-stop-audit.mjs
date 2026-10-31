import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');

export async function writeTelegramStopAudit({ directory }) {
  const original = await readFile(join(directory, 'result.json'));
  const report = JSON.parse(original);
  assert.equal(report.status, 'failed');
  assert.ok(Array.isArray(report.inboundChecks), 'Current harness must persist per-update diagnostics');
  for (const row of report.inboundChecks) {
    assert.ok(Object.hasOwn(row, 'update') && row.predicates?.length && row.bindingBefore && row.bindingAfter);
    assert.deepEqual(row.failedPredicates, row.predicates.filter(predicate => !predicate.passed).map(predicate => predicate.id));
    assert.equal(row.failedPredicate, row.failedPredicates[0] ?? null);
    assert.equal(row.accepted, row.failedPredicates.length === 0);
    if (!row.accepted) assert.equal(row.forwarded, false);
  }
  const audit = { auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'failed-telegram-batch-diagnostics-from-original-result',
    acceptance: 'failed-telegram-batch', batchId: report.batchId, sourceCommit: report.sourceCommit,
    sourceResultSha256: sha(original), sourceResultUnmodified: true, stopReason: report.stopReason, failure: report.failure,
    modelRequests: report.calls.length, taskRuns: new Set(report.cases.flatMap(row => [row.runId, row.receipt?.runId]).filter(Boolean)).size,
    amount: report.costUsd, unresolvedReservedUsd: report.unresolvedReservedUsd,
    inboundChecks: report.inboundChecks, telegramIdentity: report.telegramIdentity ?? null, pollFailure: report.pollFailure ?? null,
    bindingAtPairingStart: report.bindingAtPairingStart ?? null, pairingConfirmation: report.pairingConfirmation ?? null,
    bindingBeforeShutdown: report.bindingBeforeShutdown ?? null, bindingAfterShutdown: report.bindingAfterShutdown ?? null,
    telegramStore: report.telegramStore ?? null, transportCursorHandoff: report.transportCursorHandoff ?? null,
    shutdownErrors: report.errors, isolatedHostStoppedAt: report.isolatedHostStoppedAt ?? null,
    isolatedTelegramStoppedAt: report.isolatedTelegramStoppedAt ?? null, daily: report.daily ?? null,
    receipts: report.cases.map(row => ({ runId: row.runId ?? row.receipt?.runId ?? null, receipt: row.receipt ?? null })),
    fixtureRetained: report.fixture?.statePath ?? null };
  assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
  await writeFile(join(directory, 'stop-audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  const audit = JSON.parse(await readFile(join(directory, 'stop-audit.json'), 'utf8'));
  const original = await readFile(join(directory, 'result.json'));
  const report = JSON.parse(original);
  assert.equal(report.status, 'failed');
  assert.equal(sha(original), audit.sourceResultSha256);
  assert.deepEqual(audit.inboundChecks, report.inboundChecks);
  assert.deepEqual(audit.bindingBeforeShutdown, report.bindingBeforeShutdown ?? null);
  assert.deepEqual(audit.bindingAfterShutdown, report.bindingAfterShutdown ?? null);
  console.log(JSON.stringify({ acceptance: audit.acceptance, resultUnmodified: true, rejectedUpdates: audit.inboundChecks.filter(row => !row.accepted).length }));
}
