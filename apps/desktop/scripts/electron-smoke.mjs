import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readTuiModuleConfig } from '@serika/assistant/internal/tui-module-config.js';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(desktop, '../..');
const script = fileURLToPath(import.meta.url);
const evidence = join(repo, 'docs/v2-pilot/evidence/electron-smoke');
const digest = data => createHash('sha256').update(data).digest('hex');
const hash = async path => digest(await readFile(path));
const report = { verification: 'real-electron-with-fake-model', platform: process.platform,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  scriptSha256: await hash(script), sourceWorktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), realModelCalls: 0, costUsd: 0, checks: [], launches: [], screenshots: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false, 'Smoke evidence requires a clean source checkout; commit source changes first');
const root = await mkdtemp(join(tmpdir(), 'serika-electron-smoke-'));
report.sourceHashes = { 'pnpm-lock.yaml': await hash(join(repo, 'pnpm-lock.yaml')) };
report.artifactHashes = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(async path => [path, await hash(join(desktop, path))])));
let running;
await mkdir(evidence, { recursive: true });
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
// Keep Electron/Node diagnostics out of inherited credential and daily startup environments.
await mkdir(join(root, 'home'), { recursive: true });
Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home/.config'), XDG_CACHE_HOME: join(root, 'home/.cache'), RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1' });
async function setup(name, config) {
  const dir = join(root, name), workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const configPath = join(dir, 'config.json'), envFile = join(dir, 'test.env');
  await writeFile(configPath, JSON.stringify(config ?? { version: 1, authorizedDirectory: workspace, modules: { memory: { enabled: true, autoConsolidate: true }, shell: { enabled: false } } }), { mode: 0o600 });
  await writeFile(envFile, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
  return { ...env, RUNLOOM_USER_DATA: join(dir, 'profile'), RUNLOOM_WORKSPACE: workspace, RUNLOOM_CONFIG: configPath,
    RUNLOOM_ENV_FILE: envFile, RUNLOOM_TRANSCRIPTS: join(dir, 'transcripts'), RUNLOOM_THREAD: 'electron-smoke' };
}
async function launch(launchEnv, name) {
  running = await electron.launch({ args: [join(desktop, 'out/main/index.js'), '--home', join(launchEnv.HOME, '.serika')], cwd: root, env: launchEnv, timeout: 30000 });
  const page = await running.firstWindow();
  page.setDefaultTimeout(15000);
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
  assert.ok(main.electron); assert.equal(main.userData, launchEnv.RUNLOOM_USER_DATA); assert.equal(main.home, launchEnv.HOME);
  const renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href }));
  assert.match(renderer.userAgent, /Electron\//); assert.match(renderer.url, /^file:/);
  report.launches.push({ name, main, renderer });
  return page;
}
async function stop() {
  if (!running) return;
  const child = running.process();
  await running.close();
  assert.notEqual(child.exitCode, null, 'Full Electron process must exit before returning');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  running = undefined;
}
async function screenshot(page, name) {
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path });
  const item = { file: `${name}.png`, sha256: await hash(path) };
  report.screenshots.push(item);
  return item;
}
const unexpectedSelector = '[role="alert"]:visible, [class*="error"]:visible, [class*="warning"]:visible, .status-failed:visible, .status-unknown:visible, .status-timed_out:visible';
async function assertNoUnexpectedErrors(page, expectedError) {
  const visible = (await page.locator(unexpectedSelector).allTextContents()).map(text => text.trim());
  if (expectedError) {
    assert.equal(visible.length, 1, 'Only the explicitly expected failure may be visible');
    assert.ok(visible[0].includes(expectedError), 'Unexpected error/warning instead of the expected failure');
  } else assert.deepEqual(visible, [], 'No unexpected visible error or warning');
  return { unexpectedErrors: 0, expectedErrors: expectedError ? [expectedError] : [], observedErrorCount: visible.length };
}
async function check(name, page, details = {}, expectedError) {
  const errors = await assertNoUnexpectedErrors(page, expectedError);
  report.checks.push({ name, result: 'passed', ...details, ...errors, screenshot: await screenshot(page, name) });
}
async function ready(page) {
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  await assertNoUnexpectedErrors(page);
}
async function send(page, text) {
  const before = await page.getByText('离线冒烟回复完成。', { exact: true }).count();
  await page.getByPlaceholder('和 Serika 聊天').fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('离线冒烟回复完成。', { exact: true })).toHaveCount(before + 1);
  await expect(page.getByRole('button', { name: '停止本轮', exact: true })).toHaveCount(0);
  await assertNoUnexpectedErrors(page);
}
const memoryFile = launchEnv => join(launchEnv.RUNLOOM_WORKSPACE, '.runloom/memory.json');

