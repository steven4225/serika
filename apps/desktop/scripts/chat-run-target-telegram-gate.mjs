import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { DesktopRuntime } from '../src/main/desktop-runtime.ts';
import { TelegramGateway } from '../src/main/telegram-gateway.ts';
import { TelegramStore } from '../src/main/telegram-store.ts';
import { setup, addPi, cleanup } from './chat-run-target-live-herdr.mjs';
import { approvalChain } from './chat-run-target-approval.mjs';
import { inspectTelegramInbound, limitTelegramRuns } from './chat-run-target-telegram-inbound.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { MockLanguageModelV3 } = await import(pathToFileURL(require.resolve('ai/test')));
const { simulateReadableStream } = await import(pathToFileURL(require.resolve('ai')));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const outputIndex = process.argv.indexOf('--output');
assert.ok(outputIndex >= 0 && process.argv[outputIndex + 1], '--output is required');
const output = resolve(process.argv[outputIndex + 1]);
assert.ok(!output.startsWith(repo + '/') && output !== repo);
await mkdir(output);
const root = await mkdtemp('/private/tmp/g197-');
const report = { batchId: randomUUID(), startedAt: new Date().toISOString(), verification: 'real-herdr-real-host-scripted-model-fake-telegram',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceWorktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  root, platform: process.platform, node: process.version, status: 'failed', realModelCalls: 0, realTelegramCalls: 0, costUsd: 0,
  modelCalls: 0, piRequests: [], transport: [], inboundChecks: [], approvalEvents: [], cases: [{ hostDecisions: [] }], checks: [], errors: [] };
let host, store, gateway, fixture, secondPi, taskMessageId, frozen, activeInbound, releaseRead;
let saveTail = Promise.resolve();
const save = () => { const text = JSON.stringify(report, null, 2) + '\n'; saveTail = saveTail.then(() => writeFile(join(output, 'result.json'), text)); return saveTail; };
const stop = reason => { frozen ??= reason; report.stopReason ??= reason; };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, name, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(!frozen, frozen); assert.ok(Date.now() < deadline, name); await delay(20); }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External fetch forbidden by offline gate'); };
report.sourceHashes = Object.fromEntries(await Promise.all(['chat-run-target-telegram-gate.mjs', 'chat-run-target-telegram-live.mjs', 'chat-run-target-telegram-inbound.mjs', 'chat-run-target-live-herdr.mjs', 'chat-run-target-approval.mjs'].map(async file =>
  [file, createHash('sha256').update(await readFile(join(repo, 'apps/desktop/scripts', file))).digest('hex')])));
