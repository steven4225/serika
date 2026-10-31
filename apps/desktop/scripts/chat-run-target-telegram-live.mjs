import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopRuntime } from '../src/main/desktop-runtime.ts';
import { TelegramGateway } from '../src/main/telegram-gateway.ts';
import { TelegramStore } from '../src/main/telegram-store.ts';
import { createTelegramApi } from '../src/main/telegram-api.ts';
import { listDesktopThreads } from '../src/main/desktop-identity.ts';
import { configureCliModel } from '@serika/assistant';
import { setup, addPi, cleanup } from './chat-run-target-live-herdr.mjs';
import { approvalChain } from './chat-run-target-approval.mjs';
import { inspectTelegramInbound, redactTelegramEvidence, telegramHandoff } from './chat-run-target-telegram-inbound.mjs';
import { waitForTelegramPairReady } from './chat-run-target-telegram-pairing.mjs';
import { defaultTelegramTestEnv, loadTelegramTestSettings, prepareTelegramTestProfile, writeTelegramTestConfig, inspectTelegramTestStore } from './chat-run-target-telegram-profile.mjs';
import { writeTelegramStopAudit } from '../../../scripts/chat-run-target-telegram-stop-audit.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const arg = name => { const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1], `Missing ${name}`); return process.argv[i + 1]; };
const model = 'deepseek/deepseek-v4.1-flash-fast', capUsd = .25, maxRequests = 24, maxRuns = 1;
const price = { input: .32, output: 1.16, cacheRead: .03 };
const envFile = process.argv.includes('--env-file') ? resolve(arg('--env-file')) : defaultTelegramTestEnv;
if (!process.argv.includes('--run')) {
  if (process.argv.includes('--check-settings')) {
    try {
      const historical = JSON.parse(await readFile(join(repo, 'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-2856460a/result.json'), 'utf8'));
      const checked = await loadTelegramTestSettings({ envFile, forbiddenBotId: historical.telegramIdentity.actualBotId });
      console.log(JSON.stringify({ mode: 'zero-request-settings-check', valid: true, envFile, profileRoot: checked.profileRoot, runtimeRoot: checked.runtimeRoot, modelCalls: 0, telegramCalls: 0 }));
    } catch (error) { console.log(JSON.stringify({ mode: 'zero-request-settings-check', valid: false, error: error instanceof assert.AssertionError ? error.message : error.code ?? 'Settings unavailable', modelCalls: 0, telegramCalls: 0 })); process.exitCode = 1; }
    process.exit(process.exitCode ?? 0);
  }
  console.log(JSON.stringify({ mode: 'zero-request-preflight', importsLoaded: true, envFilePresent: existsSync(envFile), model, capUsd, maxRequests, maxRuns,
    modelCalls: 0, telegramCalls: 0, scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))) }));
  process.exit(0);
}
assert.equal(git('status', '--porcelain'), '', 'Commit the harness before live evidence');
const output = resolve(arg('--output')); assert.ok(output.startsWith('/private/tmp/')); await mkdir(output);
const historical = JSON.parse(await readFile(join(repo, 'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-2856460a/result.json'), 'utf8'));
const settings = await loadTelegramTestSettings({ envFile, forbiddenBotId: historical.telegramIdentity.actualBotId });
const { credentials } = settings, root = settings.runtimeRoot;
const report = { batchId: randomUUID(), startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
  verification: 'real-telegram-dedicated-test-bot-original-runtime-isolated-herdr-pi', channelStrategy: 'dedicated-test-bot', dailyAccess: 'none', platform: process.platform, node: process.version,
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), model, capUsd, maxRequests, maxRuns, pricePerMillionUsd: price,
  priceBasis: 'Frozen desktop c9a16383 script rates; not invoice verified', credentialSource: envFile, credentialsWrittenToDisk: false,
  calls: [], cases: [], errors: [], approvalEvents: [], transport: [], inboundChecks: [], pairReadiness: [], costUsd: 0, status: 'running', isolatedRoot: root };
