import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url))), desktop = join(repo, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json')), { _electron: electron, expect } = require('playwright/test');
const runId = randomUUID(), sha = bytes => createHash('sha256').update(bytes).digest('hex'), hash = async path => sha(await readFile(path));
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const evidence = join(repo, 'docs/v2-pilot/evidence/architecture-v2-c1c2', runId, 'electron');
const report = { runId, verification: 'real-electron-original-preload-ipc-fake-model-v7', platform: process.platform, sourceCommit: git(['rev-parse', 'HEAD']), sourceWorktreeDirty: !!git(['status', '--porcelain']), scriptSha256: await hash(fileURLToPath(import.meta.url)), realModelCalls: 0, costUsd: 0, launches: [], checks: [], screenshots: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false, 'Electron evidence requires clean committed source');
const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-scope-electron-'))), home = join(root, 'home'), appHome = join(home, '.serika');
const projectA = join(root, 'serika-v2'), personal = join(root, 'personal'), configPath = join(appHome, 'config.json'), memoryPath = join(appHome, 'data/memory.json');
await Promise.all([appHome, join(projectA, '.git'), personal, evidence].map(path => mkdir(path, { recursive: true })));
const config = { version: 2, authorizedDirectories: [{ path: personal, access: 'readwrite' }], projectDirectory: personal, modules: { memory: { enabled: true, autoConsolidate: false }, shell: { enabled: false } } };
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); let configSha = await hash(configPath);
const envFile = join(root, 'test.env'); await writeFile(envFile, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'SERIKA_TEST_VIOLATIONS', 'SERIKA_TEST_PROTECTED_ROOT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_ENV_FILE: envFile, RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1', SERIKA_TEST_HOME: root });
report.artifactHashes = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(async path => [path, await hash(join(desktop, path))])));
let running, page; const rendererErrors = [];
async function clean() { assert.deepEqual(rendererErrors, []); assert.deepEqual((await page.locator('[role="alert"]:visible, [class*="error"]:visible, [class*="warning"]:visible').allTextContents()).map(text => text.trim()), []); }
async function launch(name, missingProject = false) {
  const started = performance.now();
  running = await electron.launch({ args: [join(desktop, 'out/main/index.js'), '--home', appHome], cwd: personal, env, timeout: 30000 }); page = await running.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => rendererErrors.push(error.message)); page.on('console', message => { if (['warning', 'error'].includes(message.type())) rendererErrors.push(`${message.type()}: ${message.text()}`); });
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
  const renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href })); assert.ok(main.electron); assert.equal(main.home, home); assert.equal(main.userData, env.RUNLOOM_USER_DATA); assert.match(renderer.userAgent, /Electron\//); assert.match(renderer.url, /^file:/);
  report.launches.push({ name, main, renderer }); if (missingProject) return;
  await page.evaluate(async () => { const info = await window.runloom.info(); if (info.workTasks) { const tasks = await window.runloom.listWorkTasks(); if (!tasks.ok) throw new Error('Cold-start WorkTask read failed: ' + tasks.error.code); } });
  report.launches.at(-1).hostReadinessMilliseconds = performance.now() - started; await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled(); await clean();
}
async function stop() { if (running) { const child = running.process(); await running.close(); assert.notEqual(child.exitCode, null); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); running = undefined; } }
async function shot(name) { const path = join(evidence, `${name}.png`); await page.screenshot({ path }); const item = { file: `${name}.png`, sha256: await hash(path) }; report.screenshots.push(item); return item; }
async function check(name, details = {}) { await clean(); report.checks.push({ name, result: 'passed', ...details, screenshot: await shot(name) }); }
async function send(text) {
  const before = await page.evaluate(async () => (await window.runloom.history()).length);
  await page.getByPlaceholder('和 Serika 聊天').fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => page.evaluate(async count => { const snapshot = await window.runloom.snapshot(); return (await window.runloom.history()).length > count && snapshot.state.kind === 'idle' && snapshot.lastPrimaryResult?.status === 'completed'; }, before), { timeout: 30000 }).toBe(true);
  await clean(); return page.evaluate(() => window.runloom.snapshot());
}
async function project(directory) {
  const before = await page.evaluate(() => window.runloom.info()); await page.evaluate(path => window.runloom.selectProject(path), directory);
  await expect.poll(() => page.evaluate(() => window.runloom.info().then(info => info.project?.directory ?? null))).toBe(directory);
  const info = await page.evaluate(() => window.runloom.info()); assert.equal(info.threadId, before.threadId); assert.deepEqual(info.authorizedDirectories, config.authorizedDirectories); assert.equal(await hash(configPath), configSha);
  return info;
}
async function readMemory(input) {
  await send(`读取记忆 ${JSON.stringify(input)}`);
  return page.evaluate(async () => { const history = await window.runloom.history(), lastUser = history.findLastIndex(message => message.role === 'user'); const parts = history.slice(lastUser + 1).flatMap(message => message.parts); const result = parts.findLast(part => part.type === 'tool-memory_read' || part.type === 'dynamic-tool' && part.toolName === 'memory_read'); if (!result || result.state !== 'output-available') throw new Error('No real memory_read result'); return result.output; });
}
const preferenceTexts = ['SMOKE_USER_PREF_1', 'SMOKE_USER_PREF_2', 'SMOKE_USER_PREF_3'], projectNote = 'SMOKE_PROJECT_NOTE', titles = [1, 2, 3].map(i => `SMOKE_PROJECT_DOCUMENT_${i}`), documents = [];
async function isolation(name, visible) {
  await send('检查项目上下文'); const reply = await page.evaluate(async () => (await window.runloom.history()).findLast(message => message.role === 'assistant')?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? ''); assert.ok(reply.startsWith('SMOKE_CONTEXT:'), 'Smoke provider must report actual host Memory prompt sections: ' + reply); const hostContext = JSON.parse(reply.slice('SMOKE_CONTEXT:'.length)).join('\n');
  for (const title of titles) assert.equal(hostContext.includes(title), visible, `${name}: document index ${title}`);
  const references = await page.evaluate(() => window.runloom.getMemoryReferences()); assert.ok(references); for (const text of preferenceTexts) assert.ok(references.selected.some(entry => entry.text === text)); assert.equal(references.selected.some(entry => entry.text === projectNote), visible);
  const library = await page.evaluate(() => window.runloom.getMemoryLibrary()); assert.ok(library.ok); assert.deepEqual(library.value.documents.filter(document => titles.includes(document.title)).map(document => document.title).sort(), visible ? [...titles].sort() : []);
  for (const id of documents) { const result = await readMemory({ id }); assert.equal(result.ok, visible); if (!visible) assert.equal(result.error.code, 'NOT_FOUND'); }
  const found = await readMemory({ query: 'SMOKE_PROJECT_' }); assert.ok(found.ok); assert.equal(found.entries.some(entry => entry.text === projectNote), visible); for (const title of titles) assert.equal(found.entries.some(entry => entry.text.includes(`${title}_BODY`)), visible);
  const users = await readMemory({ query: 'SMOKE_USER_PREF_' }); assert.ok(users.ok); assert.deepEqual(users.entries.map(entry => entry.text).sort(), [...preferenceTexts].sort());
  const listed = await page.evaluate(() => window.runloom.listMemories({ limit: 50 })); assert.ok(listed.ok); assert.equal(listed.value.entries.some(entry => entry.preview === projectNote), visible);
  await check(name, { projectMemoryVisible: visible, userPreferences: 3, visibleProjectDocuments: visible ? 3 : 0, memoryReadInvocations: 5, unchangedAuthorizations: true });
}
try {
  await launch('initial'); configSha = await hash(configPath); const initial = await page.evaluate(() => window.runloom.info()); assert.equal(initial.project.directory, personal);
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: /^文件与网页/ }).click(); await expect(page.getByLabel('项目目录', { exact: true })).toBeEnabled();
  await page.getByLabel('项目目录', { exact: true }).fill(projectA); await page.getByRole('button', { name: '选择项目', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.runloom.info().then(info => info.project?.directory))).toBe(projectA);
  await page.getByRole('button', { name: '返回设置', exact: true }).click(); await page.getByRole('button', { name: '回到手札', exact: true }).click(); await check('ui-project-selection', { authorizedDirectories: config.authorizedDirectories, project: 'serika-v2' });
  await send('记住 SMOKE_RETRACT_ME'); await send('撤销刚才记住的内容'); let memory = JSON.parse(await readFile(memoryPath, 'utf8')); assert.equal(memory.version, 7); assert.ok(memory.entries.some(entry => entry.text === 'SMOKE_RETRACT_ME' && entry.state === 'retracted')); await check('remember-and-retract');
  for (const text of preferenceTexts) await send(`记住 ${text}`); await send(`记住项目 ${projectNote}`);
  for (const title of titles) { const library = await page.evaluate(() => window.runloom.getMemoryLibrary()); assert.ok(library.ok); const id = randomUUID(); const result = await page.evaluate(action => window.runloom.changeMemoryLibrary(action), { operation: 'save-document', expectedRevision: library.value.revision, id, title, folderId: null, text: `${title}_BODY`, entries: [] }); assert.ok(result.ok); documents.push(id); }
  await isolation('serika-project-visible', true); await project(personal); await isolation('personal-project-isolated', false); await project(null); await isolation('no-project-isolated', false); await project(projectA); await isolation('return-to-serika-visible', true);
  const beforeHash = await hash(memoryPath), beforePid = report.launches.at(-1).main.pid; await stop(); await launch('restarted'); const info = await page.evaluate(() => window.runloom.info()); assert.equal(info.project.directory, projectA); assert.equal(info.threadId, initial.threadId); assert.deepEqual(info.authorizedDirectories, config.authorizedDirectories); assert.equal(await hash(configPath), configSha); assert.equal(await hash(memoryPath), beforeHash); assert.notEqual(report.launches.at(-1).main.pid, beforePid);
  report.restart = { beforePid, afterPid: report.launches.at(-1).main.pid, beforeMemorySha256: beforeHash, afterMemorySha256: await hash(memoryPath), projectRestored: true, unchangedAuthorizations: true }; await isolation('restart-project-and-memory', true);
  memory = JSON.parse(await readFile(memoryPath, 'utf8')); assert.equal(memory.entries.filter(entry => entry.state === 'active' && entry.scope.kind === 'user').length, 3); assert.equal(memory.library.documents.length, 3); assert.ok(memory.entries.filter(entry => entry.category === 'document').every(entry => entry.scope.projectId === info.project.id)); await stop();
  const dataDirectory = join(appHome, 'data'), registryPath = join(dataDirectory, 'projects.json'), moved = join(root, 'moved-serika-v2');
  const originals = { memory: await hash(memoryPath), projects: await hash(registryPath) }; await rename(projectA, moved);
  await launch('moved-project-missing', true);
  const alerts = page.getByRole('alert'); await expect(alerts).toHaveCount(1); await expect(alerts).toContainText(`项目 serika-v2 在 ${projectA} 找不到了；如已移动，运行`);
  const diagnostic = await alerts.innerText(); assert.ok(diagnostic.includes('project-rebind.mjs')); assert.ok(diagnostic.includes(dataDirectory)); assert.ok(diagnostic.includes('--from')); assert.ok(diagnostic.includes('--to')); assert.deepEqual(rendererErrors, []);
  report.checks.push({ name: 'moved-project-diagnostic', result: 'passed', expectedErrors: [diagnostic], screenshot: await shot('moved-project-diagnostic') });
  assert.equal(await hash(memoryPath), originals.memory); assert.equal(await hash(registryPath), originals.projects); await stop();
  const rebindScript = join(repo, 'packages/assistant/scripts/project-rebind.mjs');
  const runRebind = args => JSON.parse(execFileSync(process.execPath, [rebindScript, '--data', dataDirectory, ...args], { env, encoding: 'utf8' }));
  const dry = runRebind(['--from', projectA, '--to', moved, '--dry-run']); assert.equal(dry.affected.entries, 4); assert.equal(dry.affected.documents, 3);
  assert.equal(await hash(memoryPath), originals.memory); assert.equal(await hash(registryPath), originals.projects);
  const rebound = runRebind(['--from', projectA, '--to', moved, '--upgrade']); await launch('rebound-project'); await isolation('rebound-project-visible', true); await stop();
  const rollback = runRebind(['--rollback', rebound.receiptPath]); assert.ok(rollback.identical); assert.equal(await hash(memoryPath), originals.memory); assert.equal(await hash(registryPath), originals.projects);
  report.projectRebind = { diagnostic, affected: dry.affected, files: rollback.files, identical: rollback.identical };
  await rename(moved, projectA); await launch('rollback-original-project'); await isolation('rollback-original-project-visible', true); report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message.slice(0, 1800) }; process.exitCode = 1; if (running) await shot('failure').catch(() => {}); }
finally { await stop().catch(error => { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }); await rm(root, { recursive: true, force: true }); await assert.rejects(access(root), { code: 'ENOENT' }); report.temporaryDirectoryRemoved = true; report.rendererErrors = rendererErrors; await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ runId, status: report.status, checks: report.checks.length, evidence, failure: report.failure })); }