const nonce = report.batchId.slice(0, 8), expected = { sum: 14, order: `${nonce}-blue` };
const prompt = `请找一个现有 Pi，根据 blue.json 把 a 与 b 的和及原 order 写入 blue-answer.json，字段为 sum 和 order。完成后你亲自读文件核对。本批标识：${nonce}。`;
function reply(tool, text = '') {
  return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...(tool ? [
    { type: 'tool-call', toolCallId: `gate-${report.modelCalls}`, toolName: tool.name, input: JSON.stringify(tool.input) },
  ] : [{ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: text }, { type: 'text-end', id: 'text' }]),
  { type: 'finish', finishReason: { unified: tool ? 'tool-calls' : 'stop', raw: undefined }, usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
  } }] }) };
}
const proxy = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/pi/v1/chat/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), sequence = report.piRequests.length + 1;
    report.piRequests.push({ sequence, body });
    let tool, text;
    if (sequence === 1) tool = { name: 'read', arguments: JSON.stringify({ path: 'blue.json' }) };
    else if (sequence === 2) {
      const read = body.messages.findLast(message => message.role === 'tool');
      assert.ok(read, 'Pi must supply its actual read result');
      const content = typeof read.content === 'string' ? read.content : read.content.map(item => item.text ?? '').join('\n');
      const source = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
      assert.deepEqual(source, { a: 5, b: 9, order: expected.order });
      tool = { name: 'write', arguments: JSON.stringify({ path: 'blue-answer.json', content: JSON.stringify({ sum: source.a + source.b, order: source.order }) + '\n' }) };
    } else if (sequence === 3) {
      assert.ok(body.messages.some(message => message.role === 'tool'));
      text = `已写入 blue-answer.json，sum=14，order=${expected.order}。`;
    } else throw new Error('Unexpected extra Pi request');
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `pi-${sequence}`, type: 'function', function: tool }] }
      : { role: 'assistant', content: text };
    await save();
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `pi-${sequence}`, type: 'function', function: tool }] } : { role: 'assistant', content: text };
      for (const [part, finish] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: `pi-${sequence}`, object: 'chat.completion.chunk', created: 1, model: 'offline-gate', choices: [{ index: 0, delta: part, finish_reason: finish }], usage: finish ? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } : undefined })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `pi-${sequence}`, object: 'chat.completion', created: 1, model: 'offline-gate', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
  } catch (error) { report.errors.push({ stage: 'pi-proxy', message: error.message }); stop('pi-proxy-failed'); res.writeHead(500); res.end('Offline script failed'); }
});
function binding() {
  const data = store.snapshot(), state = host.channelSnapshot().snapshot.state;
  return { owner: data.owner, pairing: gateway.status().pairing, botId: data.botId, threadId: host.info().threadId,
    offset: data.offset, state: state.kind, runId: state.kind === 'running' ? state.runId : null };
}
let updateId = 0, messageId = 1000;
const textUpdate = (text, userId = 42, id = ++messageId) => ({ update_id: ++updateId,
  message: { message_id: id, date: 1, text, from: { id: userId, is_bot: false }, chat: { id: 42, type: 'private' } } });
const callback = (card, { userId = 42, id = `cb-${randomUUID()}`, message = card.messageId } = {}) => ({ update_id: ++updateId,
  callback_query: { id, data: card.keyboard.inline_keyboard[0][0].callback_data, from: { id: userId, is_bot: false },
    message: { message_id: message, from: { id: 123456, is_bot: true }, chat: { id: 42, type: 'private' } } } });
