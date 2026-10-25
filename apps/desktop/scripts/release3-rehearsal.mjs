import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from 'playwright/test';
import { repairDailyProject, EXPECTED_MEMORY_SHA, PERSONAL_PROJECT } from '../../../packages/assistant/scripts/daily-project-repair.mjs';
import { readThreadTranscript } from '../../../packages/core/dist/transcript-codec.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
assert.ok(options['--source-home'] && options['--output'], 'Pass --source-home and a new private --output directory');
const source = await realpath(options['--source-home']), output = resolve(options['--output']);
assert.ok(output !== source && !output.startsWith(source + '/') && !output.startsWith(repo + '/'));
await mkdir(output, { mode: 0o700 });
const home = join(output, 'H'), osHome = join(output, 'os-home');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function manifest(root) {
  const rows = [];
  async function visit(path = '') {
    const full = join(root, path), stat = await lstat(full), row = { path, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) rows.push({ ...row, type: 'symlink', target: await readlink(full) });
    else if (stat.isDirectory()) { rows.push({ ...row, type: 'directory' }); for (const name of (await readdir(full)).sort()) await visit(join(path, name)); }
    else { assert.ok(stat.isFile()); rows.push({ ...row, type: 'file', sha256: hash(await readFile(full)) }); }
  }
  await visit(); return rows;
}
const before = await manifest(source);
assert.equal(hash(await readFile(join(source, 'data/memory.json'))), EXPECTED_MEMORY_SHA);
execFileSync('/bin/cp', ['-a', source, home]);
assert.deepEqual(await manifest(home), before);
await mkdir(osHome);
const generated = new Set(['?? Serika.command', '?? launch-serika.mjs']);
const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const report = { runId: randomUUID(), verification: 'current-home-copy-real-electron-fake-model', platform: process.platform,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceWorktreeDirty: status.some(line => !generated.has(line)), generatedFiles: status.filter(line => generated.has(line)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), release: repo, source, home, realModelCalls: 0, launches: [], screenshots: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false);
report.artifactHashes = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(async name => [name, hash(await readFile(join(repo, 'apps/desktop', name)))])));
const memoryPath = join(home, 'data/memory.json');
report.dryRun = await repairDailyProject({ homeDirectory: home, dryRun: true });
report.repair = await repairDailyProject({ homeDirectory: home });
const repaired = await json(memoryPath);
assert.equal(repaired.progress.length, 14);
assert.ok(repaired.progress.every(row => row.projectId === PERSONAL_PROJECT.id));
const relocate = value => typeof value === 'string' ? value === source || value.startsWith(source + '/') ? home + value.slice(source.length) : value
  : Array.isArray(value) ? value.map(relocate) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