try {
  const primary = await setup('primary');
  let page = await launch(primary, 'before-restart');
  await ready(page);
  await check('startup', page);
  await send(page, '你好');
  await check('chat-reply', page);
  const text = '冒烟测试偏好：报告先写结论。';
  await send(page, `记住 ${text}`);
  const receipt = page.locator('.memory-fact-receipt').filter({ hasText: '已保存' });
  await expect(receipt).toHaveCount(1);
  await expect(receipt.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await check('remember-success-receipt', page, { source: 'v6-record', undoAvailable: true });
  const hostMemory = await page.evaluate(() => window.runloom.listMemories({}));
  const hostSnapshot = await page.evaluate(() => window.runloom.snapshot());
  const hostLibrary = await page.evaluate(() => window.runloom.getMemoryLibrary());
  report.rememberDiagnostic = { libraryCount: hostLibrary.ok ? hostLibrary.value.documents.length : null, memoryCount: hostMemory.ok ? hostMemory.value.entries.length : null, toolResults: hostSnapshot.toolActivity.map(({ toolName, status, errorCode }) => ({ toolName, status, errorCode })) };
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: /未归档/ }).click();
  await expect(page.locator('.memory-document-tile').filter({ hasText: text })).toHaveCount(1);
  let saved = JSON.parse(await readFile(memoryFile(primary), 'utf8'));
  assert.equal(saved.version, 6);
  assert.ok(saved.entries.some(entry => entry.text === text && entry.state === 'active'));
  await check('remember-on-memory-page', page);
  await stop();
  const beforeHash = await hash(memoryFile(primary));
  page = await launch(primary, 'after-restart');
  await ready(page);
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: /未归档/ }).click();
  await expect(page.locator('.memory-document-tile').filter({ hasText: text })).toHaveCount(1);
  const afterHash = await hash(memoryFile(primary));
  assert.equal(beforeHash, afterHash);
  assert.notEqual(report.launches[0].main.pid, report.launches[1].main.pid);
  report.restart = { beforePid: report.launches[0].main.pid, afterPid: report.launches[1].main.pid,
    beforeMemorySha256: beforeHash, afterMemorySha256: afterHash };
  await check('restart-persistence', page);
  await page.locator('.memory-fact-receipt').filter({ hasText: '已保存' }).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.memory-fact-receipt').filter({ hasText: '已撤回' })).toBeVisible();
  await assertNoUnexpectedErrors(page);
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.locator('.memory-document-tile').filter({ hasText: text })).toHaveCount(0);
  saved = JSON.parse(await readFile(memoryFile(primary), 'utf8'));
  assert.ok(saved.entries.some(entry => entry.text === text && entry.state === 'retracted'));
  await check('undo-disappears', page);
  await stop();

  const daily = process.platform === 'darwin' ? join(env.HOME, 'Library/Application Support/@aisdk-agent/desktop') : join(env.HOME, '.config/@aisdk-agent/desktop');
  await mkdir(daily, { recursive: true });
  const sentinel = join(daily, 'smoke-sentinel');
  await writeFile(sentinel, 'isolated daily-path guard fixture');
  const sentinelHash = await hash(sentinel);
  const guarded = await setup('guard');
  const guardConfig = JSON.parse(await readFile(guarded.RUNLOOM_CONFIG, 'utf8'));
  guardConfig.authorizedDirectory = daily;
  await writeFile(guarded.RUNLOOM_CONFIG, JSON.stringify(guardConfig), { mode: 0o600 });
  guarded.RUNLOOM_WORKSPACE = daily;
  page = await launch(guarded, 'daily-path-guard');
  await expect(page.getByRole('alert').filter({ hasText: '实验版本拒绝写入日用数据目录' })).toBeVisible();
  await check('daily-path-refuses-writes', page, {}, '实验版本拒绝写入日用数据目录');
  await stop();
  assert.deepEqual(await readdir(daily), ['smoke-sentinel']);
  assert.equal(await hash(sentinel), sentinelHash);
  report.dailyGuard = { beforeSentinelSha256: sentinelHash, afterSentinelSha256: await hash(sentinel), onlySentinelRemains: true, configuredWorkspace: daily, error: '实验版本拒绝写入日用数据目录',
    assertionBeforeRuntimeCreation: 'apps/desktop/src/main/desktop-runtime.ts', dailyTreeTraversed: false, isolatedHome: true };

  const dailyConfig = process.env.RUNLOOM_SMOKE_DAILY_CONFIG ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/@aisdk-agent/desktop/runloom.json' : '.config/@aisdk-agent/desktop/runloom.json');
  const copyEnv = await setup('daily-config-copy');
  const sample = join(desktop, 'scripts/fixtures/retired-config.json');
  let sourceKind = '日用配置副本';
  let configBytes;
  try { configBytes = await readFile(dailyConfig); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sourceKind = '样例'; configBytes = await readFile(sample);
  }
  report.configSource = { kind: sourceKind, sha256: digest(configBytes), ...(sourceKind === '样例' ? { file: 'apps/desktop/scripts/fixtures/retired-config.json' } : {}) };
  const copy = JSON.parse(configBytes.toString('utf8'));
  delete copy.workspace;
  copy.authorizedDirectory = copyEnv.RUNLOOM_WORKSPACE;
  if (copy.modules?.memory) delete copy.modules.memory.writePolicy;
  // Exclude daily trust/channel bindings and credentials; preserve memory options for strict validation.
  if (copy.telegramAutonomy) copy.telegramAutonomy = { authorizedDirectory: copyEnv.RUNLOOM_WORKSPACE, botId: 1, userId: 1, chatId: 1, threadId: 'smoke-only', ...('toolApproval' in copy.telegramAutonomy ? { toolApproval: 'smoke-only' } : {}) };
  if (copy.desktopAutonomy) copy.desktopAutonomy = { authorizedDirectory: copyEnv.RUNLOOM_WORKSPACE };
  if (copy.herdrBinding) copy.herdrBinding = { workspaceRoot: copyEnv.RUNLOOM_WORKSPACE, session: 'smoke-only', paneId: 'smoke-only', terminalId: 'smoke-only' };
  for (const [id, module] of Object.entries(copy.modules ?? {})) if (id !== 'memory') copy.modules[id] = { enabled: false };
  await writeFile(copyEnv.RUNLOOM_CONFIG, JSON.stringify(copy), { mode: 0o600 });
  page = await launch(copyEnv, 'daily-config-copy');
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  const error = await alert.innerText();
  assert.match(error, /Invalid TUI config schema/);
  // Probe the same production parser; the final successful read proves this list covers the copied config.
  const retiredPaths = ['modules.memory.queryRewrite', 'modules.memory.semantic', 'modules.memory.contextView',
    'contextCompaction.mode', 'contextCompaction.warningRatio', 'herdrBinding', 'telegramAutonomy.toolApproval'];
  const cleaned = structuredClone(copy), removed = [];
  for (const path of retiredPaths) {
    const keys = path.split('.'), key = keys.pop(), parent = keys.reduce((value, part) => value?.[part], cleaned);
    if (parent && key in parent) { removed.push({ path, value: parent[key] }); delete parent[key]; }
  }
  const probePath = join(root, 'schema-probe.json');
  await writeFile(probePath, JSON.stringify(cleaned), { mode: 0o600 });
  await readTuiModuleConfig(probePath);
  for (const { path, value } of removed) {
    const probe = structuredClone(cleaned), keys = path.split('.'), key = keys.pop();
    keys.reduce((object, part) => object[part], probe)[key] = value;
    await writeFile(probePath, JSON.stringify(probe), { mode: 0o600 });
    await assert.rejects(readTuiModuleConfig(probePath), /Invalid TUI config schema/);
  }
  assert.ok(removed.length > 0);
  report.retiredFields = removed.map(({ path }) => path);
  report.configDiagnostics = { actualElectronError: 'Invalid TUI config schema',
    parser: 'readTuiModuleConfig', cleanedCopyAccepted: true, individuallyRejectedFields: report.retiredFields };
  await check('daily-config-retired-fields', page, { configSource: sourceKind, retiredFields: report.retiredFields }, 'Invalid TUI config schema');
  await stop();
  assert.equal(report.checks.length, 8);
  report.status = 'passed';
} catch (error) {
  console.error('Smoke failure:', error.message);
  report.failure = { name: error.name, message: error.message.slice(0, 1500) };
  if (running) {
    const page = running.windows()[0];
    if (page) await screenshot(page, 'failure').catch(() => {});
  }
} finally {
  await stop().catch(error => { report.status = 'failed'; report.cleanupError = error.message; });
  await rm(root, { recursive: true });
  await assert.rejects(access(root), { code: 'ENOENT' });
  report.temporaryDirectoryRemoved = true;
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.map(({ name, result }) => ({ name, result })), failure: report.failure }));
if (report.status !== 'passed') process.exitCode = 1;
