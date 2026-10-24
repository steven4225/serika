import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(join(repo, 'apps/desktop/package.json'));
const { _electron: electron, expect } = require('playwright/test');
const runId = randomUUID();
const evidence = resolve(process.argv[3] ?? join(repo, 'docs/v2-pilot/evidence/architecture-v2-b2', runId));
const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-b2-electron-directories-')));
const home = join(root, 'home'), appHome = join(home, '.serika'), configPath = join(root, 'config.json');
const first = join(root, 'first'), second = join(root, 'second');
await Promise.all([home, first, second, evidence].map(path => mkdir(path, { recursive: true })));
await writeFile(configPath, JSON.stringify({ version: 2, projectDirectory: null, authorizedDirectories: [], modules: { 'read-file': { enabled: true }, memory: { enabled: false }, shell: { enabled: false } } }), { mode: 0o600 });
const envFile = join(root, 'test.env'); await writeFile(envFile, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
const env = Object.fromEntries(['PATH','USER','LOGNAME','TMPDIR','DISPLAY','XAUTHORITY','LANG','LC_ALL','SystemRoot'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), RUNLOOM_CONFIG: configPath, RUNLOOM_ENV_FILE: envFile, RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1', SERIKA_TEST_HOME: root, RUNLOOM_TRANSCRIPTS: join(root, 'transcripts'), RUNLOOM_THREAD: 'b2-electron-directory-probe' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { runId, verification: 'real-electron-original-preload-ipc-no-model-requests', realModelCalls: 0, modelRequests: 0, platform: process.platform, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceWorktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), artifactHashes: {}, launches: [], checks: [], pageErrors: [], consoleErrors: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false, 'Directory smoke requires clean source');
for (const file of ['out/main/index.js','out/preload/index.cjs','out/renderer/index.html']) report.artifactHashes[file] = sha(await readFile(join(repo,'apps/desktop',file)));
let running, page, identity;
async function launch() {
  running = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js'), '--home', appHome], cwd: root, env, timeout: 30000 });
  page = await running.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
  assert.equal(main.userData, env.RUNLOOM_USER_DATA); assert.equal(main.home, home);
  const renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href })); assert.match(renderer.userAgent,/Electron\//); assert.match(renderer.url,/^file:/);
  report.launches.push({ main, renderer });
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  return page.evaluate(() => window.runloom.info());
}
async function stop() { if (!running) return; const child=running.process(); await running.close(); assert.notEqual(child.exitCode,null); assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'}); running=undefined; }
async function openFiles() { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: /^文件与网页/ }).click(); await expect(page.locator('section[aria-label="持久目录授权"]')).toBeVisible(); }
async function inspect(name, expected, expectedError) {
  await expect.poll(() => page.evaluate(() => window.runloom.info()).then(info => info.authorizedDirectories)).toEqual(expected);
  const info = await page.evaluate(() => window.runloom.info());
  assert.equal(info.threadId, identity.threadId); assert.equal(info.directory, identity.directory); assert.equal(info.projectDirectory,null); assert.equal(info.autonomy?.enabled,false);
  const saved=JSON.parse(await readFile(configPath,'utf8'));assert.deepEqual(saved.authorizedDirectories,expected);assert.equal(saved.projectDirectory,null);assert.equal('authorizedDirectory' in saved,false);assert.equal(saved.desktopAutonomy,undefined);
  const rows=page.locator('section[aria-label="持久目录授权"]'); await expect(rows).toBeVisible();
  await expect(rows.locator('input')).toHaveCount(expected.length);
  for (let index=0;index<expected.length;index++) { await expect(rows.getByLabel(`目录 ${index+1} 路径`,{exact:true})).toHaveValue(expected[index].path); await expect(rows.getByLabel(`目录 ${index+1} 权限`,{exact:true})).toHaveValue(expected[index].access); }
  await expect(rows.getByText('有未保存的目录更改。',{exact:true})).toHaveCount(0);
  const visibleErrors=await page.locator('[role="alert"]:visible, [class*="error"]:visible, [class*="warning"]:visible').allTextContents();
  if (expectedError) { assert.equal(visibleErrors.length,1); assert.match(visibleErrors[0],expectedError); } else assert.deepEqual(visibleErrors,[]);
  report.checks.push({name,result:'passed',directories:expected,threadStable:true,projectRemainsUnselected:true,autonomyRemainsDisabled:true});
}
async function save() { await page.getByRole('button',{name:'保存目录授权',exact:true}).click(); await expect(page.getByRole('heading',{name:'文件与网页',exact:true})).toBeVisible(); }
try {
  identity=await launch();await openFiles();
  assert.deepEqual(identity.authorizedDirectories,[]);assert.equal(identity.projectDirectory,null);
  const rows=()=>page.locator('section[aria-label="持久目录授权"]');
  await rows().getByRole('button',{name:'添加目录',exact:true}).click();await rows().getByLabel('目录 1 路径',{exact:true}).fill(first);await save();await inspect('add-read-directory',[{path:first,access:'read'}]);
  await rows().getByRole('button',{name:'添加目录',exact:true}).click();await rows().getByLabel('目录 2 路径',{exact:true}).fill(second);await rows().getByLabel('目录 2 权限',{exact:true}).selectOption('readwrite');await save();await inspect('add-second-readwrite-directory',[{path:first,access:'read'},{path:second,access:'readwrite'}]);
  await rows().getByLabel('目录 1 权限',{exact:true}).selectOption('readwrite');await rows().getByLabel('目录 2 权限',{exact:true}).selectOption('read');await save();await inspect('switch-permissions',[{path:first,access:'readwrite'},{path:second,access:'read'}]);
  await rows().getByRole('button',{name:'删除目录 1',exact:true}).click();await save();await inspect('remove-first-directory',[{path:second,access:'read'}]);
  await rows().getByRole('button',{name:'删除目录 1',exact:true}).click();await save();await inspect('remove-last-directory',[]);
  const stale = await page.evaluate(async path => { try { await window.runloom.setAuthorizedDirectories({directories:[],expectedDirectories:[{path,access:'read'}]});return null;} catch(error) {return String(error);} },second); assert.match(stale,/目录授权已变化/);
  // A rejected request still refreshes the selected settings page through production IPC.
  await expect(page.getByRole('heading',{name:'文件与网页',exact:true})).toBeVisible();await inspect('stale-authorization-cas-rejected',[],/目录授权已变化/);
  await stop();await launch();await openFiles();await inspect('full-electron-restart-does-not-restore-grants',[]);
  assert.notEqual(report.launches[0].main.pid,report.launches[1].main.pid);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);report.status='passed';
} catch(error) { report.failure={name:error.name,message:error.message};process.exitCode=1; }
finally { await stop().catch(error=>{report.cleanupError=error.message;report.status='failed';process.exitCode=1;});await rm(root,{recursive:true,force:true});await assert.rejects(access(root),{code:'ENOENT'});report.temporaryDirectoryRemoved=true;await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence,checks:report.checks.map(({name,result})=>({name,result})),failure:report.failure})); }
