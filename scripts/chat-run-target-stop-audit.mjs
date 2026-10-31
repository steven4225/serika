import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(join(directory, 'result.json'));
const report = JSON.parse(original);
let amount = 0;
for (const [index, call] of report.calls.entries()) {
  const request = JSON.parse(await readFile(join(directory, `request-${index + 1}.json`), 'utf8'));
  assert.equal(sha(JSON.stringify(request)), call.requestSha256);
  assert.equal(sha(await readFile(join(directory, `response-${index + 1}.txt`))), call.responseSha256);
  assert.equal(call.status, 'returned');
  const { input, output, cacheRead } = call.usage;
  const price = report.pricePerMillionUsd;
  const cost = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + output * price.output) / 1e6;
  assert.equal(cost, call.costUsd);
  amount += cost;
}
assert.ok(Math.abs(amount - report.costUsd) < 1e-12);
for (const image of report.screenshots) assert.equal(sha(await readFile(join(directory, image.file))), image.sha256);
assert.ok(report.calls.length <= report.maxRequests && report.cases.length <= report.maxRuns && amount <= report.capUsd);
const pi = report.cases.find(item => item.name === 'multiple-pi');
const rejected = report.approvalEvents.find(row => row.type === 'event' &&
  row.event.data.toolCallId === report.rejectedToolResult.toolCallId && row.event.data.output?.ok === false).event;
const subsequentModelCalls = report.calls.filter(call => call.startedAt > rejected.occurredAt).length;
assert.equal(subsequentModelCalls, 0);
assert.equal(report.stopReason, 'non-success-tool-result');
assert.equal(report.status, 'failed');
const controls = report.approvalEvents.filter(row => row.type === 'event' && row.event.type === 'tool.call.started' &&
  row.event.data.toolName === 'herdr_pi_control');
assert.equal(controls.length, 0);
assert.equal(report.calls.filter(call => call.caller === 'pi').length, 0);
assert.equal(pi.decisions.length, 0);
const shown = report.approvalEvents.find(row => row.type === 'herdr-selection');
const cleared = report.approvalEvents.find(row => row.type === 'herdr-selection-cleared');
assert.ok(shown.selection.candidates.length >= 2);
let adopted;
for (const [index, call] of report.calls.entries()) {
  if (call.stage !== 'multiple-pi') continue;
  const request = JSON.parse(await readFile(join(directory, `request-${index + 1}.json`), 'utf8'));
  for (const message of request.messages) {
    if (typeof message.content !== 'string') continue;
    const marker = 'Current Run Pi target after host selection: ';
    const start = message.content.indexOf(marker);
    if (start < 0) continue;
    const text = message.content.slice(start + marker.length).split('. candidateId is')[0];
    const snapshot = JSON.parse(text);
    if (snapshot.adoptedTarget) adopted = { requestSequence: call.sequence, requestSha256: call.requestSha256,
      target: snapshot.adoptedTarget.target, selectionVersion: snapshot.selectionVersion };
  }
}
assert.ok(adopted);
const cli = report.cases.find(item => item.name === 'ordinary-cli');
assert.equal(cli.status, 'passed');
assert.deepEqual(cli.actualArtifact, { total: 56 });
const audit = {
  auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'post-run-failure-stop-evidence-audit',
  sourceRunId: report.runId, sourceResultSha256: sha(original), sourceResultUnmodified: true,
  originalStatus: report.status, acceptance: 'failed-pi-task-incomplete',
  realModelRequests: report.calls.length, taskRuns: report.cases.length, amount, amountBasis: report.priceBasis,
  unresolvedCalls: 0, unresolvedReservedUsd: 0, failureStopGate: 'passed', subsequentModelCalls,
  rejected: { runId: rejected.runId, toolCallId: rejected.data.toolCallId, occurredAt: rejected.occurredAt,
    error: rejected.data.output.error },
  selection: { selectionId: shown.selection.selectionId, candidates: shown.selection.candidates.length,
    shownAt: shown.at, clearedAt: cleared?.at, adopted, recordedDecisionSources: 0,
    sourceAttribution: 'unobserved; adoption does not identify actor or accepted response' },
  controlDispatches: controls.length, approvalDecisions: pi.decisions.length, piModelRequests: 0,
  ordinaryCliArtifact: cli.actualArtifact, retainedIsolatedRoot: report.isolatedRoot,
};
assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
await writeFile(join(directory, 'stop-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ acceptance: audit.acceptance, failureStopGate: audit.failureStopGate,
  requests: audit.realModelRequests, amount, subsequentModelCalls, controlDispatches: audit.controlDispatches }));
