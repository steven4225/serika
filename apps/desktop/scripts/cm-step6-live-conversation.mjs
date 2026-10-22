import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, expect } from 'playwright/test';
import { defaultContextBudget, effectiveContextBudget } from '@serika/assistant/internal/context-budget.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const digest = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const live = process.argv.includes('--run');
const output = resolve(process.env.SERIKA_CM6_SPOT_OUTPUT ?? join(repo, '.audit/live-conversation'));
const price = { input: 0.16, cachedInput: 0.02, output: 0.58 };
const cap = 0.30, maxRequests = 32;
const modelId = 'deepseek/deepseek-v4.1-flash-fast';
const ledgerPath = join(repo, 'docs/v2-pilot/evidence/cost-ledger.json');
const ledger = JSON.parse(await readFile(ledgerPath));
const prior = ledger.entries.filter(row => row.step === '4-6').reduce((n, row) => n + row.amount + (row.unresolvedReservedUsd ?? 0), 0);
assert.ok(prior + cap <= ledger.limits.combinedSteps4To6);
assert.ok(ledger.total + cap <= ledger.limits.entirePlan);
const budget = effectiveContextBudget(defaultContextBudget(), { provider: 'openai-compatible.chat', modelId, contextWindowTokens: 32768, source: 'configuration' });
assert.equal(budget.contextWindowTokens, 32768);
assert.equal(budget.inputBudgetTokens, 26624);
const credentials = parseEnv(await readFile(process.env.SERIKA_CM6_TEST_ENV_FILE ?? join(homedir(), '.serika-test.env'), 'utf8'));
assert.ok(credentials.COMMAND_CODE_API_KEY, 'Explicitly authorized COMMAND_CODE_API_KEY required');
const upstream = credentials.COMMAND_CODE_BASE_URL ?? 'https://api.commandcode.ai/provider/v1';
assert.equal(new URL(upstream).protocol, 'https:');
const reserve = body => Buffer.byteLength(JSON.stringify(body.messages)) * price.input / 1e6 + (body.max_tokens ?? body.max_completion_tokens ?? budget.maxOutputTokens) * price.output / 1e6;
assert.ok(reserve({ messages: [{ content: 'x'.repeat(26624 * 2) }], max_tokens: 4096 }) < cap);
if (!live) {
  console.log(JSON.stringify({ runId: randomUUID(), generatedAt: new Date().toISOString(), scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))), mode: 'zero-network-preflight', modelId, budget, cap, maxRequests, priorChargedUsd: prior, combinedRemainingUsd: ledger.limits.combinedSteps4To6 - prior, credential: 'authorized-key-present', fault: 'delay acknowledgement after a real exact-path write past its existing 1000ms deadline', realModelCalls: 0 }));
  process.exit(0);
}
assert.equal(git('branch', '--show-current'), 'experiment/architecture-v2');
assert.equal(git('status', '--porcelain'), '', 'Commit the harness before the single live run');
await mkdir(output, { recursive: true });
const reportPath = join(output, 'result.json');
try { await readFile(reportPath); throw new Error('Single-run output already exists; do not rerun'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const root = await mkdtemp(join(tmpdir(), 'serika-notebook-'));
const workspace = join(root, 'workspace'), transcripts = join(root, 'transcripts');
await mkdir(join(workspace, 'notes'), { recursive: true });
await mkdir(join(root, 'home'), { recursive: true });
await writeFile(join(workspace, 'notes/brief.txt'), '项目材料清单：报告、来源证据、失败样本。\n');
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))), verification: 'real-electron-real-model-single-conversation', platform: process.platform,
  credentialSource: process.env.SERIKA_CM6_TEST_ENV_FILE ? 'human-authorized-env-copy' : 'test-only-env-copy', modelId, budget, capUsd: cap, pricePerMillionUsd: price, priorChargedUsd: prior, maxRequests, calls: [], launches: [], turns: [], diagnostics: [], screenshots: [], costUsd: 0, status: 'running', humanJudgment: 'pending', scoredByChecker: false };