let frozen = false, stage = 'preparation', fixture, secondPi, host, gateway, store, lease;
let lastPollOffset = -1, activeInbound, expectedPairing, expectedPrompt, taskMessageId, runId;
let saving = Promise.resolve();
const save = () => { const value = JSON.stringify(redactTelegramEvidence(report, [credentials.key, credentials.telegram, credentials.proxy]), null, 2) + '\n'; saving = saving.then(() => writeFile(join(output, 'result.json'), value)); return saving; };
const tell = value => console.log(JSON.stringify(value));
const stop = reason => { frozen = true; report.stopReason ??= reason; };
const pending = new Set();
const server = createServer((req, res) => { const work = request(req, res); pending.add(work); void work.finally(() => pending.delete(work)); });
async function request(req, res) {
  let row;
  try {
    assert.ok(['/serika/v1/chat/completions', '/pi/v1/chat/completions'].includes(req.url));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, model);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      let result; try { result = JSON.parse(message.content); } catch { continue; }
      if (result?.ok === false) { stop('non-success-tool-result'); if (result.error?.code === 'TOOL_OUTCOME_UNKNOWN') report.unknownEffect = true; }
    }
    const caller = req.url.startsWith('/pi/') ? 'pi' : 'serika';
    const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    if (caller === 'serika' && !system.startsWith('You are a context compactor.')) {
      const names = body.tools?.map(tool => tool.function.name); assert.ok(names?.includes('herdr_pi_read') && names.includes('herdr_pi_control'));
      assert.equal(names.includes('herdr_pi_discover'), !report.cases[0]?.hostDecisions.some(d => d.kind === 'selection' && d.response.accepted));
    }
    const maxOutput = body.max_tokens ?? body.max_completion_tokens ?? 4096;
    assert.ok(Number.isSafeInteger(maxOutput) && maxOutput > 0 && maxOutput <= 4096);
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_tokens = maxOutput;
    const text = JSON.stringify(body), reservedUsd = ((Buffer.byteLength(text) + 32768) * price.input + maxOutput * price.output) / 1e6;
    const unresolved = report.calls.filter(call => call.status !== 'returned').reduce((sum, call) => sum + call.reservedUsd, 0);
    if (frozen || report.calls.length >= maxRequests || report.costUsd + unresolved + reservedUsd > capUsd) {
      stop('approved-request-or-cost-cap'); await save(); res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Batch stopped; no upstream request"}}'); return;
    }
    row = { sequence: report.calls.length + 1, id: randomUUID(), stage, caller, startedAt: new Date().toISOString(), status: 'dispatched',
      reservedUsd, requestBytes: Buffer.byteLength(text), requestSha256: hash(text), maxOutputTokens: maxOutput };
    report.calls.push(row); await writeFile(join(output, `request-${row.sequence}.json`), JSON.stringify(body, null, 2) + '\n'); await save();
    const response = await fetch(credentials.base + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${credentials.key}`, 'Content-Type': 'application/json' },
      body: text, signal: AbortSignal.timeout(120000) });
    row.httpStatus = response.status;
    if (!response.ok) { row.status = 'http-error'; throw new Error('Upstream failed; body withheld'); }
    res.writeHead(200, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
    const returned = []; for await (const chunk of response.body) { returned.push(Buffer.from(chunk)); res.write(chunk); }
    const returnedText = Buffer.concat(returned).toString();
    const frames = body.stream ? returnedText.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(returnedText)];
    const usage = frames.findLast(frame => frame.usage)?.usage;
    const input = usage?.prompt_tokens, out = usage?.completion_tokens, cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
    row.responseSha256 = hash(returnedText); await writeFile(join(output, `response-${row.sequence}.txt`), returnedText);
    if (![input, out, cacheRead].every(Number.isSafeInteger) || input < 0 || out < 0 || cacheRead < 0 || cacheRead > input) { row.status = 'usage-unknown'; stop('usage-unknown'); }
    else {
      row.usage = { input, output: out, cacheRead }; row.status = 'returned';
      row.costUsd = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + out * price.output) / 1e6; report.costUsd += row.costUsd;
      if (row.costUsd > reservedUsd) stop('reservation-exceeded');
    }
    row.finishedAt = new Date().toISOString(); await save(); res.end(); tell({ call: row.sequence, caller, status: row.status, costUsd: report.costUsd });
  } catch (error) {
    stop('model-request-failure'); if (row?.status === 'dispatched') row.status = 'transport-unknown';
    report.errors.push({ stage: 'model-proxy', name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Request failed; private details withheld' });
    await save(); if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Batch stopped; no replay"}}');
  }
}
async function finalize(name, action) {
  try { return await action(); }
  catch (error) { stop(`${name}-failed`); report.status = 'failed'; report.errors.push({ stage: name, name: error.name }); return undefined; }
}
async function waitFor(check, name, ms = 300000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(!frozen, `Stopped: ${report.stopReason}`); assert.ok(Date.now() < deadline, `Timed out: ${name}`); await delay(100); }
  assert.ok(!frozen, `Stopped: ${report.stopReason}`);
}
function bindingSnapshot() {
  const status = gateway?.status(), data = store.snapshot(), state = host.current.snapshot().state;
  const owner = data.owner && { userId: data.owner.userId, chatId: data.owner.chatId, threadId: data.owner.threadId };
  return { owner, gatewayCreated: !!gateway, pairing: status?.pairing ? { code: status.pairing.code, expiresAt: status.pairing.expiresAt, proposed: status.pairing.proposed && {
    userId: status.pairing.proposed.userId, chatId: status.pairing.proposed.chatId } } : null, botId: data.botId, threadId: host.info().threadId,
    offset: data.offset, state: state.kind, runId: state.kind === 'running' ? state.runId : null };
}
function observe(message) {
  const currentId = message.type === 'event' ? message.event.runId : message.runId ?? runId;
  if (message.type === 'state' && message.state.kind === 'running' && message.state.runId) {
    if (runId && runId !== message.state.runId) stop('unexpected-additional-run'); runId ??= message.state.runId;
    if (report.cases[0]) report.cases[0].runId ??= runId;
  }
  if (['approval', 'approval-cleared', 'approval-decision', 'herdr-selection', 'herdr-selection-cleared', 'herdr-selection-decision', 'event', 'result'].includes(message.type)) {
    report.approvalEvents.push({ ...message, runId: currentId, at: new Date().toISOString() });
    if (message.type.endsWith('-decision')) {
      const selection = message.type === 'herdr-selection-decision';
      report.cases[0]?.hostDecisions.push({ kind: selection ? 'selection' : 'approval', runId: message.runId, value: selection ? message.selection : message.approval,
        input: message.input, toolCallId: selection ? message.selection?.toolCallId : message.approval?.toolCallId, approvalId: message.approval?.approvalId,
        decision: message.input.decision, response: { accepted: message.accepted }, source: message.source, at: message.decidedAt,
        telegramInbound: activeInbound && { updateId: activeInbound.update_id, messageId: activeInbound.message?.message_id, text: activeInbound.message?.text } });
      if (!message.accepted || message.input.decision === 'deny' || selection && message.input.candidateId === null) stop('decision-rejected-denied-or-cancelled');
    }
    if (message.type === 'event' && (message.event.type === 'tool.call.failed' || message.event.type === 'tool.call.completed' && message.event.data.output?.ok === false)) {
      stop('non-success-tool-result'); if (message.event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || message.event.data.output?.error?.code === 'TOOL_OUTCOME_UNKNOWN') report.unknownEffect = true;
    }
    if (message.type === 'result' && message.result.status !== 'completed') stop('non-completed-run');
    void save();
  }
}
try {
  lease = await prepareTelegramTestProfile(settings);
  report.testProfile = { profileRoot: settings.profileRoot, runtimeRoot: root, applicationHome: settings.applicationHome, configPath: settings.configPath,
    expectedBotId: settings.botId, expectedOwner: settings.owner, leaseAcquiredAt: new Date().toISOString() };
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const local = `http://127.0.0.1:${server.address().port}`;
  fixture = await setup(root, local + '/pi/v1', model); report.fixture = fixture;
  secondPi = await addPi(fixture.statePath); report.secondPi = secondPi;
  const { configPath, applicationHome } = settings;
  assert.equal(fixture.work, settings.workspace); await writeTelegramTestConfig({ settings, model });
  const env = { ...fixture.env, RUNLOOM_CONFIG: configPath, RUNLOOM_DESKTOP_TEST: '1', RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: model, COMMAND_CODE_API_KEY: 'local-proxy', COMMAND_CODE_BASE_URL: local + '/serika/v1' };
  const configured = configureCliModel(() => { throw new Error('Mock forbidden'); }, env);
  host = await DesktopRuntime.create({ applicationHome, cwd: fixture.work, env, ...configured, modelId: model, send: observe });
  store = new TelegramStore(join(applicationHome, 'resident/telegram.json'), applicationHome); await store.load();
  report.testProfile.initial = inspectTelegramTestStore({ data: store.snapshot(), settings });
  if (store.snapshot().owner) {
    const registered = await listDesktopThreads({ applicationHome, configPath, workspaceRoot: fixture.work, cwd: fixture.work });
    assert.ok(registered.some(thread => thread.threadId === store.snapshot().owner.threadId), 'Saved test Thread is not registered');
  }
  await store.update(data => { data.enabled = false; });
  const nonce = report.batchId.slice(0, 8); await writeFile(join(fixture.work, 'blue.json'), JSON.stringify({ a: 5, b: 9, order: nonce + '-blue' }));
  expectedPrompt = `请找一个现有 Pi，根据 blue.json 把 a 与 b 的和及原 order 写入 blue-answer.json，字段为 sum 和 order。完成后你亲自读文件核对。本批标识：${nonce}。`;
  report.cases.push({ name: 'telegram-multiple-pi', prompt: expectedPrompt, hostDecisions: [], status: 'waiting-for-user' });
  const realApi = createTelegramApi(credentials.telegram, fetch, credentials.proxy ? { proxyUrl: credentials.proxy } : {});
  const api = {
    identity: async signal => {
      const value = await realApi.identity(signal);
      report.telegramIdentity = { expectedBotId: settings.botId, actualBotId: value.id, matches: settings.botId === value.id };
      await save(); if (!report.telegramIdentity.matches) stop('telegram-bot-identity-mismatch');
      assert.ok(report.telegramIdentity.matches); return value;
    },
    webhook: signal => realApi.webhook(signal), close: () => realApi.close(), answerCallback: () => { throw new Error('Use text shortcodes for this batch'); },
    updates: async (offset, signal) => {
      assert.ok(!frozen);
      let updates;
      try { updates = await realApi.updates(offset, signal); }
      catch (error) { if (!signal.aborted) { report.pollFailure = { code: error.code ?? error.name, outcome: error.outcome ?? 'unknown' }; stop('telegram-poll-failed'); await save(); } throw error; }
      const pollId = randomUUID();
      if (!Array.isArray(updates)) {
        report.inboundChecks.push(inspectTelegramInbound({ update: updates, context: { pollId, indexInPoll: 0, owner: settings.owner, pollResponseIsArray: false },
          binding: bindingSnapshot(), secrets: [credentials.key, credentials.telegram, credentials.proxy] }));
        report.pollFailure = { code: 'INVALID_UPDATES_ARRAY', outcome: 'unknown' }; stop('telegram-poll-invalid-response'); await save();
        throw new assert.AssertionError({ message: 'Inbound rejected: updates_response_array' });
      }
      lastPollOffset = offset; report.lastPollOffset = offset;
      let projectedTaskMessageId = taskMessageId;
      const records = updates.map((update, indexInPoll) => {
        const record = inspectTelegramInbound({ update, context: { pollId, indexInPoll,
          owner: settings.owner, pairingCode: expectedPairing, taskText: expectedPrompt, taskMessageId: projectedTaskMessageId }, binding: bindingSnapshot(),
          secrets: [credentials.key, credentials.telegram, credentials.proxy] });
        if (record.accepted && record.phase === 'task') projectedTaskMessageId ??= update.message.message_id;
        return record;
      });
      report.inboundChecks.push(...records);
      const rejected = records.find(record => !record.accepted);
      if (rejected) {
        for (const record of records) record.blockedByUpdateId = rejected.update?.update_id ?? null;
        stop('unexpected-telegram-inbound'); await save();
        throw new assert.AssertionError({ message: `Inbound rejected: ${rejected.failedPredicate}` });
      }
      for (const record of records) {
        if (record.phase === 'task') taskMessageId ??= record.update.message.message_id;
        report.transport.push({ direction: 'inbound', at: record.at, offset, update: record.update });
      }
      await save(); return updates;
    },
    send: async (chatId, text, signal, format, keyboard) => {
      const row = { direction: 'outbound', at: new Date().toISOString(), chatId, text, format, keyboard, status: 'dispatching' }; report.transport.push(row); await save();
      try { row.messageId = await realApi.send(chatId, text, signal, format, keyboard); row.status = 'submitted'; await save(); return row.messageId; }
      catch (error) { row.status = error.outcome ?? 'unknown'; stop('telegram-send-failed'); if (row.status === 'unknown') report.unknownTransport = true; await save(); throw error; }
    },
  };
  gateway = new TelegramGateway(host, store, api); host.attachTelegram(gateway); await gateway.initialize();
  const receive = gateway.receive.bind(gateway);
  gateway.receive = async update => {
    activeInbound = update;
    const record = report.inboundChecks.findLast(row => row.update?.update_id === update.update_id);
    assert.ok(record?.accepted); record.bindingBefore = bindingSnapshot(); record.forwarded = true; await save();
    try { return await receive(update); }
    finally { record.bindingAfter = bindingSnapshot(); activeInbound = undefined; await save(); }
  };
  assert.equal(store.snapshot().enabled, false); assert.equal(gateway.status().connection, 'disabled');
  if (!store.snapshot().owner) {
    stage = 'waiting-for-pair-ready';
    await waitForTelegramPairReady({ input: process.stdin, batchId: report.batchId, signal: AbortSignal.timeout(300000), record: async row => {
      report.pairReadiness.push(row); await save();
      if (row.status === 'waiting') tell({ pending: 'pair-ready', batchId: report.batchId, command: `pair ${report.batchId}`, channelStrategy: 'dedicated-test-bot', output });
    } });
    stage = 'pairing'; report.testChannelStartedAt = new Date().toISOString(); await save(); await gateway.setEnabled(true); assert.equal(gateway.status().connection, 'online');
    expectedPairing = gateway.beginPairing().pairing.code;
    report.bindingAtPairingStart = bindingSnapshot(); await save();
    tell({ pending: 'telegram-pairing', botUsername: gateway.status().botUsername, command: `/start ${expectedPairing}`, output });
    await waitFor(() => gateway.status().pairing?.proposed, 'real Telegram pairing');
    assert.equal(gateway.status().pairing.proposed.userId, settings.owner.userId); assert.equal(gateway.status().pairing.proposed.chatId, settings.owner.chatId);
    report.pairingConfirmation = { before: bindingSnapshot() }; await save();
    await gateway.confirmPairing(expectedPairing);
    report.pairingConfirmation.after = bindingSnapshot(); await save();
    report.pairing = { mode: 'first-pairing', originalGatewayAccepted: true, ownerMatchesExpected: true, threadId: store.snapshot().owner.threadId };
  } else {
    report.pairing = { mode: 'reused-binding', ownerMatchesExpected: true, threadId: store.snapshot().owner.threadId };
    assert.deepEqual(store.snapshot().owner, report.testProfile.initial.owner);
    stage = 'telegram-multiple-pi'; report.testChannelStartedAt = new Date().toISOString(); await save(); await gateway.setEnabled(true); assert.equal(gateway.status().connection, 'online');
    assert.equal(gateway.status().pairing, null);
  }
  stage = 'telegram-multiple-pi'; await save(); tell({ pending: 'telegram-task', prompt: expectedPrompt, botUsername: gateway.status().botUsername, output });
  await waitFor(() => {
    const input = store.snapshot().inputs.find(input => input.text === expectedPrompt);
    assert.ok(input?.state !== 'rejected', 'Telegram task rejected before Run startup; stop without retry');
    return !!input?.runId;
  }, 'one real Telegram task');
  const task = store.snapshot().inputs.find(input => input.text === expectedPrompt); runId = task.runId; report.cases[0].runId = runId; report.cases[0].status = 'running'; await save();
  await waitFor(() => store.snapshot().deliveries.find(item => item.key === `result:${task.key}`)?.state === 'submitted', 'TG result delivery', 600000);
  await waitFor(() => lastPollOffset >= store.snapshot().offset, 'transport cursor acknowledgement');
  const item = report.cases[0]; item.receipt = await host.channelReceipt(store.snapshot().owner.threadId, runId);
  assert.equal(item.receipt?.status, 'completed'); assert.equal(item.receipt.runId, runId); assert.equal(item.receipt.trace.incomplete, false);
  item.approvalChain = approvalChain({ runId, receipt: item.receipt, events: report.approvalEvents, decisions: item.hostDecisions.filter(d => d.kind === 'approval') });
  const selected = item.hostDecisions.filter(d => d.kind === 'selection'); assert.equal(selected.length, 1); assert.equal(selected[0].response.accepted, true);
  assert.ok(selected[0].value.candidates.length >= 2 && selected[0].value.candidates.every(c => c.status === 'idle'));
  const candidate = selected[0].value.candidates.find(c => c.candidateId === selected[0].input.candidateId); assert.ok(candidate);
  const approved = item.approvalChain.filter(a => a.frozen); assert.equal(approved.length, 1); assert.equal(approved[0].dispatched, true);
  assert.deepEqual(approved[0].frozen.target, candidate.target); assert.equal(approved[0].frozen.selectionVersion, 1);
  assert.equal(item.receipt.tools.filter(t => t.toolName === 'herdr_pi_discover').length, 1);
  assert.equal(item.receipt.tools.filter(t => t.toolName === 'herdr_pi_control').length, 1);
  item.actualArtifact = JSON.parse(await readFile(join(fixture.work, 'blue-answer.json'), 'utf8')); assert.deepEqual(item.actualArtifact, { sum: 14, order: nonce + '-blue' });
  for (const [index, pi] of [fixture, secondPi].entries()) {
    let text; try { text = await readFile(pi.piSession, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
    const users = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.type === 'message' && r.message?.role === 'user');
    const chosen = isDeepStrictEqual(pi.target, candidate.target); assert.equal(users.length, chosen ? 1 : 0);
    if (chosen) assert.equal(users[0].message.content.filter(p => p.type === 'text').map(p => p.text).join('\n'), approved[0].frozen.action.text);
    if (text) await writeFile(join(output, `pi-${index + 1}.jsonl`), text);
  }
  const raw = report.approvalEvents.filter(e => e.type === 'event').map(e => e.event), control = item.receipt.tools.find(t => t.toolName === 'herdr_pi_control');
  assert.ok(raw.some(e => e.type === 'tool.call.completed' && e.data.toolName === 'herdr_pi_read' && e.data.output.value?.text?.includes(nonce + '-blue') && e.occurredAt > control.finishedAt));
  const read = raw.find(e => e.type === 'tool.call.completed' && e.data.toolName === 'read_file' && e.data.output.path === 'blue-answer.json' && e.occurredAt > control.finishedAt);
  assert.ok(read); assert.deepEqual(JSON.parse(read.data.output.content), item.actualArtifact);
  assert.equal(store.snapshot().inputs.filter(i => !report.testProfile.initial.inputKeys.includes(i.key) && i.runId && !i.steerId).length, 1);
  assert.equal(item.hostDecisions.filter(d => d.kind === 'approval' && d.value.herdr).length, 1);
  item.status = 'passed'; report.status = 'passed';
} catch (error) {
  stop('verification-failure'); report.status = 'failed'; report.failure = { name: error.name,
    message: error instanceof assert.AssertionError ? error.message : 'Verification failed; private exception details withheld' };
  try { if (JSON.parse(await readFile(join(root, 'herdr-fixture/herdr-state.json'), 'utf8')).unknown) report.unknownEffect = true; }
  catch (stateError) { if (stateError.code !== 'ENOENT') report.errors.push({ stage: 'fixture-state', name: stateError.name }); }
  tell({ status: 'failed', stopReason: report.stopReason, failure: report.failure });
} finally {
  if (host && store && runId) {
    try { report.cases[0].runId ??= runId; report.cases[0].receipt ??= await host.channelReceipt(store.snapshot().owner.threadId, runId); }
    catch (error) { report.errors.push({ stage: 'local-receipt', name: error.name }); }
  }
  await finalize('final-snapshot', async () => {
    if (store) { report.telegramStore = store.snapshot(); report.lastPollOffset = lastPollOffset; }
    report.bindingBeforeShutdown = host && store ? bindingSnapshot() : null;
  });
  try {
    if (host) { if (host.current.snapshot().state.kind !== 'idle') host.current.cancel(); await host.shutdown(); report.isolatedHostStoppedAt = new Date().toISOString(); }
    if (gateway) { assert.equal(gateway.status().connection, 'disabled'); report.isolatedTelegramStoppedAt = new Date().toISOString(); }
  } catch (error) { stop('isolated-host-stop-failed'); report.status = 'failed'; report.errors.push({ stage: 'isolated-host-stop', name: error.name }); }
  await finalize('post-shutdown-receipt', async () => {
    if (host && store && runId) report.cases[0].receiptAfterShutdown = await host.channelReceipt(store.snapshot().owner.threadId, runId);
  });
  const persisted = await finalize('test-profile-disabled', async () => {
    report.bindingAfterShutdown = gateway && store ? bindingSnapshot() : null;
    if (store && report.isolatedTelegramStoppedAt) {
      await store.update(data => { data.enabled = false; });
      report.testProfile.final = { owner: store.snapshot().owner, offset: store.snapshot().offset, enabled: store.snapshot().enabled };
      assert.deepEqual(report.testProfile.final.owner, report.telegramStore.owner);
    }
    return true;
  });
  if (persisted && store && report.isolatedTelegramStoppedAt && report.testChannelStartedAt) {
    try {
      report.transportCursorHandoff = telegramHandoff({ storeOffset: store?.snapshot().offset ?? 0, records: report.inboundChecks, confirmedOffset: lastPollOffset });
      assert.deepEqual(report.transportCursorHandoff.blockedBy, [], 'Unowned/malformed update requires manual handoff; do not discard it');
      if (!report.transportCursorHandoff.confirmed) {
        assert.ok(!report.unknownTransport && !report.pollFailure, 'Uncertain transport requires manual handoff');
        const ackApi = createTelegramApi(credentials.telegram, fetch, credentials.proxy ? { proxyUrl: credentials.proxy } : {});
        try {
          const offset = report.transportCursorHandoff.requiredOffset;
          report.transportCursorHandoff.ackAttemptedAt = new Date().toISOString(); await save();
          const held = await ackApi.updates(offset, new AbortController().signal);
          const handoffPollId = randomUUID();
          const heldRecords = (Array.isArray(held) ? held : [held]).map((update, indexInPoll) => inspectTelegramInbound({ update,
            context: { pollId: handoffPollId, indexInPoll, owner: settings.owner, pairingCode: expectedPairing, taskText: expectedPrompt,
              handoffResponseSize: Array.isArray(held) ? held.length : 'non-array', pollResponseIsArray: Array.isArray(held) },
            binding: bindingSnapshot(), secrets: [credentials.key, credentials.telegram, credentials.proxy] }));
          report.inboundChecks.push(...heldRecords);
          report.transportCursorHandoff.ackResponseAt = new Date().toISOString();
          report.transportCursorHandoff.responseIsArray = Array.isArray(held);
          report.transportCursorHandoff.returnedUpdates = Array.isArray(held) ? held.length : null; await save();
          assert.ok(Array.isArray(held) && held.length === 0, 'Handoff returned pending updates; diagnostics saved, manual handoff required');
          report.transportCursorHandoff = { ...report.transportCursorHandoff, offset, confirmedAt: new Date().toISOString(), unacknowledgedLaterUpdates: held.length, forwardedToModel: false };
          lastPollOffset = offset;
        } finally { await ackApi.close(); }
      }
      Object.assign(report.transportCursorHandoff, telegramHandoff({ storeOffset: store?.snapshot().offset ?? 0, records: report.inboundChecks, confirmedOffset: lastPollOffset }));
      assert.equal(report.transportCursorHandoff.confirmed, true);
      await store.update(data => { data.offset = Math.max(data.offset, report.transportCursorHandoff.confirmedOffset); });
      report.testProfile.final.offset = store.snapshot().offset;
    } catch (error) { stop('test-channel-handoff-failed'); report.status = 'failed'; report.errors.push({ stage: 'test-channel-handoff', name: error.name,
      condition: error instanceof assert.AssertionError ? error.message : error.code ?? 'Private exception details withheld' }); }
  }
  await finalize('post-shutdown-store', async () => { if (store) report.telegramStoreAfterShutdown = store.snapshot(); });
  await finalize('model-proxy-stop', async () => { if (server.listening) await new Promise(done => server.close(done)); await Promise.all([...pending]); });
  await finalize('fixture-finalization', async () => { if (fixture) {
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8')); if (state.unknown) { report.unknownEffect = true; stop('fixture-outcome-unknown'); report.status = 'failed'; }
    if (!frozen && !report.unknownEffect) {
      try { report.cleanup = await cleanup(fixture.statePath); }
      catch (error) { stop('fixture-cleanup-failed'); report.status = 'failed'; report.errors.push({ stage: 'fixture-cleanup', name: error.name }); }
    }
    await writeFile(join(output, 'herdr-state.json'), await readFile(fixture.statePath));
    if (!frozen && report.cleanup?.phase === 'cleaned') { await rm(root, { recursive: true, force: true }); await assert.rejects(access(root), { code: 'ENOENT' }); report.temporaryDirectoryRemoved = true; }
  } });
  await finalize('test-profile-lease-release', async () => { if (lease) { await lease.release(); report.testProfile.leaseReleasedAt = new Date().toISOString(); } });
  report.realModelCalls = report.calls.length; report.unresolvedReservedUsd = report.calls.filter(c => c.status !== 'returned').reduce((sum, c) => sum + c.reservedUsd, 0);
  report.finishedAt = new Date().toISOString(); await save(); if (report.status === 'failed') await writeTelegramStopAudit({ directory: output }); tell({ status: report.status, requests: report.realModelCalls, costUsd: report.costUsd, channelStrategy: report.channelStrategy, testBindingRetained: !!report.testProfile?.final?.owner, output });
}
if (report.status !== 'passed') process.exitCode = 1;