// Only launch preferences move with the copy; transcript bytes and their cursor hashes stay intact.
for (const name of ['config.json', 'desktop/desktop-identity.json']) {
  const path = join(home, name); await writeFile(path, encode(relocate(await json(path))));
}
report.isolationChanges = ['config.json and desktop identity: source-home path prefixes → copy', 'fresh OS HOME/userData; mock model; no inherited credentials'];
const identity = await json(join(home, 'desktop/desktop-identity.json'));
const profile = identity.profiles.find(item => item.configPath === join(home, 'config.json'));
assert.ok(profile);
const oldThread = profile.activeThreadId, oldProgress = repaired.progress.find(row => row.threadId === oldThread);
assert.ok(oldProgress?.throughMessageId, 'Active old Thread must have its migrated cursor');
const thread = profile.threads.find(row => row.threadId === oldThread);
assert.ok(thread.transcriptDirectory.startsWith(home + '/'));
const transcriptPath = join(thread.transcriptDirectory, hash(oldThread) + '.jsonl');
const transcript = await readThreadTranscript(transcriptPath, oldThread);
const cursorIndex = transcript.messages.findIndex(message => message.id === oldProgress.throughMessageId);
assert.ok(cursorIndex > 0);
const hello = transcript.messages.find(message => message.id === '71be545b-769a-4527-af6e-336d363348b6');
assert.ok(hello); assert.equal(hello.metadata.memoryProjectId, '51cb91fdad93f355d936d0396a389c545fa451e6637fe6c7588a585d5f852910');
report.oldThread = { threadId: oldThread, messages: transcript.messages.length, originalCursorIndex: cursorIndex, originalThroughMessageId: oldProgress.throughMessageId };
const calls = async () => {
  const records = await json(join(thread.transcriptDirectory, 'execution-records.json'));
  return records.modelUsage?.calls ?? [];
};
const previousCalls = new Set((await calls()).map(row => row.id));
const env = Object.fromEntries(['PATH', 'LANG', 'TMPDIR', 'NODE_OPTIONS', 'SERIKA_TEST_HOME', 'SERIKA_TEST_PROTECTED_ROOT', 'SERIKA_TEST_VIOLATIONS'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: osHome, XDG_CONFIG_HOME: join(osHome, '.config'), XDG_CACHE_HOME: join(osHome, '.cache'),
  RUNLOOM_USER_DATA: join(output, 'electron-profile'), RUNLOOM_CONFIG: join(home, 'config.json'), RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1' });
let running, page;
const checkpoint = phase => { report.phase = phase; console.log(JSON.stringify({ phase })); };
const rendererErrors = [];
async function launch(name, failure = false) {
  checkpoint(name);
  running = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js'), '--home', home], cwd: repo,
    env: { ...env, ...(failure ? { RUNLOOM_SMOKE_EXTRACTION_FAILURE: '1' } : {}) }, timeout: 30000 });
  page = await running.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, cwd: process.cwd(), userData: app.getPath('userData'), home: app.getPath('home') }));
  const renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href }));
  assert.equal(main.cwd, repo); assert.equal(main.home, osHome); assert.equal(main.userData, env.RUNLOOM_USER_DATA); assert.match(renderer.userAgent, /Electron\//); assert.match(renderer.url, /^file:/);
  report.launches.push({ name, main, renderer });
  const info = await page.evaluate(() => window.runloom.info());
  assert.equal(info.project?.id, PERSONAL_PROJECT.id); assert.equal(info.project.directory, PERSONAL_PROJECT.directory);
  await expect.poll(async () => (await page.evaluate(() => window.runloom.getMemoryMaintenance())).value?.extraction?.running ?? false).toBe(false);
  return info;
}
async function stop() {
  if (!running) return;
  const child = running.process();
  const exited = new Promise((done, reject) => { const timeout = setTimeout(() => reject(new Error('Test Electron did not quit normally')), 15000); child.once('exit', () => { clearTimeout(timeout); done(); }); });
  await running.evaluate(({ app }) => { app.quit(); }); await exited; assert.notEqual(child.exitCode, null);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); running = undefined;
}
async function screenshot(name, locator = page) {
  const path = join(output, name + '.png'); await locator.screenshot({ path });
  report.screenshots.push({ file: name + '.png', sha256: hash(await readFile(path)) });
}
try {
  const info = await launch('repaired-old-thread'); assert.equal(info.threadId, oldThread);
  const state = await page.evaluate(() => window.runloom.getMemoryMaintenance()); assert.ok(state.ok);
  const firstCalls = (await calls()).filter(row => !previousCalls.has(row.id) && row.purpose === 'memory_consolidation');
  const after = await json(memoryPath), current = after.progress.find(row => row.threadId === oldThread && row.projectId === PERSONAL_PROJECT.id);
  const afterIndex = transcript.messages.findIndex(message => message.id === current.throughMessageId);
  assert.ok(afterIndex >= cursorIndex); assert.ok(!state.value.extraction?.error);
  report.oldThread = { ...report.oldThread, startupConsolidationCalls: firstCalls.length, afterCursorIndex: afterIndex, notRestartedFromBeginning: true };
  const memoryBeforeRestart = hash(await readFile(memoryPath)), firstPid = report.launches.at(-1).main.pid;
  await stop(); await launch('repaired-old-thread-restart');
  assert.notEqual(report.launches.at(-1).main.pid, firstPid);
  assert.equal(hash(await readFile(memoryPath)), memoryBeforeRestart);
  report.oldThread.restartConsolidationCalls = (await calls()).filter(row => !previousCalls.has(row.id) && row.purpose === 'memory_consolidation').length - firstCalls.length;
  assert.equal(report.oldThread.restartConsolidationCalls, 0);
  await page.evaluate(() => window.runloom.createThread());
  const failureThread = (await page.evaluate(() => window.runloom.info())).threadId;
  await stop(); await launch('new-thread-expected-validation-failure', true);
  const config = await json(join(home, 'config.json'));
  const text = 'RELEASE3_FAILURE_PROBE_' + report.runId + 'x'.repeat(2 * (config.contextCompaction?.summaryInputChunkTokens ?? 32000));
  checkpoint('send-validation-probe');
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  await page.getByPlaceholder('和 Serika 聊天').fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.runloom.snapshot())).state.kind, { timeout: 120000 }).toBe('idle');
  await expect.poll(async () => {
    const value = await page.evaluate(() => window.runloom.getMemoryMaintenance());
    return value.ok ? value.value.failures?.length ?? 0 : 0;
  }, { timeout: 30000 }).toBeGreaterThan(0);
  const failures = await page.evaluate(() => window.runloom.getMemoryMaintenance()); assert.ok(failures.ok);
  const failure = failures.value.failures.at(-1);
  assert.equal(failure.stage, 'validate'); assert.equal(failure.code, 'MEMORY_EXTRACTION_JSON_INVALID'); assert.equal(failure.threadId, failureThread); assert.equal(failure.projectId, PERSONAL_PROJECT.id);
  assert.ok(!JSON.stringify(failure).includes(text)); report.expectedFailure = failure;
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  const panel = page.locator('.memory-extraction-failures:visible'); await expect(panel).toHaveCount(1);
  await screenshot('failure-collapsed', panel);
  await panel.locator('summary').first().click(); await expect(panel).toContainText(failure.message);
  await screenshot('failure-expanded', panel);
  await stop(); await launch('failure-log-survives-restart');
  const retained = await page.evaluate(() => window.runloom.getMemoryMaintenance()); assert.ok(retained.ok);
  assert.ok(retained.value.failures.some(row => row.at === failure.at && row.code === failure.code));
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.locator('.memory-extraction-failures:visible')).toHaveCount(1);
  report.retainedAfterRestart = true; report.rendererErrors = rendererErrors; assert.deepEqual(rendererErrors, []);
  report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message }; console.error(JSON.stringify(report.failure)); await writeFile(join(output, 'result.json'), encode(report)); process.exitCode = 1; }
finally {
  await stop(); assert.deepEqual(await manifest(source), before); report.originalHomeUnchanged = true;
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'result.json'), encode(report));
  console.log(encode({ status: report.status, output, oldThread: report.oldThread, expectedFailure: report.expectedFailure, failure: report.failure }));
}
