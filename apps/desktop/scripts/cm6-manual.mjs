import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, rename, lstat, readdir, cp, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { _electron as electron, expect } from 'playwright/test';
import { installOpenFault } from './cm-step6-open-fault.mjs';
import { startTransport, modelId, prices } from './cm6-manual-transport.mjs';

export const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const faultSha = '665c1b4a8eb125c0fe9b4e95465fd69405efa6e7095a45f082f9c2a62c700eff';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
export const baseDirectory = join(tmpdir(), `serika-cm6-manual-${process.getuid?.() ?? 'user'}-${sha(repo).slice(0, 12)}`);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => { await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(path + '.tmp', path); };
const append = (path, value) => appendFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
const lines = async path => { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

async function lock(base) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  assert.equal((await lstat(base)).isSymbolicLink(), false);
  const path = join(base, 'active.json');
  if (await exists(path)) {
    const owner = await json(path);
    try { process.kill(owner.pid, 0); throw new Error('测试启动器仍在运行，请先退出测试应用和终端命令'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await rm(path);
  }
  await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return () => rm(path);
}

async function currentRoot(base) {
  const { directory } = await json(join(base, 'current.json'));
  assert.match(directory, /^test-[0-9a-f-]+$/);
  const root = join(base, directory);
  assert.equal(await realpath(root), root, '测试目录不能是符号链接');
  return root;
}

export async function validateFault(workspace, path) {
  assert.ok(path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..'), '故障路径必须是 workspace 内的新相对文件');
  assert.notEqual(path, 'notes/uncertain.txt', '不能复用之前的 notes/uncertain.txt');
  assert.ok(!path.startsWith('.runloom/'), '不能注入内部状态文件');
  let cursor = workspace;
  for (const part of path.split('/').slice(0, -1)) {
    cursor = join(cursor, part); const stat = await lstat(cursor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), '故障文件父目录必须存在且不是符号链接');
  }
  assert.equal(await exists(join(workspace, path)), false, '故障路径已存在，请换新文件或 --fresh');
  return join(workspace, path);
}

async function credentials() {
  let values = process.env;
  const path = process.env.SERIKA_CM6_TEST_ENV_FILE ?? join(homedir(), '.serika-test.env');
  if (!values.COMMAND_CODE_API_KEY && await exists(path)) values = parseEnv(await readFile(path, 'utf8'));
  if (!values.COMMAND_CODE_API_KEY) throw new Error('缺少 COMMAND_CODE_API_KEY。请在终端环境或 ~/.serika-test.env 提供测试密钥；不会读取日用配置。');
  const url = new URL(values.COMMAND_CODE_BASE_URL ?? 'https://api.commandcode.ai/provider/v1');
  assert.equal(url.protocol, 'https:'); assert.ok(!url.username && !url.password && !url.search && !url.hash);
  return { key: values.COMMAND_CODE_API_KEY, baseURL: url.href.replace(/\/$/, '') };
}

export async function startManual({ base = baseDirectory, fresh = false, faultPath, respond } = {}) {
  assert.equal(git('branch', '--show-current'), 'experiment/architecture-v2', '只允许实验分支');
  assert.equal(sha(await readFile(new URL('./cm-step6-open-fault.mjs', import.meta.url))), faultSha);
  await mkdir(base, { recursive: true, mode: 0o700 });
  assert.equal((await lstat(base)).isSymbolicLink(), false);
  base = await realpath(base);
  const unlock = await lock(base);
  let app, transport, timer, closing = false, queue = Promise.resolve(), root;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  try {
    const credential = respond ? undefined : await credentials();
    if (fresh || !await exists(join(base, 'current.json'))) {
      const directory = `test-${randomUUID()}`; root = join(base, directory);
      for (const name of ['home', 'profile', 'workspace/notes', 'transcripts', 'captures']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
      await writeFile(join(root, 'workspace/notes/brief.txt'), '灯塔项目材料清单：验收报告、来源证据、失败样本。\n', { mode: 0o600 });
      await save(join(root, 'session.json'), { id: directory, createdAt: new Date().toISOString(), mock: !!respond, modelId,
        pricesPerMillionUsd: prices, pricingBasis: 'configured usage-derived estimate, not provider invoice', faultPath: faultPath ?? null });
      await save(join(base, 'current.json'), { directory });
    } else root = await currentRoot(base);
    const session = await json(join(root, 'session.json'));
    assert.equal(session.mock, !!respond, '不能混用真实与假模型目录，请 --fresh');
    assert.equal(faultPath ?? null, session.faultPath, '重开时请使用相同故障参数；改变参数请 --fresh');
    const workspace = join(root, 'workspace');
    for (const name of ['profile', 'home', 'workspace', 'transcripts', 'captures']) assert.equal(await realpath(join(root, name)), join(root, name));
    const faultTarget = faultPath ? await validateFault(workspace, faultPath) : null;
    const { defaultContextBudget } = await import('@serika/assistant/internal/context-budget.js');
    await save(join(root, 'config.json'), { version: 1, workspace,
      modules: { 'read-file': { enabled: true }, memory: { enabled: true, autoConsolidate: true, writePolicy: 'automatic' }, shell: { enabled: false } },
      contextCompaction: defaultContextBudget(), modelContextWindows: [{ provider: 'openai-compatible.chat', modelId, contextWindowTokens: 32768 }] });
    let observeRequest = async () => {};
    transport = await startTransport({ root, credential, respond, observe: () => observeRequest() });
    const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'DISPLAY', 'XAUTHORITY', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
    Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home/.config'), XDG_CACHE_HOME: join(root, 'home/.cache'),
      RUNLOOM_MODEL: 'command-code', COMMAND_CODE_API_KEY: transport.token, COMMAND_CODE_BASE_URL: transport.url, COMMAND_CODE_MODEL_ID: modelId,
      RUNLOOM_DESKTOP_TEST: '1', RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_CONFIG: join(root, 'config.json'),
      RUNLOOM_WORKSPACE: workspace, RUNLOOM_TRANSCRIPTS: join(root, 'transcripts'), RUNLOOM_THREAD: 'cm6-manual' });
    app = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js')], cwd: root, env, timeout: 30000 });
    if (faultTarget) await app.evaluate(installOpenFault, faultTarget);
    const page = await app.firstWindow();
    await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled({ timeout: 30000 });
    const launchId = randomUUID();
    await append(join(root, 'launches.jsonl'), { launchId, at: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD'),
      sourceWorktreeDirty: !!git('status', '--porcelain'), platform: process.platform, mock: !!respond, faultScriptSha256: faultSha,
      process: await app.evaluate(({ app }) => ({ pid: process.pid, electron: process.versions.electron, userData: app.getPath('userData'), home: app.getPath('home') })) });
    let lastState = '', lastDiagnostic = '', count = 0;
    const published = new Set((await lines(join(root, 'captures/diagnostics.jsonl'))).map(row => row.diagnostic?.value?.latestValidCompaction?.id).filter(Boolean));
    async function capture() {
      const data = await page.evaluate(async () => {
        const [history, diagnostic, entries, library, snapshot] = await Promise.all([window.runloom.history(), window.runloom.getContextDiagnostics(),
          window.runloom.listMemories({}), window.runloom.getMemoryLibrary(), window.runloom.snapshot()]);
        const documents = library.ok ? await Promise.all(library.value.documents.map(doc => window.runloom.readMemoryDocument(doc.id))) : [];
        return { history, diagnostic, memory: { entries, library, documents }, snapshot };
      });
      assert.ok(data.diagnostic.ok, '上下文诊断读取失败');
      assert.equal(data.diagnostic.value.budget.contextWindowTokens, 32768);
      const state = JSON.stringify({ history: data.history, memory: data.memory, snapshot: data.snapshot });
      if (state !== lastState) { await save(join(root, 'captures/latest.json'), data); lastState = state; }
      const diag = JSON.stringify(data.diagnostic);
      if (diag !== lastDiagnostic) {
        await append(join(root, 'captures/diagnostics.jsonl'), { launchId, at: new Date().toISOString(), diagnostic: data.diagnostic }); lastDiagnostic = diag;
        const id = data.diagnostic.value.latestValidCompaction?.id;
        if (id && !published.has(id)) { published.add(id); console.log(`后台摘要已发布，累计 ${published.size} 次。`); }
      }
      if (faultTarget) {
        const fault = await app.evaluate(() => globalThis.__cm6WriteFault);
        await save(join(root, `captures/fault-${launchId}.json`), { launchId, path: faultPath, ...fault, exists: await exists(faultTarget) });
      }
      count++;
    }
    const enqueue = () => {
      queue = queue.then(capture).catch(async error => {
        if (!closing) { console.error('记录失败，已停止测试，请导出检查。'); await append(join(root, 'capture-errors.jsonl'), { at: new Date().toISOString(), message: error.message }); setTimeout(() => { void stop(); }, 0); }
      });
      return queue;
    };
    observeRequest = enqueue;
    await page.exposeFunction('__cm6Record', message => append(join(root, 'captures/events.jsonl'), { launchId, at: new Date().toISOString(), message }));
    await page.exposeFunction('__cm6Input', text => append(join(root, 'captures/inputs.jsonl'), { launchId, at: new Date().toISOString(), text }));
    await page.evaluate(() => window.runloom.onMessage(message => { void window.__cm6Record(message); }));
    await page.evaluate(() => {
      const record = () => {
        const input = document.querySelector('[aria-label="消息输入"]');
        const send = document.querySelector('[aria-label="发送消息"]');
        if (input?.value && send && !send.disabled) void window.__cm6Input(input.value);
      };
      document.addEventListener('click', event => { if (event.target.closest('[aria-label="发送消息"]')) record(); }, true);
      document.addEventListener('keydown', event => {
        if (event.target.matches('[aria-label="消息输入"]') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) record();
      }, true);
    });
    await capture();
    timer = setInterval(() => { if (!closing) void enqueue(); }, 500);
    // The normal app hides on close. This test window must exit for an actual cold start.
    await app.evaluate(({ BrowserWindow, app }) => { BrowserWindow.getAllWindows()[0].on('close', () => app.quit()); });
    app.on('close', () => { void finish(); });
    async function finish() {
      if (closing) return; closing = true; clearInterval(timer);
      await queue; await transport.close();
      await append(join(root, 'launches.jsonl'), { launchId, event: 'closed', at: new Date().toISOString(), captures: count });
      await unlock(); resolveClosed();
    }
    async function stop() {
      if (closing) return;
      clearInterval(timer);
      await queue;
      try { await capture(); } catch { /* Last successful snapshot and raw transcripts remain available. */ }
      await app.close(); await finish();
    }
    console.log(`CM6 ${respond ? '假模型自测' : '真实模型手动测试'}已就绪\n隔离目录：${root}\n32K / 输入 26624；故障路径：${faultPath ?? '关闭'}\n关闭测试窗口后可用同一命令冷启动；--fresh 新建测试，旧目录保留。`);
    return { root, app, page, stop, closed, capture: enqueue };
  } catch (error) {
    closing = true; clearInterval(timer);
    if (app) await app.close(); if (transport) await transport.close(); await unlock(); throw error;
  }
}

export async function exportManual({ base = baseDirectory } = {}) {
  base = await realpath(base); const unlock = await lock(base);
  try {
    const root = await currentRoot(base), latest = await json(join(root, 'captures/latest.json'));
    const output = join(root, 'exports', randomUUID()); await mkdir(output, { recursive: true });
    for (const name of ['captures', 'transcripts', 'workspace', 'launches.jsonl', 'requests.jsonl', 'session.json', 'config.json', 'capture-errors.jsonl']) {
      if (await exists(join(root, name))) await cp(join(root, name), join(output, name), { recursive: true, dereference: false });
    }
    const { JsonlAgentStore } = await import('@serika/core');
    const store = new JsonlAgentStore({ directory: join(output, 'transcripts') });
    const history = await store.getMessages('cm6-manual');
    const compactions = await store.getContextCompactions('cm6-manual');
    await save(join(output, 'history.json'), history);
    await save(join(output, 'compactions.json'), compactions);
    await save(join(output, 'memory-page.json'), latest.memory);
    const diagnostics = await lines(join(root, 'captures/diagnostics.jsonl'));
    const events = await lines(join(root, 'captures/events.jsonl'));
    const inputs = await lines(join(root, 'captures/inputs.jsonl'));
    const timeline = [...inputs.map(row => ({ ...row, kind: '用户发送原文', text: row.text })),
      ...events.filter(row => row.message.phase === 'primary' && (row.message.type === 'result' || row.message.type === 'event' && row.message.event.type.startsWith('tool.call.')))
        .map(row => ({ ...row, kind: row.message.type === 'result' ? '助手结果与运行状态' : '工具原始回执', text: '```json\n' + JSON.stringify(row.message, null, 2) + '\n```' }))]
      .sort((a, b) => a.at.localeCompare(b.at));
    await writeFile(join(output, 'dialogue.md'), '# 完整对话原文\n\n用户发送由输入框发送事件记录，包含失败运行；助手结果与工具回执由原 IPC 记录。提交后的完整消息对象另见 history.json，逐字流另见 captures/events.jsonl。\n\n' +
      timeline.map(row => `## ${row.kind} ${row.at}\n\n${row.text}`).join('\n\n'));
    const ids = [...new Set(diagnostics.map(d => d.diagnostic.value?.latestValidCompaction?.id).filter(Boolean))];
    const preparations = [...new Map(diagnostics.filter(d => d.diagnostic.value?.lastPreparation).map(d => {
      const p = d.diagnostic.value.lastPreparation; return [JSON.stringify(p), p];
    })).values()];
    await save(join(output, 'context-diagnostics.json'), { publishedCompactionIds: compactions.map(r => r.id), publishedCompactionCount: compactions.length,
      observedValidCompactionIds: ids, observedValidCompactionCount: ids.length,
      prepareFailures: preparations.filter(p => p.error?.code === 'CONTEXT_PREPARE_FAILED'),
      backgroundFailures: diagnostics.filter(d => d.diagnostic.value.background?.error),
      prepareFailureEvents: events.filter(e => JSON.stringify(e.message).includes('CONTEXT_PREPARE_FAILED')),
      emergencyMasking: preparations.flatMap(p => (p.degradation?.emergencyMasking ?? []).map(e => ({ at: p.at, ...e }))),
      diagnostics, observation: 'Process diagnostics sampled every 500ms and before each model request; raw transcripts and events included. No checker grading.' });
    const requests = await lines(join(root, 'requests.jsonl'));
    const calls = requests.filter(r => r.event === 'started').map(start => ({ ...start, ...(requests.findLast(r => r.id === start.id && r.event === 'finished') ?? { status: 'unfinished-usage-unknown', usage: null, costUsd: null }) }));
    await save(join(output, 'costs.json'), { pricesPerMillionUsd: prices, basis: 'Provider usage at configured rates; not invoice. Missing usage/cost is unknown, never zero.', calls,
      knownCostUsd: calls.reduce((n, r) => n + (r.costUsd ?? 0), 0), unknownCostRequests: calls.filter(r => r.costUsd === null).length });
    const hashes = {};
    async function scan(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), '导出含符号链接，停止打包');
      if (entry.isDirectory()) await scan(path); else hashes[relative(output, path)] = sha(await readFile(path));
    } }
    await scan(output); await save(join(output, 'manifest.json'), { runId: randomUUID(), at: new Date().toISOString(), hashes });
    console.log(`导出完成：${output}`); return output;
  } finally { await unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter(a => a !== '--');
    assert.ok(args.every(a => a === '--fresh' || a === '--export' || a.startsWith('--fault-unknown-write=')), '未知参数');
    if (args.includes('--export')) { assert.equal(args.length, 1); await exportManual(); }
    else {
      assert.equal(git('branch', '--show-current'), 'experiment/architecture-v2', '请在实验分支运行');
      execFileSync('pnpm', ['build'], { cwd: repo, stdio: 'inherit' });
      const run = await startManual({ fresh: args.includes('--fresh'), faultPath: args.find(a => a.startsWith('--fault-unknown-write='))?.split('=').slice(1).join('=') });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void run.stop(); });
      await run.closed;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
