import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { approvalChain } from '../apps/desktop/scripts/chat-run-target-approval.mjs';

const directory = resolve(process.argv[2]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(join(directory, 'result.json'));
const report = JSON.parse(original);
let amount = 0;
for (const [index, call] of report.calls.entries()) {
  const response = await readFile(join(directory, `response-${index + 1}.txt`));
  assert.equal(sha(response), call.responseSha256);
  const request = JSON.parse(await readFile(join(directory, `request-${index + 1}.json`), 'utf8'));
  assert.equal(sha(JSON.stringify(request)), call.requestSha256);
  assert.equal(call.status, 'returned');
  const frames = request.stream ? response.toString().split('\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => JSON.parse(line.slice(6))) : [JSON.parse(response.toString())];
  const usage = frames.findLast(frame => frame.usage).usage;
  assert.equal(usage.prompt_tokens, call.usage.input);
  assert.equal(usage.completion_tokens, call.usage.output);
  const { input, output, cacheRead } = call.usage;
  const price = report.pricePerMillionUsd;
  const cost = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + output * price.output) / 1e6;
  assert.equal(cost, call.costUsd);
  amount += cost;
}
assert.ok(Math.abs(amount - report.costUsd) < 1e-12);
assert.ok(report.calls.length <= report.maxRequests && report.cases.length <= report.maxRuns && amount <= report.capUsd);
for (const image of report.screenshots) assert.equal(sha(await readFile(join(directory, image.file))), image.sha256);

const pi = report.cases.find(item => item.name === 'multiple-pi');
const selection = pi.decisions.filter(item => item.kind === 'selection');
assert.equal(selection.length, 1);
assert.equal(selection[0].status, 'accepted');
assert.equal(selection[0].response.accepted, true);
assert.equal(selection[0].runId, pi.runId);
assert.ok(selection[0].value.candidates.length >= 2);
const hold = JSON.parse(await readFile(join(directory, 'selection-hold.json'), 'utf8'));
assert.equal(hold.selectionId, selection[0].value.selectionId);
assert.equal(hold.runId, pi.runId);
const selected = selection[0].value.candidates[selection[0].decision.index].target;
const controls = pi.receipt.tools.filter(tool => tool.toolName === 'herdr_pi_control');
assert.equal(controls.length, 1);
assert.equal(controls[0].status, 'completed');
const decisions = pi.decisions.filter(row => row.kind === 'approval')
  .map(row => ({ ...row, decision: row.decision.decision }));
const chain = approvalChain({ runId: pi.runId, receipt: pi.receipt, events: report.approvalEvents, decisions });
const explicit = chain.filter(row => row.approvalId);
assert.equal(explicit.length, 1);
assert.equal(explicit[0].accepted, true);
assert.equal(explicit[0].dispatched, true);
assert.deepEqual(explicit[0].frozen.target, selected);
assert.deepEqual(explicit[0].frozen.action, JSON.parse(controls[0].inputPreview));
const users = (await readFile(join(directory, 'pi-2.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  .filter(row => row.type === 'message' && row.message?.role === 'user');
assert.equal(users.length, 1);
assert.equal(users[0].message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), explicit[0].frozen.action.text);
const expected = { sum: 14, order: report.runId.slice(0, 8) + '-blue' };
assert.deepEqual(pi.actualArtifact, expected);
const reads = pi.receipt.tools.filter(tool => tool.toolName === 'read_file' && tool.status === 'completed')
  .map(tool => JSON.parse(tool.resultPreview));
assert.deepEqual(JSON.parse(reads.find(result => result.path === 'blue-answer.json').content), expected);
assert.ok(pi.receipt.tools.some(tool => tool.toolName === 'herdr_pi_read' && tool.status === 'completed'));
const cli = report.cases.find(item => item.name === 'ordinary-cli');
assert.deepEqual(cli.actualArtifact, { total: 56 });
assert.ok(cli.receipt.tools.some(tool => tool.toolName === 'shell_exec' && tool.shell?.exitCode === 0));
assert.ok(!cli.receipt.tools.some(tool => tool.toolName === 'terminal_exec'));

const unexpectedRejections = report.approvalEvents.filter(row => row.type === 'event' &&
  (row.event.type === 'tool.call.failed' || row.event.type === 'tool.call.completed' && row.event.data.output?.ok === false))
  .map(row => ({ runId: row.event.runId, toolCallId: row.event.data.toolCallId, toolName: row.event.data.toolName,
    occurredAt: row.event.occurredAt, error: row.event.data.error ?? row.event.data.output.error,
    subsequentModelCalls: report.calls.filter(call => call.startedAt > row.event.occurredAt).length }));
const audit = {
  auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'stage1-post-run-raw-evidence-audit',
  sourceResultSha256: sha(original), sourceRunId: report.runId, originalStatus: report.status, sourceResultUnmodified: true,
  sourceCommit: report.sourceCommit, realModelRequests: report.calls.length, taskRuns: report.cases.length,
  callers: Object.fromEntries(['serika', 'pi'].map(caller => [caller, report.calls.filter(call => call.caller === caller).length])),
  amount, amountBasis: report.priceBasis, unresolvedCalls: 0, unresolvedReservedUsd: 0,
  evidenceChainAssertions: 'passed', acceptedSelections: selection.length, explicitControlApprovals: explicit.length,
  dispatchedPrompts: controls.length, piUserInputs: users.length, approvalChain: chain,
  ordinaryCliArtifact: cli.actualArtifact, piArtifact: pi.actualArtifact,
  unexpectedRejections, failureStopGate: unexpectedRejections.length ? 'failed' : 'passed',
  acceptance: unexpectedRejections.length ? 'incomplete-failure-stop-not-enforced' : 'passed',
  uncovered: ['real-telegram', 'real-model-compaction', 'daily-deployment'],
};
assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
await writeFile(join(directory, 'stage1-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ acceptance: audit.acceptance, evidenceChainAssertions: audit.evidenceChainAssertions,
  requests: audit.realModelRequests, amount, unexpectedRejections }));
if (audit.acceptance !== 'passed') process.exitCode = 1;