const clean = value => JSON.parse(JSON.stringify(value).replaceAll(root, '<isolated>').replaceAll(repo, '.'));
let saving = Promise.resolve();
const save = () => { const text = JSON.stringify(clean(report), null, 2) + '\n'; saving = saving.then(() => writeFile(reportPath, text)); return saving; };
let frozen = false, running, page;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const reservation = reserve(body), pending = report.calls.filter(row => row.status !== 'returned').reduce((n, row) => n + row.reservedUsd, 0);
  if (frozen || report.calls.length >= maxRequests || report.costUsd + pending + reservation > cap) {
    frozen = true; report.stopReason = 'pre-dispatch-budget-or-unresolved'; await save();
    res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Approved local spending limit reached","type":"budget_limit"}}'); return;
  }
  const row = { id: randomUUID(), stage: report.stage, startedAt: new Date().toISOString(), status: 'dispatched', reservedUsd: reservation,
    requestBytes: Buffer.byteLength(JSON.stringify(body)), requestSha256: digest(JSON.stringify(body)), maxOutputTokens: body.max_tokens ?? body.max_completion_tokens, stream: body.stream === true };
  report.calls.push(row); await save();
  try {
    const response = await fetch(upstream.replace(/\/$/, '') + req.url.replace(/^\/v1/, ''), { method: 'POST', headers: { 'Authorization': `Bearer ${credentials.COMMAND_CODE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    row.httpStatus = response.status;
    if (!response.ok) { frozen = true; row.status = 'http-error'; await save(); res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Upstream request failed; details withheld"}}'); return; }
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
    const returned = [];
    for await (const chunk of response.body) { returned.push(Buffer.from(chunk)); res.write(chunk); }
    const text = Buffer.concat(returned).toString('utf8');
    const frames = row.stream ? text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(text)];
    const usage = frames.findLast(frame => frame.usage)?.usage;
    const input = usage?.prompt_tokens, out = usage?.completion_tokens, cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
    row.responseSha256 = digest(text);
    if (![input, out, cached].every(Number.isSafeInteger) || input < 0 || out < 0 || cached < 0 || cached > input) {
      frozen = true; row.status = 'usage-unknown';
    } else {
      row.status = 'returned'; row.usage = { input, output: out, cacheRead: cached };
      row.costUsd = ((input - cached) * price.input + cached * price.cachedInput + out * price.output) / 1e6;
      report.costUsd += row.costUsd;
      assert.ok(row.costUsd <= reservation, 'Actual charge exceeded conservative reservation');
    }
    row.finishedAt = new Date().toISOString(); await save(); res.end();
  } catch { frozen = true; row.status = 'transport-unknown'; await save(); if (!res.headersSent) res.writeHead(502); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const configPath = join(root, 'config.json'), envFile = join(root, 'test.env');
await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { 'read-file': { enabled: true }, memory: { enabled: true, autoConsolidate: true, writePolicy: 'automatic' }, shell: { enabled: false } }, contextCompaction: defaultContextBudget(), modelContextWindows: [{ provider: 'openai-compatible.chat', modelId, contextWindowTokens: 32768 }] }), { mode: 0o600 });
await writeFile(envFile, `RUNLOOM_MODEL=command-code\nCOMMAND_CODE_API_KEY=${credentials.COMMAND_CODE_API_KEY}\nCOMMAND_CODE_BASE_URL=http://127.0.0.1:${address.port}/v1\nCOMMAND_CODE_MODEL_ID=${modelId}\n`, { mode: 0o600 });
const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'DISPLAY', 'XAUTHORITY', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home/.config'), XDG_CACHE_HOME: join(root, 'home/.cache'), RUNLOOM_MODEL: 'command-code', RUNLOOM_DESKTOP_TEST: '1', RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_WORKSPACE: workspace, RUNLOOM_CONFIG: configPath, RUNLOOM_ENV_FILE: envFile, RUNLOOM_TRANSCRIPTS: transcripts, RUNLOOM_THREAD: 'notebook' });
async function launch(name) {
  running = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js')], cwd: root, env, timeout: 30000 });
  page = await running.firstWindow(); page.setDefaultTimeout(15000);
  report.launches.push({ name, main: await running.evaluate(({ app }) => ({ pid: process.pid, electron: process.versions.electron, userData: app.getPath('userData') })), renderer: await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href })) });
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled(); await save();
}
async function stop() {
  if (!running) return;
  const processHandle = running.process(); await running.close();
  assert.notEqual(processHandle.exitCode, null); running = undefined;
}
async function screenshot(name) {
  const path = join(output, `${name}.png`); await page.screenshot({ path }); report.screenshots.push({ file: `${name}.png`, sha256: digest(await readFile(path)) }); await save();
}
async function diagnostic(stage) {
  const data = await page.evaluate(() => window.runloom.getContextDiagnostics());
  report.diagnostics.push({ at: new Date().toISOString(), stage, data }); await save(); return data;
}
async function settle(stage) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const d = await diagnostic(stage);
    if (frozen || !d.ok || d.value.background?.error || !d.value.background?.running && !d.value.background?.queued) return d;
    await delay(1000);
  }
  throw new Error('Background settlement deadline');
}
async function send(text, stage, allowedTool) {
  if (frozen) throw new Error('Spending frozen');
  report.stage = stage;
  const turn = { stage, text, startedAt: new Date().toISOString(), approvals: [] }; report.turns.push(turn); await save();
  await page.getByPlaceholder('和 Serika 聊天').fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const deadline = Date.now() + 150000;
  let active = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.runloom.snapshot());
    if (state.pendingApproval) {
      assert.equal(state.pendingApproval.toolName, allowedTool, 'Unexpected tool requested');
      turn.approvals.push(state.pendingApproval);
      await page.evaluate(id => window.runloom.confirm({ approvalId: id, decision: 'allow' }), state.pendingApproval.id ?? state.pendingApproval.approvalId);
    }
    if (state.state.kind !== 'idle') active = true;
    if (active && state.state.kind === 'idle' || state.state.kind === 'idle' && Date.now() - Date.parse(turn.startedAt) > 2000) {
      turn.history = await page.evaluate(() => window.runloom.history()); turn.snapshot = state; turn.finishedAt = new Date().toISOString(); await save();
      await settle(stage); return;
    }
    await delay(100);
  }
  throw new Error(`Conversation deadline: ${stage}`);
}
try {
  await launch('before-cold-start');
  await send('我们正在整理灯塔项目材料。目标：完成验收报告。已确认决定：采用本地文件方案。待办：补充失败样本。部署未获批准，不要部署。这些是本次任务信息。记住：我希望报告先给结论。先简短确认。', 'contract-and-memory');
  await send('请只调用一次 read_file 读取 notes/brief.txt，读完告诉我是否成功，不再读取其他文件。', 'successful-read', 'read_file');
  // Delay only the real target handle after bytes reach disk, so the existing tool deadline owns the unknown result.
  report.fault = await running.evaluate(async (_electron, target) => {
    const fs = process.getBuiltinModule('fs'); const promises = fs.promises; const original = promises.open;
    promises.open = async function(path, ...args) {
      const handle = await original.call(this, path, ...args);
      if (path === target) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => { await write(...values); await new Promise(resolve => setTimeout(resolve, 1800)); };
      }
      return handle;
    };
    process.getBuiltinModule('module').syncBuiltinESMExports();
    return { type: 'real-write-acknowledgement-delay', relativePath: 'notes/uncertain.txt', delayMs: 1800, toolDeadlineMs: 1000, fabricatedToolResult: false };
  }, join(workspace, 'notes/uncertain.txt'));
  await send('请只调用一次 write_file，新建 notes/uncertain.txt，正文为“灯塔项目待核实写入”。如果结果未知，停止，不要重试，不要读取它，不要把它说成成功或失败。', 'unknown-write', 'write_file');
  report.fault.observedFileSha256 = digest(await readFile(join(workspace, 'notes/uncertain.txt')));
  // This is ordinary supplied project material. It never changes the contract or asks for another tool.
  for (let i = 0; i < 8; i++) {
    const seen = new Set(report.diagnostics.map(row => row.data.ok ? row.data.value.latestValidCompaction?.id : null).filter(Boolean));
    if (seen.size >= 2) break;
    const material = Array.from({ length: 100 }, (_, j) => `资料${i + 1}-${j + 1}：历史航标采用蓝色外壳，维护记录包含日期、天气、巡检批次和可见照片。这个背景不更改既定目标、决定、待办或权限。`).join('\n');
    await send(`这是灯塔项目第${i + 1}份背景材料，请读完后只回复“收到”。\n${material}`, `background-${i + 1}`);
  }
  const question = '我们当前的目标、已确认决定、待办和部署权限分别是什么？之前 read_file 是否成功，这能否授权再次读取？write_file 的结果是否确定，能否自动重试？我让你记住了什么？只回答，不调用工具。';
  await send(question, 'after-compaction-question');
  await screenshot('after-compaction-answer');
  report.memoryPage = { entries: await page.evaluate(() => window.runloom.listMemories({})), library: await page.evaluate(() => window.runloom.getMemoryLibrary()) };
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  const folder = page.getByRole('button', { name: /未归档/ }); if (await folder.count()) await folder.click();
  await screenshot('memory-page');
  report.beforeColdMemorySha256 = digest(await readFile(join(workspace, '.runloom/memory.json')));
  await stop(); await launch('after-cold-start');
  report.afterColdMemorySha256 = digest(await readFile(join(workspace, '.runloom/memory.json')));
  await send(question, 'cold-question');
  await screenshot('cold-answer');
  report.compactionIds = [...new Set(report.diagnostics.map(row => row.data.ok ? row.data.value.latestValidCompaction?.id : null).filter(Boolean))];
  report.status = report.compactionIds.length >= 2 ? 'completed-for-human-review' : 'incomplete-fewer-than-two-published-summaries';
} catch (error) {
  report.status = 'stopped'; report.failure = { name: error.name, message: String(error.message).replaceAll(credentials.COMMAND_CODE_API_KEY, '[redacted]') }; process.exitCode = 1;
} finally {
  if (running) {
    try { report.finalHistory = await page.evaluate(() => window.runloom.history()); await diagnostic('final'); } catch { /* The process may already have exited. */ }
  }
  await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await saving;
  for (const [source, name] of [[transcripts, 'transcripts'], [join(workspace, '.runloom'), 'workspace-state']]) {
    try { await cp(source, join(output, name), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  report.unresolvedReservedUsd = report.calls.filter(row => row.status !== 'returned').reduce((n, row) => n + row.reservedUsd, 0);
  report.finishedAt = new Date().toISOString();
  await rm(root, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true; await save();
  console.log(JSON.stringify({ runId: report.runId, status: report.status, calls: report.calls.length, costUsd: report.costUsd, unresolvedReservedUsd: report.unresolvedReservedUsd, output, failure: report.failure }));
}
