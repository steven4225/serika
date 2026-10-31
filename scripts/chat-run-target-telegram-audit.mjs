import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { approvalChain } from '../apps/desktop/scripts/chat-run-target-approval.mjs';

const directory = resolve(process.argv[2]);
const sha = value => createHash('sha256').update(value).digest('hex');
const original = await readFile(join(directory, 'result.json'));
const report = JSON.parse(original);
assert.equal(report.status, 'passed');
assert.equal(report.verification, 'real-telegram-original-node-desktop-runtime-real-model-isolated-herdr-pi');
assert.equal(report.pairing.originalGatewayAccepted, true);
assert.equal(report.pairing.ownerMatchesDaily, true);
assert.equal(report.daily.enabledBefore, true);
assert.equal(report.daily.enabledAfter, true);
assert.equal(report.daily.connectionAfter, 'online');
assert.equal(report.daily.ownerUnchanged, true);
assert.equal(report.daily.transportOffsetAcknowledged, true);
assert.equal(report.daily.configSha256Before, report.daily.configSha256After);
assert.equal(report.daily.historicalUnknownDeliveriesBefore, report.daily.historicalUnknownDeliveriesAfter);
assert.ok(report.isolatedTelegramStoppedAt < report.daily.restoredAt);
assert.equal(report.sourceWorktreeDirty, false);
assert.equal(report.unknownEffect ?? false, false);
assert.equal(report.cases.length, 1);
assert.equal(report.unresolvedReservedUsd, 0);
assert.deepEqual(report.errors, []);
const pi = report.cases[0];
assert.equal(pi.status, 'passed');
assert.equal(pi.receipt.runId, pi.runId);
assert.equal(pi.receipt.status, 'completed');
assert.ok(pi.receipt.tools.every(tool => tool.status === 'completed' && !tool.inputTruncated && !tool.resultTruncated));
assert.equal(pi.receipt.trace.incomplete, false);
const selections = pi.hostDecisions.filter(row => row.kind === 'selection');
assert.equal(selections.length, 1);
const selection = selections[0];
assert.equal(selection.response.accepted, true);
assert.equal(selection.runId, pi.runId);
assert.equal(selection.source, 'runtime-bridge');
assert.ok(selection.value.candidates.length >= 2);
assert.ok(selection.value.candidates.every(candidate => candidate.status === 'idle'));
const selected = selection.value.candidates.find(candidate => candidate.candidateId === selection.input.candidateId);
assert.ok(selected);
const shown = report.approvalEvents.filter(row => row.type === 'herdr-selection' && row.runId === pi.runId);
assert.equal(shown.length, 1);
assert.equal(shown[0].selection.toolCallId, selection.toolCallId);
assert.equal(shown[0].selection.selectionId, selection.input.selectionId);
const inbound = report.transport.filter(row => row.direction === 'inbound');
const selectionMessage = inbound.filter(row => /^选择\s/.test(row.update.message.text));
assert.equal(selectionMessage.length, 1);
const selectedCode = /^选择\s+([A-F0-9]{10})\s+([1-9][0-9]*)$/i.exec(selectionMessage[0].update.message.text);
assert.ok(selectedCode);
assert.equal(selection.value.candidates[Number(selectedCode[2]) - 1].candidateId, selected.candidateId);
const card = report.telegramStore.deliveries.find(row => row.key === `selection:${selection.input.selectionId}:${selectedCode[1].toUpperCase()}`);
assert.equal(card?.state, 'submitted');
assert.ok(report.transport.some(row => row.direction === 'outbound' && row.status === 'submitted' && row.messageId === card.messageId && row.text === card.text));
assert.equal(selection.telegramInbound.updateId, selectionMessage[0].update.update_id);
assert.equal(selection.telegramInbound.text, selectionMessage[0].update.message.text);
assert.equal(selectionMessage[0].update.message.from.id, report.telegramStore.owner.userId);
assert.equal(selectionMessage[0].update.message.chat.id, report.telegramStore.owner.chatId);
assert.equal(report.telegramStore.inputs.filter(row => row.runId && !row.steerId).length, 1);
const task = report.telegramStore.inputs.find(row => row.runId === pi.runId);
assert.equal(task.state, 'finished');
assert.equal(task.text, pi.prompt);
assert.equal(inbound.filter(row => row.update.message.text === pi.prompt).length, 1);
assert.equal(report.telegramStore.deliveries.find(row => row.key === `result:${task.key}`)?.state, 'submitted');
assert.ok(report.lastPollOffset >= report.telegramStore.offset || report.transportCursorHandoff?.offset >= report.telegramStore.offset);
for (const decision of pi.hostDecisions.filter(row => row.kind === 'approval')) {
  assert.equal(decision.response.accepted, true);
  const source = inbound.find(row => row.update.update_id === decision.telegramInbound?.updateId);
  assert.ok(source);
  const allow = /^允许\s+([A-F0-9]{10})$/i.exec(source.update.message.text);
  assert.ok(allow);
  assert.equal(source.update.message.from.id, report.telegramStore.owner.userId);
  assert.equal(source.update.message.chat.id, report.telegramStore.owner.chatId);
  const preview = report.telegramStore.deliveries.find(row => row.key === `approval:${decision.approvalId}:${allow[1].toUpperCase()}`);
  assert.equal(preview?.state, 'submitted');
  assert.ok(report.transport.some(row => row.direction === 'outbound' && row.status === 'submitted' && row.messageId === preview.messageId && row.text === preview.text));
  assert.equal(decision.telegramInbound.text, source.update.message.text);
}
assert.equal(report.calls.filter(call => call.startedAt > shown[0].at && call.startedAt < selection.at).length, 0);

