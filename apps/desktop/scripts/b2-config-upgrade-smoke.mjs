import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(join(repo, 'apps/desktop/package.json'));
const { _electron: electron, expect } = require('playwright/test');
const runId = randomUUID(), evidence = resolve(process.argv[2] ?? join(tmpdir(), `serika-b2-upgrade-${runId}`));
const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-b2-upgrade-electron-')));
const home = join(root, 'home'), appHome = join(home, '.serika'), project = join(root, 'project'), configPath = join(appHome, 'config.json');
await Promise.all([appHome, project, evidence].map(path => mkdir(path, { recursive: true })));
const original = JSON.stringify({ version: 1, authorizedDirectory: project, desktopAutonomy: { authorizedDirectory: project }, telegramAutonomy: { authorizedDirectory: project, botId: 1, userId: 2, chatId: 3, threadId: 'test' }, modules: { 'read-file': { enabled: true }, memory: { enabled: false }, shell: { enabled: false, timeoutMs: 300000 } }, run: { totalTimeoutMs: 600000 } }, null, 4) + '\n\n';
await writeFile(configPath, original, { mode: 0o600 });
const envFile = join(root, 'test.env'); await writeFile(envFile, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'SERIKA_TEST_VIOLATIONS', 'SERIKA_TEST_PROTECTED_ROOT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: home, RUNLOOM_ENV_FILE: envFile, RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1', SERIKA_TEST_HOME: root });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const report = { runId, verification: 'test-data-real-electron-original-preload-ipc-no-model-requests', sourceCommit: git(['rev-parse', 'HEAD']), sourceWorktreeDirty: !!git(['status', '--porcelain']), realModelCalls: 0, modelRequests: 0, scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), originalSha256: sha(original), launches: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false);
const cli = (...args) => execFileSync(process.execPath, [join(repo, 'packages/assistant/scripts/config-upgrade.mjs'), '--config', configPath, ...args], { cwd: root, env, encoding: 'utf8' });
let running;
async function launch(upgraded) {
  running = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js'), '--home', appHome], cwd: root, env, timeout: 30000 });
  const page = await running.firstWindow(); page.setDefaultTimeout(15000);
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
  const renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href }));
  assert.match(renderer.userAgent, /Electron\//); assert.equal(main.home, home);
  if (upgraded) {
    await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
    const info = await page.evaluate(() => window.runloom.info());
    assert.deepEqual(info.authorizedDirectories, [{ path: project, access: 'readwrite' }]); assert.equal(info.projectDirectory, project);
    assert.deepEqual(await page.locator('[role="alert"]:visible, [class*="error"]:visible, [class*="warning"]:visible').allTextContents(), []);
    report.launches.push({ main, renderer, result: 'v2-started', directories: info.authorizedDirectories });
  } else {
    const message = `配置为 v1，请运行 '${process.execPath}' '${join(repo, 'packages/assistant/scripts/config-upgrade.mjs')}' '--config' '${configPath}' '--upgrade' 升级`;
    const alert = page.getByRole("alert").filter({ hasText: message });
    await expect(alert).toBeVisible();
    report.launches.push({ main, renderer, result: 'v1-rejected', message, visibleError: await alert.innerText() });
    assert.equal(sha(await readFile(configPath)), report.originalSha256);
  }
}
async function stop() { if (running) { const child = running.process(); await running.close(); assert.notEqual(child.exitCode, null); running = undefined; } }
try {
  await launch(false); await stop();
  report.dryRunDiff = cli('--dry-run'); assert.equal(sha(await readFile(configPath)), report.originalSha256);
  report.upgrade = JSON.parse(cli('--upgrade'));
  assert.equal(sha(await readFile(report.upgrade.backupPath)), report.originalSha256);
  const upgraded = JSON.parse(await readFile(configPath, 'utf8'));
  for (const key of ['desktopAutonomy', 'telegramAutonomy']) assert.deepEqual(upgraded[key], JSON.parse(original)[key]);
  await launch(true); await stop();
  report.rollback = JSON.parse(cli('--rollback', report.upgrade.receiptPath));
  report.restoredSha256 = sha(await readFile(configPath)); assert.equal(report.restoredSha256, report.originalSha256);
  report.rollbackReceipt = JSON.parse(await readFile(report.rollback.rollbackReceiptPath, 'utf8'));
  await launch(false); await stop(); report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message, body: running ? await running.windows()[0]?.locator("body").innerText().catch(() => "unavailable") : "closed" }; process.exitCode = 1; }
finally { await stop(); await rm(root, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true; await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, evidence, originalSha256: report.originalSha256, restoredSha256: report.restoredSha256, failure: report.failure })); }
