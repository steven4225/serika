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
const selectionDecisions = report.approvalEvents.filter(row => row.type === 'herdr-selection-decision' && row.runId === pi.runId);
const approvalDecisions = report.approvalEvents.filter(row => row.type === 'approval-decision' && row.runId === pi.runId);
assert.equal(approvalDecisions.length, 0);
if (!selectionDecisions.length) assert.equal(pi.decisions.length, 0);
const shown = report.approvalEvents.find(row => row.type === 'herdr-selection');
const cleared = report.approvalEvents.find(row => row.type === 'herdr-selection-cleared');
assert.ok(shown.selection.candidates.length >= 2);
let adopted;
const modelContexts = [];
for (const [index, call] of report.calls.entries()) {
  if (call.stage !== 'multiple-pi') continue;
  const request = JSON.parse(await readFile(join(directory, `request-${index + 1}.json`), 'utf8'));
  const system = request.messages.filter(message => message.role === 'system' && typeof message.content === 'string').map(message => message.content).join('\n');
  modelContexts.push({ requestSequence: call.sequence, requestSha256: call.requestSha256,
    adoptedTargetPresent: system.includes('"adoptedTarget":{"target":'), selectionVersionOne: system.includes('"selectionVersion":1'),
    directContinuationInstructionPresent: system.includes('Once the host reports an adoptedTarget, continue directly with read/control') });
  for (const message of request.messages) {
    if (typeof message.content !== 'string') continue;
    const marker = 'Current Run Pi target after host selection: ';
    const start = message.content.indexOf(marker);
    if (start < 0) continue;
    const text = message.content.slice(start + marker.length).split(/\. (?:candidateId is|When adoptedTarget is present)/)[0];
    const snapshot = JSON.parse(text);
    if (snapshot.adoptedTarget) adopted = { requestSequence: call.sequence, requestSha256: call.requestSha256,
      target: snapshot.adoptedTarget.target, selectionVersion: snapshot.selectionVersion };
  }
}
assert.ok(adopted);
let selectionSource = { recordedDecisionSources: 0,
  sourceAttribution: 'unobserved; adoption does not identify actor or accepted response' };
if (selectionDecisions.length) {
  assert.equal(selectionDecisions.length, 1);
  const decision = selectionDecisions[0];
  assert.equal(decision.accepted, true);
  assert.equal(decision.source, 'runtime-bridge');
  assert.equal(decision.input.selectionId, shown.selection.selectionId);
  assert.equal(decision.selection.toolCallId, shown.selection.toolCallId);
  const candidate = shown.selection.candidates.find(row => row.candidateId === decision.input.candidateId);
  assert.ok(candidate); assert.deepEqual(adopted.target, candidate.target); assert.equal(adopted.selectionVersion, 1);
  const clicks = report.approvalEvents.filter(row => row.type === 'herdr-selection-click' && row.runId === pi.runId &&
    row.selectionId === decision.input.selectionId && row.candidateId === decision.input.candidateId);
  assert.equal(clicks.length, 1);
  const actor = pi.decisions.filter(row => row.kind === 'selection' && row.status === 'click-submitted' &&
    row.value.selectionId === decision.input.selectionId && row.value.candidates[row.decision.index].candidateId === decision.input.candidateId);
  assert.equal(actor.length, 1);
  assert.equal(report.calls.filter(row => row.startedAt > shown.at && row.startedAt < decision.decidedAt).length, 0);
  selectionSource = { recordedDecisionSources: 1, sourceAttribution: 'native-button-click-and-original-host-accepted-event',
    decision, click: clicks[0], actor: actor[0].actor, waitingModelCalls: 0 };
}
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
    error: rejected.data.output.error,
    request: report.approvalEvents.find(row => row.type === 'event' && row.event.type === 'tool.call.requested' && row.event.data.toolCallId === rejected.data.toolCallId)?.event.data },
  modelContexts,
  selection: { selectionId: shown.selection.selectionId, candidates: shown.selection.candidates.length,
    shownAt: shown.at, clearedAt: cleared?.at, adopted, ...selectionSource },
  controlDispatches: controls.length, approvalDecisions: approvalDecisions.length, piModelRequests: 0,
  ordinaryCliArtifact: cli.actualArtifact, retainedIsolatedRoot: report.isolatedRoot,
};
assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
await writeFile(join(directory, 'stop-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ acceptance: audit.acceptance, failureStopGate: audit.failureStopGate,
  requests: audit.realModelRequests, amount, subsequentModelCalls, controlDispatches: audit.controlDispatches }));
