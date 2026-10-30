import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, expect } from 'playwright/test';
import { setup, addPi, cleanup } from './chat-run-target-live-herdr.mjs';
import { approvalChain, confirmApproval, observeApprovals } from './chat-run-target-approval.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const model = 'deepseek/deepseek-v4.1-flash-fast', capUsd = .25, maxRequests = 24, maxRuns = 2;
const price = { input: .32, output: 1.16, cacheRead: .03 };
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ mode: 'zero-request-preflight', model, capUsd, maxRequests, maxRuns,
    credentialPresent: 'not-inspected', credentialsWrittenToDisk: false, realModelCalls: 0,
    scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))) }));
  process.exit(0);
}
const source = parseEnv(await readFile('/Users/a1-6/.serika-test.env', 'utf8'));
assert.ok(source.COMMAND_CODE_API_KEY);
assert.equal(source.COMMAND_CODE_BASE_URL, 'https://api.commandcode.ai/provider/v1');
assert.equal(source.COMMAND_CODE_MODEL_ID, model);
const credentials = { key: source.COMMAND_CODE_API_KEY, base: source.COMMAND_CODE_BASE_URL };
for (const key of Object.keys(source)) delete source[key];
const outputIndex = process.argv.indexOf('--output');
assert.ok(outputIndex >= 0 && process.argv[outputIndex + 1]);
const output = resolve(process.argv[outputIndex + 1]);
assert.ok(!output.startsWith(repo + '/'));
assert.equal(git('status', '--porcelain'), '', 'Commit the harness before live evidence');
await mkdir(output);
const root = await mkdtemp('/private/tmp/c-');
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
  verification: 'real-electron-real-model-real-isolated-herdr-pi', platform: process.platform, model,
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), capUsd, maxRequests, maxRuns, pricePerMillionUsd: price,
  priceBasis: 'Conservative published peak rates; not invoice verified', priceSource: 'https://commandcode.ai/models/deepseek-v4-1-flash-fast',
  credentialSource: 'test-only-model-fields-in-process-only', credentialsWrittenToDisk: false,
  calls: [], cases: [], launches: [], errors: [], screenshots: [], approvalEvents: [], costUsd: 0, status: 'running', isolatedRoot: root };