let pendingPoll;
const queued = [], completedUpdates = new Set();
async function feedBatch(updates) {
  queued.push(...updates); pendingPoll?.();
  await until(() => updates.every(update => completedUpdates.has(update.update_id)), 'fake Telegram update batch not processed');
}
const feed = update => feedBatch([update]);
const approvalCards = () => report.transport.filter(row => row.keyboard);
const currentCard = async () => {
  let card;
  await until(() => {
    const pending = host.channelSnapshot().snapshot.pendingApproval;
    const delivery = pending && store.snapshot().deliveries.findLast(item => item.key.startsWith(`approval:${pending.approvalId}:`) && item.state === 'submitted');
    card = delivery && approvalCards().find(row => row.messageId === delivery.messageId);
    return !!card;
  }, 'approval card not submitted');
  return card;
};
try {
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  fixture = await setup(root, `http://127.0.0.1:${proxy.address().port}/pi/v1`, 'offline-gate');
  secondPi = await addPi(fixture.statePath);
  await writeFile(join(fixture.work, 'blue.json'), JSON.stringify({ a: 5, b: 9, order: expected.order }));
  const config = join(root, 'config.json'), applicationHome = join(root, 'profile');
  await writeFile(config, JSON.stringify({ version: 2, projectDirectory: fixture.work, authorizedDirectories: [{ path: fixture.work, access: 'readwrite' }],
    modules: { 'read-file': { enabled: true }, terminal: { enabled: true }, memory: { enabled: false }, shell: { enabled: false } }, run: { maxSteps: 16, totalTimeoutMs: 120000 } }));
  const live = await readFile(join(repo, 'apps/desktop/scripts/chat-run-target-telegram-live.mjs'), 'utf8');
  const start = live.indexOf('function observe(message) {'), end = live.indexOf('\ntry {', start);
  assert.ok(start >= 0 && end > start);
  const observer = vm.createContext({ host: undefined, runId: undefined, report, activeInbound: undefined, Date, save, stop });
  vm.runInContext(live.slice(start, end), observer);
  const proceed = new Promise(done => { releaseRead = done; });
  host = await DesktopRuntime.create({ applicationHome, cwd: fixture.work, env: { ...fixture.env, RUNLOOM_CONFIG: config, RUNLOOM_DESKTOP_TEST: '1' }, modelAlias: 'mock',
    model: new MockLanguageModelV3({ doStream: async ({ tools }) => {
      const n = ++report.modelCalls;
      assert.equal(tools.some(tool => tool.name === 'herdr_pi_discover'), n === 1, 'adoption must narrow tools');
      if (n === 1) return reply({ name: 'herdr_pi_discover', input: {} });
      if (n === 2) return reply({ name: 'herdr_pi_control', input: { action: 'prompt', text: prompt } });
      if (n === 3) {
        await proceed;
        await until(async () => {
          if (report.piRequests.length !== 3) return false;
          const sessions = await Promise.all([fixture.piSession, secondPi.piSession].map(path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })));
          return sessions.some(text => text.includes(expected.order) && text.includes('已写入 blue-answer.json'));
        }, 'Pi actual write/final reply not complete');
        return reply({ name: 'herdr_pi_read', input: { action: 'read' } });
      }
      if (n === 4) return reply({ name: 'read_file', input: { path: 'blue-answer.json' } });
      assert.equal(n, 5); return reply(undefined, `独立核查完成 ${expected.order}`);
    } }), send: message => { observer.activeInbound = activeInbound; observer.observe(message); } });
  observer.host = host;
  host.channelRun = limitTelegramRuns({ run: host.channelRun.bind(host), taskText: prompt, maxRuns: 1, stop });
  store = new TelegramStore(join(applicationHome, 'resident/telegram.json'), applicationHome); await store.load();
  const api = { identity: async () => ({ id: 123456, username: 'offline_gate' }), webhook: async () => ({ url: '' }), close: async () => {},
    updates: async (_offset, signal) => {
      if (!queued.length && !signal.aborted) await new Promise(done => { const finish = () => { pendingPoll = undefined; signal.removeEventListener('abort', finish); done(); }; pendingPoll = finish; signal.addEventListener('abort', finish, { once: true }); });
      const batch = queued.splice(0), snapshot = binding();
      for (const [indexInPoll, update] of batch.entries()) {
        const row = inspectTelegramInbound({ update, context: { owner: { userId: 42, chatId: 42 }, pollId: randomUUID(), indexInPoll,
          pairingCode: gateway.status().pairing?.code, taskText: prompt, taskMessageId }, binding: snapshot });
        report.inboundChecks.push(row);
        if (!row.accepted) stop('offline-inbound-rejected');
        assert.equal(row.accepted, true, `Harness rejected update before original gateway: ${row.failedPredicates}`);
        if (update.message?.text === prompt) taskMessageId ??= update.message.message_id;
      }
      return batch;
    },
    send: async (chatId, text, _signal, format, keyboard) => { const row = { direction: 'outbound', chatId, text, format, keyboard, messageId: report.transport.length + 1, status: 'submitted' }; report.transport.push(row); return row.messageId; },
    answerCallback: vm.runInNewContext(`(${live.match(/answerCallback: (\(id, signal\) => realApi\.answerCallback\(id, signal\))/)?.[1] ?? 'undefined'})`, { realApi: { answerCallback: async id => { report.transport.push({ direction: 'answer-callback', id }); } } }) };
  assert.equal(typeof api.answerCallback, 'function', 'live callback transport wrapper missing');
  gateway = new TelegramGateway(host, store, api); host.attachTelegram(gateway); await gateway.initialize();
  const receive = gateway.receive.bind(gateway);
  gateway.receive = async update => { activeInbound = update; const row = report.inboundChecks.findLast(item => item.update?.update_id === update.update_id); row.forwarded = true;
    try { return await receive(update); } finally { row.bindingAfter = binding(); row.safeToAcknowledge = row.bindingAfter.offset > update.update_id; activeInbound = undefined; completedUpdates.add(update.update_id); } };
  await gateway.setEnabled(true);
  const pair = gateway.beginPairing().pairing; await feed(textUpdate(`/start ${pair.code}`));
  await gateway.confirmPairing(pair.code);
  await feed(textUpdate('允许 ABCDEF1234'));
  await feed(textUpdate('/confirm'));
  await feed(callback({ messageId: 1, keyboard: { inline_keyboard: [[{ callback_data: 'allow:ABCDEF1234' }]] } }));
  assert.equal(report.modelCalls, 0); assert.equal(report.piRequests.length, 0);
  assert.equal(store.snapshot().inputs.filter(item => item.runId).length, 0);
  const task = textUpdate(prompt); await feed(task);
  await until(() => store.snapshot().deliveries.some(item => item.key.startsWith('selection:') && item.state === 'submitted'), 'real selection card absent');
  const selection = host.channelSnapshot().snapshot.pendingHerdrSelection;
  assert.equal(selection.candidates.length, 2); assert.equal(report.modelCalls, 1); assert.equal(report.piRequests.length, 0);
  const source = store.snapshot().inputs.find(item => item.key === `42:${task.message.message_id}`);
  assert.ok(source.runId); report.runId = source.runId;
  await feed({ ...task, update_id: ++updateId });
  const selectionCard = store.snapshot().deliveries.findLast(item => item.key.startsWith('selection:') && item.state === 'submitted');
  const selectionCode = selectionCard.key.split(':').at(-1);
  await feed(textUpdate(`选择 ${selectionCode} 2`, 99));
  assert.equal(host.channelSnapshot().snapshot.pendingHerdrSelection.selectionId, selection.selectionId);
  await feed(textUpdate(`选择 ${selectionCode} 2`));
  let old = await currentCard();
  assert.equal(host.channelSnapshot().snapshot.state.runId, source.runId);
  assert.equal(host.channelSnapshot().snapshot.pendingApproval.toolName, 'herdr_pi_control');
  assert.equal(report.piRequests.length, 0, 'selection must not approve the prompt');
  await feed(textUpdate('/confirm'));
  await until(() => approvalCards().length === 2, 'refreshed approval card absent');
  const card = await currentCard(), permit = host.channelSnapshot().snapshot.pendingApproval.approvalId;
  for (const item of [callback(old), callback(card, { userId: 99 }), callback(card, { message: card.messageId + 1000 })]) {
    await feed(item); assert.equal(host.channelSnapshot().snapshot.pendingApproval.approvalId, permit); assert.equal(report.piRequests.length, 0);
  }
  const allowed = callback(card); await feed(allowed);
  assert.ok(report.transport.some(row => row.direction === 'answer-callback' && row.id === allowed.callback_query.id));
  await until(() => report.modelCalls === 3, 'original gateway callback did not resume same Run');
  await feed({ ...allowed, update_id: ++updateId });
  await feed(callback(card));
  await feed(textUpdate(`允许 ${card.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]}`));
  await feed(textUpdate(`选择 ${selectionCode} 1`));
  assert.equal(report.cases[0].hostDecisions.filter(item => item.kind === 'approval' && item.value.herdr).length, 1);
  releaseRead();
  await until(() => host.channelSnapshot().snapshot.pendingApproval?.toolName === 'read_file' || host.channelSnapshot().snapshot.state.kind === 'idle', 'artifact verification approval absent');
  if (host.channelSnapshot().snapshot.pendingApproval?.toolName === 'read_file') { old = await currentCard(); await feed(callback(old)); }
  await until(() => store.snapshot().deliveries.find(item => item.key === `result:${source.key}`)?.state === 'submitted', 'result delivery absent');
  const calls = report.modelCalls;
  await feed({ ...task, update_id: ++updateId });
  await feed(callback(card));
  await feed(textUpdate(`允许 ${card.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]}`));
  await feed(textUpdate(`选择 ${selectionCode} 1`));
  await feed(textUpdate('/confirm'));
  await feedBatch([{ ...task, update_id: ++updateId }, { ...allowed, update_id: ++updateId }, callback(card)]);
  assert.equal(report.modelCalls, calls);
  const receipt = await host.channelReceipt(store.snapshot().owner.threadId, source.runId);
  report.receipt = receipt; assert.equal(receipt.status, 'completed'); assert.equal(receipt.trace.incomplete, false);
  report.approvalChain = approvalChain({ runId: source.runId, receipt, events: report.approvalEvents, decisions: report.cases[0].hostDecisions.filter(item => item.kind === 'approval') });
  const operation = report.approvalChain.filter(item => item.frozen);
  assert.equal(operation.length, 1); assert.equal(operation[0].dispatched, true);
  assert.equal(operation[0].frozen.selectionVersion, 1);
  assert.deepEqual(operation[0].frozen.target, selection.candidates[1].target);
  assert.equal(operation[0].frozen.action.text, prompt);
  assert.deepEqual(receipt.tools.map(tool => [tool.toolName, tool.status]), [['herdr_pi_discover', 'completed'], ['herdr_pi_control', 'completed'], ['herdr_pi_read', 'completed'], ['read_file', 'completed']]);
  assert.equal(store.snapshot().inputs.filter(item => item.runId && !item.steerId).length, 1);
  report.artifact = JSON.parse(await readFile(join(fixture.work, 'blue-answer.json'), 'utf8')); assert.deepEqual(report.artifact, expected);
  const chosen = selection.candidates[1].target;
  for (const pi of [fixture, secondPi]) {
    const content = await readFile(pi.piSession, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const users = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.type === 'message' && item.message?.role === 'user');
    if (users.length) {
      const text = users[0].message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert.equal(text, operation[0].frozen.action.text);
    }
    await writeFile(join(output, pi === fixture ? 'pi-1.jsonl' : 'pi-2.jsonl'), content);
    assert.equal(users.length, ['session', 'paneId', 'terminalId', 'authorizedDirectory'].every(key => pi.target[key] === chosen[key]) ? 1 : 0);
  }
  const events = report.approvalEvents.filter(item => item.type === 'event').map(item => item.event);
  assert.ok(events.some(item => item.type === 'tool.call.completed' && item.data.toolName === 'read_file' && JSON.parse(item.data.output.content).order === expected.order));
  assert.ok(events.some(item => item.type === 'tool.call.completed' && item.data.toolName === 'herdr_pi_read' && item.data.output.value?.text?.includes(expected.order)));
  assert.equal(report.cases[0].hostDecisions.filter(item => item.kind === 'selection').length, 1);
  assert.ok(report.cases[0].hostDecisions.every(item => item.runId === source.runId && item.response.accepted));
  report.checks = ['original-observer-starts-one-run', 'real-two-pi-selection-card', 'selection-does-not-approve-operation', 'original-gateway-callback-consumes-once', 'stale-foreign-copied-controls-zero-dispatch', 'duplicate-task-callback-text-zero-extra-dispatch', 'adoption-narrows-tool-contract', 'pi-writes-and-host-independently-verifies'].map(name => ({ name, status: 'passed' }));
  report.status = 'passed';
} catch (error) { stop('verification-failure'); report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  releaseRead?.();
  if (host) { if (host.channelSnapshot().snapshot.state.kind !== 'idle') await host.current.cancel(); await host.shutdown(); }
  if (report.status === 'passed') {
    try { report.cleanup = await cleanup(fixture.statePath); }
    catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; report.retainedScene = fixture.statePath; process.exitCode = 1; }
  } else report.retainedScene = fixture?.statePath ?? root;
  proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); globalThis.fetch = originalFetch;
  if (store) report.telegramStore = store.snapshot();
  report.finishedAt = new Date().toISOString(); await save(); await saveTail;
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, modelCalls: report.modelCalls, piRequests: report.piRequests.length, output, failure: report.failure, retainedScene: report.retainedScene }));
