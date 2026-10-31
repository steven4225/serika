import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2]);
const sha = value => createHash('sha256').update(value).digest('hex');
const original = await readFile(join(directory, 'result.json'));
const report = JSON.parse(original);
assert.equal(report.status, 'failed');
assert.equal(report.stopReason, 'unexpected-telegram-inbound');
assert.equal(report.sourceWorktreeDirty, false);
assert.equal(report.calls.length, 0);
assert.equal(report.realModelCalls, 0);
assert.equal(report.costUsd, 0);
assert.equal(report.unresolvedReservedUsd, 0);
assert.equal(report.cases.length, 0);
assert.equal(report.approvalEvents.length, 0);
assert.equal(report.telegramStore.inputs.length, 0);
assert.equal(report.telegramStore.owner, null);
assert.equal(report.daily.ownerUnchanged, true);
assert.equal(report.daily.enabledAfter, true);
assert.equal(report.daily.connectionAfter, 'online');
assert.equal(report.daily.configSha256After, report.daily.configSha256Before);
assert.equal(report.daily.historicalUnknownDeliveriesAfter, report.daily.historicalUnknownDeliveriesBefore);
assert.ok(report.isolatedTelegramStoppedAt < report.daily.restoredAt);
assert.equal(report.transport.filter(row => row.direction === 'inbound-envelope').length, 1);
assert.equal(report.transport.filter(row => row.direction === 'inbound').length, 0);
assert.equal(report.transport.filter(row => row.direction === 'outbound').length, 0);
const state = JSON.parse(await readFile(join(directory, 'herdr-state.json'), 'utf8'));
assert.equal(state.unknown, false);
assert.equal(state.phase, 'ready');
assert.deepEqual(state.operations.map(row => row.phase), ['workspace-create', 'pi-start', 'pane-split', 'second-pi-start']);
const piMessages = [];
for (const file of state.piSessions) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
  const messages = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const users = messages.filter(row => row.type === 'message' && row.message?.role === 'user');
  assert.equal(users.length, 0);
  piMessages.push({ file, transcriptPresent: !!text, userInputs: users.length, sha256: text ? sha(text) : null });
}
const restore = JSON.parse(await readFile(join(directory, 'daily-restoration-check.json'), 'utf8'));
assert.equal(restore.pid, report.daily.pid);
assert.equal(restore.enabled, true);
assert.equal(restore.connection, 'online');
assert.equal(restore.ownerBound, true);
assert.equal(restore.configSha256, report.daily.configSha256Before);
assert.equal(restore.unknownDeliveries, report.daily.historicalUnknownDeliveriesBefore);
let harnessAlive = false;
try { process.kill(Number(process.argv[3]), 0); harnessAlive = true; }
catch (error) { if (error.code !== 'ESRCH') throw error; }
assert.equal(harnessAlive, false);
const audit = { auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'read-only-failed-telegram-batch-stop-audit',
  acceptance: 'failed-before-telegram-pairing', batchId: report.batchId, sourceCommit: report.sourceCommit, sourceResultSha256: sha(original),
  sourceResultUnmodified: true, modelRequests: 0, taskRuns: 0, amount: 0, piMessages,
  inboundEnvelope: report.transport.find(row => row.direction === 'inbound-envelope'), bindingAccepted: false,
  limitation: 'Rejected inbound payload and the exact failed predicate were not archived. Envelope alone cannot establish why pairing failed.',
  shutdownError: report.errors, isolatedHarness: { pid: Number(process.argv[3]), alive: false, termination: 'SIGTERM after failed result and confirmed daily restoration; exec exit 143' },
  dailyRestored: restore, fixtureRetained: { root: state.root, session: state.session, serverPid: state.serverPid, phase: state.phase },
  uncovered: ['telegram-pairing', 'same-run-selection', 'adopted-tool-contract', 'operation-approval', 'single-dispatch', 'readback', 'artifact-verification'] };
assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
await writeFile(join(directory, 'stop-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ acceptance: audit.acceptance, modelRequests: 0, taskRuns: 0, amount: 0, dailyRestored: true, resultUnmodified: true }));