let stage = 'startup', frozen = false, running, page, fixture, pendingId;
const requests = new Set();
let saving = Promise.resolve();
const save = () => { const text = JSON.stringify(report, null, 2) + '\n'; saving = saving.then(() => writeFile(join(output, 'result.json'), text)); return saving; };
const tell = value => console.log(JSON.stringify(value));
const server = createServer((req, res) => {
  const request = handleRequest(req, res);
  requests.add(request); void request.finally(() => requests.delete(request));
});
async function handleRequest(req, res) {
  let row;
  try {
    assert.ok(['/serika/v1/chat/completions', '/pi/v1/chat/completions'].includes(req.url));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, model);
    const maxOutput = body.max_tokens ?? body.max_completion_tokens ?? 4096;
    assert.ok(Number.isSafeInteger(maxOutput) && maxOutput > 0 && maxOutput <= 4096);
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_tokens = maxOutput;
    const text = JSON.stringify(body), reservedUsd = ((Buffer.byteLength(text) + 32768) * price.input + maxOutput * price.output) / 1e6;
    const unresolved = report.calls.filter(call => call.status !== 'returned').reduce((sum, call) => sum + call.reservedUsd, 0);
    if (frozen || report.calls.length >= maxRequests || report.costUsd + unresolved + reservedUsd > capUsd) {
      frozen = true; report.stopReason = 'approved-request-or-cost-cap'; await save();
      res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Approved local limit reached"}}'); return;
    }
    row = { id: randomUUID(), stage, caller: req.url.startsWith('/pi/') ? 'pi' : 'serika', startedAt: new Date().toISOString(),
      status: 'dispatched', reservedUsd, requestBytes: Buffer.byteLength(text), requestSha256: hash(text),
      masked: text.includes('masked pending background'), carriesRunTarget: text.includes('adoptedTarget'), maxOutputTokens: maxOutput };
    report.calls.push(row); row.sequence = report.calls.length;
    await writeFile(join(output, `request-${row.sequence}.json`), JSON.stringify(body, null, 2) + '\n'); await save();
    const response = await fetch(credentials.base + '/chat/completions', { method: 'POST', headers: {
      Authorization: `Bearer ${credentials.key}`, 'Content-Type': 'application/json' }, body: text, signal: AbortSignal.timeout(120000) });
    row.httpStatus = response.status;
    if (!response.ok) { row.status = 'http-error'; frozen = true; throw new Error('upstream failed; body withheld'); }
    res.writeHead(200, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
    const returned = [];
    for await (const chunk of response.body) { returned.push(Buffer.from(chunk)); res.write(chunk); }
    const returnedText = Buffer.concat(returned).toString();
    const frames = body.stream ? returnedText.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(returnedText)];
    const usage = frames.findLast(frame => frame.usage)?.usage;
    const input = usage?.prompt_tokens, out = usage?.completion_tokens, cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
    row.responseSha256 = hash(returnedText);
    await writeFile(join(output, `response-${report.calls.indexOf(row) + 1}.txt`), returnedText);
    if (![input, out, cacheRead].every(Number.isSafeInteger) || input < 0 || out < 0 || cacheRead < 0 || cacheRead > input) {
      frozen = true; row.status = 'usage-unknown';
    } else {
      row.usage = { input, output: out, cacheRead }; row.status = 'returned';
      row.costUsd = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + out * price.output) / 1e6;
      report.costUsd += row.costUsd;
      if (row.costUsd > reservedUsd) { frozen = true; report.stopReason = 'reservation-exceeded'; }
    }
    row.finishedAt = new Date().toISOString(); await save(); res.end();
    tell({ call: row.sequence, caller: row.caller, stage: row.stage, status: row.status, costUsd: report.costUsd });
  } catch {
    frozen = true;
    if (row?.status === 'dispatched') row.status = 'transport-unknown';
    await save(); if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Isolated request stopped; no automatic replay"}}');
  }
}
await new Promise(done => server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${server.address().port}`;
const baseEnv = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
async function shot(name) {
  const file = name + '.png'; await page.screenshot({ path: join(output, file) });
  report.screenshots.push({ file, sha256: hash(await readFile(join(output, file))) }); await save();
}
async function stop() {
  if (!running) return;
  const child = running.process(); await running.close(); assert.notEqual(child.exitCode, null); running = undefined;
}
async function launch(name, pi) {
  const dir = join(root, name), work = pi?.work ?? join(dir, 'workspace'), home = pi?.env.HOME ?? join(dir, 'home');
  await Promise.all([mkdir(work, { recursive: true }), mkdir(home, { recursive: true }), mkdir(dir, { recursive: true })]);
  const configPath = join(dir, 'config.json'), envFile = join(dir, 'connection.env');
  await writeFile(configPath, JSON.stringify({ version: 2, projectDirectory: work, authorizedDirectories: [{ path: work, access: 'readwrite' }], desktopAutonomy: { authorizedDirectory: work },
    modules: { 'read-file': { enabled: true }, shell: { enabled: true }, terminal: { enabled: !!pi }, memory: { enabled: false } },
    run: { maxSteps: 16, totalTimeoutMs: 600000 },
    contextCompaction: { enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096, safetyMarginTokens: 2048, keepRecentTokens: 8192, summaryMaxOutputTokens: 2048 },
    modelContextWindows: [{ provider: 'openai-compatible.chat', modelId: model, contextWindowTokens: 32768 }] }), { mode: 0o600 });
  await writeFile(envFile, `RUNLOOM_MODEL=command-code\nCOMMAND_CODE_MODEL_ID=${model}\nCOMMAND_CODE_BASE_URL=${local}/serika/v1\nCOMMAND_CODE_API_KEY=local-proxy\n`, { mode: 0o600 });
  const env = { ...baseEnv, ...(pi?.env ?? {}), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    RUNLOOM_MODEL: 'command-code', RUNLOOM_CONFIG: configPath, RUNLOOM_ENV_FILE: envFile, RUNLOOM_USER_DATA: join(dir, 'profile'),
    RUNLOOM_TRANSCRIPTS: join(dir, 'transcripts'), RUNLOOM_THREAD: name, RUNLOOM_DESKTOP_TEST: '1' };
  running = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js'), '--home', join(home, '.serika')], cwd: work, env, timeout: 30000 });
  page = await running.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push({ stage, type: 'page', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ stage, type: 'console', message: message.text() }); });
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  await observeApprovals({ page, onEvent: event => {
    report.approvalEvents.push({ stage, ...event });
    if (event.type === 'event' && event.event.type === 'tool.call.failed' && event.event.data.error.code === 'TOOL_OUTCOME_UNKNOWN') {
      report.unknownEffect = true; frozen = true; report.stopReason = 'unknown-external-effect';
    }
    if (report.status === 'running' && event.type === 'approval-cleared' && !report.cases.at(-1)?.decisions.some(row => row.value.approvalId === event.approvalId)) {
      report.stopReason = 'approval-cleared-without-recorded-decision'; frozen = true;
    }
    return save();
  } });
  report.launches.push({ name, main: await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') })),
    renderer: await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href })), configSha256Before: hash(await readFile(configPath)) });
  await save(); return { work, configPath };
}
async function decide(kind, value) {
  const id = kind === 'selection' ? value.selectionId : value.approvalId;
  if (pendingId !== id) {
    pendingId = id; await writeFile(join(output, 'pending.json'), JSON.stringify({ kind, stage, value }, null, 2) + '\n');
    await shot(`${stage}-${kind}-${report.screenshots.length}`); tell({ pending: kind, id, stage, output });
  }
  let decision;
  try { decision = JSON.parse(await readFile(join(output, `decision-${id}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (kind === 'selection') {
    assert.ok(Number.isSafeInteger(decision.index) && decision.index >= 0 && decision.index < value.candidates.length);
    const row = { kind, value, decision, runId: report.cases.at(-1).runId, source: 'user-decision-file-original-preload-selection', status: 'attempting', at: new Date().toISOString() };
    report.cases.at(-1).decisions.push(row); await save();
    row.response = await page.evaluate(input => window.runloom.selectHerdrTarget(input), { selectionId: value.selectionId, candidateId: value.candidates[decision.index].candidateId });
    row.status = row.response.accepted ? 'accepted' : 'rejected'; await save();
    assert.equal(row.response.accepted, true, 'Original host selection was not accepted');
    return true;
  } else {
    assert.equal(decision.decision, 'allow');
    const row = { kind, value, decision, runId: report.cases.at(-1).runId, toolCallId: value.toolCallId, approvalId: id, at: new Date().toISOString(), source: 'original-preload-confirm', status: 'attempting' };
    report.cases.at(-1).decisions.push(row); await save();
    row.response = await confirmApproval({ page, approvalId: id, decision: decision.decision });
    row.status = row.response.accepted ? 'accepted' : 'rejected'; await save();
    assert.equal(row.response.accepted, true, 'Exact original approval ID was not accepted');
    return true;
  }
}
async function run(name, prompt, target) {
  assert.ok(report.cases.length < maxRuns && !frozen);
  stage = name; pendingId = undefined;
  const item = { name, prompt, startedAt: new Date().toISOString(), decisions: [], status: 'running' }; report.cases.push(item); await save();
  await page.getByPlaceholder('和 Serika 聊天').fill(prompt); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const deadline = Date.now() + 600000;
  let seenRunning = false;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.runloom.snapshot());
    if (snapshot.state.kind !== 'idle') { seenRunning = true; item.runId = snapshot.state.runId; }
    if (snapshot.pendingHerdrSelection) await decide('selection', snapshot.pendingHerdrSelection);
    else if (snapshot.pendingApproval?.preview) {
      if (snapshot.pendingApproval.herdr && target) assert.deepEqual(snapshot.pendingApproval.herdr.target, target);
      await decide('approval', snapshot.pendingApproval);
    }
    if (frozen) throw new Error('Model spending frozen; no further task action');
    if (seenRunning && snapshot.state.kind === 'idle') {
      item.snapshot = snapshot; item.history = await page.evaluate(() => window.runloom.history());
      const receipt = await page.evaluate(id => window.runloom.getRun(id), item.runId);
      assert.ok(receipt.ok && receipt.run); item.receipt = receipt.run;
      if (receipt.run.tools.some(tool => tool.status === 'unknown')) { report.unknownEffect = true; throw new Error('Unknown effect: stop without Pi readback or cleanup'); }
      item.finishedAt = new Date().toISOString(); await shot(`${name}-settled`); await save();
      assert.equal(snapshot.lastPrimaryResult?.status, 'completed');
      return item;
    }
    await delay(100);
  }
  throw new Error('Original Run did not settle within its existing total timeout');
}
const messages = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message' && row.message?.role === 'user');
async function verifyPi(item, target, sessionFile, before, file, expected) {
  const controls = item.receipt.tools.filter(tool => tool.toolName === 'herdr_pi_control');
  assert.equal(controls.length, 1); assert.equal(controls[0].status, 'completed');
  item.approvalChain = approvalChain({ runId: item.runId, receipt: item.receipt, events: report.approvalEvents,
    decisions: item.decisions.filter(row => row.kind === 'approval').map(row => ({ ...row, decision: row.decision.decision })) });
  const approved = item.decisions.filter(decision => decision.value.herdr);
  item.actualArtifact = JSON.parse(await readFile(file, 'utf8'));
  const transcript = await messages(sessionFile); item.piUserMessagesAdded = transcript.length - before;
  await save();
  assert.equal(approved.length, 1); assert.deepEqual(approved[0].value.herdr.target, target);
  assert.equal(approved[0].status, 'accepted'); assert.equal(transcript.length, before + 1);
  const text = transcript.at(-1).message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.equal(text, approved[0].value.herdr.action.text);
  const artifact = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(artifact, expected);
  assert.ok(item.receipt.tools.some(tool => tool.toolName === 'herdr_pi_read' && tool.status === 'completed'));
  assert.ok(item.receipt.tools.some(tool => tool.toolName === 'read_file' && tool.status === 'completed' && tool.inputPreview.includes(file.split('/').at(-1))));
  item.actualArtifact = artifact; item.piUserMessagesAdded = transcript.length - before; item.status = 'passed'; await save();
}
try {
  const cli = await launch('orders');
  await writeFile(join(cli.work, 'input.json'), JSON.stringify({ quantity: 7, unitPrice: 8 }));
  const first = await run('ordinary-cli', '用 Node 读取 input.json，把 quantity 与 unitPrice 的乘积写入 answer.json 的 total 字段。完成后亲自检查文件和计算结果，告诉我结果。');
  assert.deepEqual(JSON.parse(await readFile(join(cli.work, 'answer.json'), 'utf8')), { total: 56 });
  assert.ok(first.receipt.tools.some(tool => tool.toolName === 'shell_exec' && tool.shell?.exitCode === 0));
  assert.ok(!first.receipt.tools.some(tool => tool.toolName === 'terminal_exec'), 'Shell acceptance cannot use terminal fallback');
  first.approvalChain = approvalChain({ runId: first.runId, receipt: first.receipt, events: report.approvalEvents,
    decisions: first.decisions.filter(row => row.kind === 'approval').map(row => ({ ...row, decision: row.decision.decision })) });
  first.status = 'passed'; first.actualArtifact = { total: 56 }; await save(); await stop();

  fixture = await setup(root, local + '/pi/v1', model); report.fixture = fixture; await save();
  const nonce = report.runId.slice(0, 8);
  const other = await addPi(fixture.statePath); report.secondPi = other; await save();
  const current = await launch('blue', fixture);
  await writeFile(join(fixture.work, 'blue.json'), JSON.stringify({ a: 5, b: 9, order: nonce + '-blue' }));
  const third = await run('multiple-pi', '请找一个现有 Pi，根据 blue.json 把 a 与 b 的和及原 order 写入 blue-answer.json，字段为 sum 和 order。完成后你亲自读文件核对。', other.target);
  assert.equal(third.decisions.filter(decision => decision.kind === 'selection').length, 1);
  const selection = third.decisions.find(decision => decision.kind === 'selection');
  assert.equal(selection.status, 'accepted'); assert.equal(selection.runId, third.runId);
  assert.deepEqual(selection.value.candidates[selection.decision.index].target, other.target);
  await verifyPi(third, other.target, other.piSession, 0, join(fixture.work, 'blue-answer.json'), { sum: 14, order: nonce + '-blue' });
  assert.equal(hash(await readFile(current.configPath)), report.launches.at(-1).configSha256Before); await stop();

  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: error.message.slice(0, 1500) };
  if (report.cases.at(-1)?.status === 'running') report.cases.at(-1).status = 'failed';
  if (running) await shot('failure').catch(() => {});
} finally {
  if (running) {
    const snapshot = await page.evaluate(() => window.runloom.snapshot()).catch(() => undefined);
    if (snapshot?.state.kind !== 'idle') await page.evaluate(() => window.runloom.cancel()).catch(() => {});
    await stop();
  }
  await new Promise(done => server.close(done));
  await Promise.all([...requests]);
  if (fixture && !frozen && !report.unknownEffect) {
    try { report.cleanup = await cleanup(fixture.statePath); }
    catch { report.cleanup = { status: 'retained-for-inspection', statePath: fixture.statePath }; }
  }
  if (fixture) {
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    await writeFile(join(output, 'herdr-state.json'), JSON.stringify(state, null, 2) + '\n');
    for (const [index, file] of (state.piSessions ?? []).entries()) {
      try { await writeFile(join(output, `pi-${index + 1}.jsonl`), await readFile(file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!report.unknownEffect && !frozen && (!fixture || report.cleanup?.phase === 'cleaned')) {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: 'ENOENT' }); report.temporaryDirectoryRemoved = true;
  }
  report.realModelCalls = report.calls.length;
  report.unresolvedReservedUsd = report.calls.filter(call => call.status !== 'returned').reduce((sum, call) => sum + call.reservedUsd, 0);
  report.finishedAt = new Date().toISOString(); await save();
  tell({ status: report.status, calls: report.calls.length, runs: report.cases.length, costUsd: report.costUsd, unresolvedReservedUsd: report.unresolvedReservedUsd, output });
}
if (report.status !== 'passed') process.exitCode = 1;