let amount = 0;
const contexts = [];
for (const call of report.calls) {
  const request = JSON.parse(await readFile(join(directory, `request-${call.sequence}.json`), 'utf8'));
  const response = await readFile(join(directory, `response-${call.sequence}.txt`));
  assert.equal(sha(JSON.stringify(request)), call.requestSha256);
  assert.equal(sha(response), call.responseSha256);
  assert.equal(call.status, 'returned');
  assert.equal(call.httpStatus, 200);
  const frames = request.stream ? response.toString().split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(response.toString())];
  const usage = frames.findLast(frame => frame.usage).usage;
  assert.equal(usage.prompt_tokens, call.usage.input);
  assert.equal(usage.completion_tokens, call.usage.output);
  assert.equal(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0, call.usage.cacheRead);
  const { input, output, cacheRead } = call.usage, price = report.pricePerMillionUsd;
  const cost = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + output * price.output) / 1e6;
  assert.equal(cost, call.costUsd);
  amount += cost;
  if (call.caller !== 'serika') continue;
  const system = request.messages.filter(message => message.role === 'system' && typeof message.content === 'string').map(message => message.content).join('\n');
  if (system.startsWith('You are a context compactor.')) {
    assert.equal(request.tools, undefined);
    contexts.push({ sequence: call.sequence, purpose: 'compaction', requestSha256: call.requestSha256 });
    continue;
  }
  assert.ok(Array.isArray(request.tools), 'Every primary request needs its actual tool definitions');
  const names = request.tools.map(tool => tool.function.name);
  const adopted = call.startedAt > selection.at;
  assert.equal(names.includes('herdr_pi_discover'), !adopted);
  assert.ok(names.includes('herdr_pi_read') && names.includes('herdr_pi_control'));
  if (adopted) {
    assert.ok(system.includes('"adoptedTarget":{"target":'));
    assert.ok(system.includes(JSON.stringify(selected.target)));
    assert.ok(system.includes('"selectionVersion":1'));
  }
  contexts.push({ sequence: call.sequence, purpose: 'primary', adopted, discoverOffered: names.includes('herdr_pi_discover'), requestSha256: call.requestSha256 });
}
assert.ok(Math.abs(amount - report.costUsd) < 1e-12);
assert.ok(report.calls.length <= report.maxRequests && amount <= report.capUsd && report.cases.length <= report.maxRuns);
assert.equal(contexts.filter(row => row.purpose === 'primary').length, pi.receipt.trace.steps);
assert.ok(contexts.some(row => row.adopted));
const raw = report.approvalEvents.filter(row => row.type === 'event').map(row => row.event);
assert.ok(raw.every(event => event.runId === pi.runId));
assert.equal(raw.filter(event => event.type === 'tool.call.failed' || event.type === 'tool.call.completed' && event.data.output?.ok === false).length, 0);
assert.equal(pi.receipt.tools.filter(tool => tool.toolName === 'herdr_pi_discover').length, 1);
const controls = pi.receipt.tools.filter(tool => tool.toolName === 'herdr_pi_control');
assert.equal(controls.length, 1);
const chain = approvalChain({ runId: pi.runId, receipt: pi.receipt, events: report.approvalEvents, decisions: pi.hostDecisions.filter(row => row.kind === 'approval') });
const approved = chain.filter(row => row.approvalId);
assert.equal(approved.length, 1);
assert.equal(approved[0].dispatched, true);
assert.deepEqual(approved[0].frozen.target, selected.target);
assert.equal(approved[0].frozen.selectionVersion, 1);
assert.deepEqual(approved[0].frozen.action, JSON.parse(controls[0].inputPreview));
const state = JSON.parse(await readFile(join(directory, 'herdr-state.json'), 'utf8'));
const index = state.targets.findIndex(target => JSON.stringify(target) === JSON.stringify(selected.target));
assert.ok(index >= 0);
let userInputs = 0;
for (let i = 0; i < state.targets.length; i++) {
  let text;
  try { text = await readFile(join(directory, `pi-${i + 1}.jsonl`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && i !== index) continue; throw error; }
  const users = text.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message' && row.message?.role === 'user');
  assert.equal(users.length, i === index ? 1 : 0);
  if (i === index) {
    assert.equal(users[0].message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), approved[0].frozen.action.text);
    userInputs = users.length;
  }
}
const expected = { sum: 14, order: report.batchId.slice(0, 8) + '-blue' };
assert.deepEqual(pi.actualArtifact, expected);
const reads = raw.filter(event => event.type === 'tool.call.completed' && event.data.toolName === 'herdr_pi_read' && event.data.output.value?.text);
assert.ok(reads.some(event => event.data.output.value.text.includes(expected.order) && event.occurredAt > controls[0].finishedAt));
const artifact = raw.find(event => event.type === 'tool.call.completed' && event.data.toolName === 'read_file' && event.data.output.path === 'blue-answer.json');
assert.ok(artifact && artifact.occurredAt > controls[0].finishedAt);
assert.deepEqual(JSON.parse(artifact.data.output.content), expected);
assert.equal(report.cases.length, 1);
assert.ok(report.calls.length > 0);
assert.equal(state.unknown, false);
assert.equal(report.cleanup.phase, 'cleaned');
assert.equal(report.temporaryDirectoryRemoved, true);
const audit = { auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'independent-current-run-contract-raw-evidence-audit',
  acceptance: 'passed-telegram-stage1', sourceResultSha256: sha(original), sourceResultUnmodified: true, sourceCommit: report.sourceCommit,
  runId: pi.runId, batchId: report.batchId, contexts, acceptedSelections: selections.length, selectionVersion: approved[0].frozen.selectionVersion,
  approvalChain: chain, promptDispatches: controls.length, piUserInputs: userInputs, unchosenPiInputs: 0, artifact: expected,
  realModelRequests: report.calls.length, callers: Object.fromEntries(['serika', 'pi'].map(caller => [caller, report.calls.filter(call => call.caller === caller).length])),
  amount, amountBasis: report.priceBasis, unresolvedCalls: 0, unresolvedReservedUsd: 0, uncovered: ['compaction-specific-acceptance', 'daily-deployment'] };
assert.equal(sha(await readFile(join(directory, 'result.json'))), audit.sourceResultSha256);
await writeFile(join(directory, 'telegram-contract-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ acceptance: audit.acceptance, requests: audit.realModelRequests, amount, runId: pi.runId }));
