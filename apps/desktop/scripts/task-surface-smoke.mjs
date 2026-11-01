import { _electron as electron, expect } from 'playwright/test';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { defaultContextBudget } from '@serika/assistant';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(desktop, '../..');
const fixture = join(repo, 'packages/assistant/fixtures/work-task-eval/repo-regression-v1');
const assignment = '记录一个任务：修复这个项目的 slug 空格处理，保留已有行为，交付代码和回归测试';
const reminderText = '一分钟后提醒复核';
const digest = data => createHash('sha256').update(data).digest('hex');
const realHome = join(homedir(), '.serika');

const root = await mkdtemp(join(tmpdir(), 'serika-task-surface-'));
assert.ok(!root.startsWith(realHome), 'isolation home must not be the daily Serika home');
const home = join(root, 'home');
const serikaHome = join(home, '.serika');
const workspace = join(root, 'fixture');
await mkdir(home, { recursive: true });
await cp(fixture, workspace, { recursive: true });
const slugPath = join(workspace, 'src/slug.mjs');
const slugBefore = await readFile(slugPath);
const configPath = join(root, 'config.json');
await mkdir(join(root, 'profile'), { recursive: true });
const budget = defaultContextBudget();
await writeFile(configPath, JSON.stringify({
  version: 2,
  projectDirectory: workspace,
  authorizedDirectories: [{ path: workspace, access: 'readwrite' }],
  modules: {
    task: { enabled: true },
    'read-file': { enabled: true },
    shell: { enabled: true, timeoutMs: 300_000 },
    memory: { enabled: false },
    terminal: { enabled: false },
  },
  run: { totalTimeoutMs: 600_000 },
  contextCompaction: budget,
  modelContextWindows: [{ provider: 'mock-provider', modelId: 'mock-model-id', contextWindowTokens: budget.contextWindowTokens }],
}), { mode: 0o600 });
const env = {
  HOME: home,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY,
  LANG: process.env.LANG ?? 'C.UTF-8',
  RUNLOOM_MODEL: 'mock',
  RUNLOOM_DESKTOP_TEST: '1',
  RUNLOOM_USER_DATA: join(root, 'profile'),
  RUNLOOM_WORKSPACE: workspace,
  RUNLOOM_CONFIG: configPath,
  RUNLOOM_ENV_FILE: join(root, 'test.env'),
  RUNLOOM_TRANSCRIPTS: join(root, 'transcripts'),
  RUNLOOM_THREAD: 'task-surface',
};
await writeFile(env.RUNLOOM_ENV_FILE, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

let running;
let worker;
const report = { verification: 'real-electron-with-script-model', platform: process.platform, realModelCalls: 0, checks: [] };
function check(name) { report.checks.push(name); }

async function launch(name) {
  running = await electron.launch({
    args: [join(desktop, 'out/main/index.js'), '--home', serikaHome],
    cwd: root, env, timeout: 30_000,
  });
  const page = await running.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, home: app.getPath('home') }));
  assert.equal(main.home, home);
  assert.match(await page.evaluate(() => navigator.userAgent), /Electron\//);
  report[name] = { pid: main.pid, electron: main.electron };
  return page;
}
async function stop() {
  if (!running) return;
  const child = running.process();
  await running.close();
  assert.notEqual(child.exitCode, null);
  running = undefined;
}
async function tools(page) {
  const listed = await page.evaluate(() => window.runloom.listRuns());
  assert.equal(listed.ok, true);
  return listed.runs.flatMap(run => run.tools.map(tool => ({ runId: run.runId, toolName: tool.toolName, status: tool.status })));
}
async function workTasks(page) {
  const listed = await page.evaluate(() => window.runloom.listWorkTasks());
  assert.equal(listed.ok, true);
  return listed.value;
}
function countNamed(rows, name) { return rows.filter(row => row.toolName === name).length; }
async function openWorkTask(page) {
  const taskRow = page.locator('.task-row', { hasText: 'slug' });
  if (await taskRow.count()) { await taskRow.first().click(); return; }
  const heading = page.getByRole('heading', { name: /slug/ });
  if (await heading.count()) return;
  throw new Error(`task row missing\n${(await page.locator('body').innerText()).slice(0, 1200)}`);
}

async function allowPending(page, assertCreate) {
  const button = page.locator('button.allow', { hasText: /允许本次调用|确认保存/ }).first();
  await expect(button).toBeEnabled();
  const preview = await page.locator('.approval .prompt').innerText().catch(() => '');
  if (assertCreate && preview.includes('改动范围可接受')) {
    assert.match(preview, /修复这个项目的 slug 空格处理/);
    assert.match(preview, /node --test test\/slug\.test\.mjs/);
    assert.match(preview, /未开始/);
    check('confirm-card');
  }
  await button.click();
  return preview;
}
async function until(page, done, assertCreate = false) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const pending = await page.locator('button.allow', { hasText: /允许本次调用|确认保存/ }).count();
    if (pending) { await allowPending(page, assertCreate); continue; }
    if (await done()) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out; visible=${(await page.locator('body').innerText()).slice(0, 800)}`);
}

try {
  let page = await launch('before');
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  const started = Date.now();
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('button', { name: '＋ 创建任务' }).click();
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  await page.getByPlaceholder('和 Serika 聊天').fill(assignment);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(page, async () => (await page.getByText('已创建，尚未执行。').count()) > 0, true);
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByText('待开始').first()).toBeVisible();
  assert.equal(digest(await readFile(slugPath)), digest(slugBefore));
  const savedTools = await tools(page);
  assert.equal(countNamed(savedTools, 'edit_file') + countNamed(savedTools, 'write_file') + countNamed(savedTools, 'shell_exec'), 0);
  const saved = await workTasks(page);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].runIds.length, 0);
  check('saved-not-started');

  const taskRow = page.locator('.task-row', { hasText: 'slug' });
  if (await taskRow.count()) await taskRow.first().click();
  else throw new Error(`task row missing\n${(await page.locator('body').innerText()).slice(0, 1200)}`);
  await page.getByText('验收与核对').click();
  await page.getByRole('button', { name: '回到对话，开始任务' }).click();
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await until(page, async () => (await page.getByText('程序检查已跑完。人工项仍待审核。').count()) > 0);
  assert.notEqual(digest(await readFile(slugPath)), digest(slugBefore));
  assert.match(await readFile(slugPath, 'utf8'), /\\s\+\/g/);
  const ran = await tools(page);
  assert.ok(countNamed(ran, 'edit_file') >= 1);
  assert.ok(countNamed(ran, 'read_file') >= 2);
  assert.ok(ran.some(row => row.toolName === 'shell_exec' && row.status === 'completed'));
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await openWorkTask(page);
  await expect(page.getByText('交付待验收').first()).toBeVisible();
  await expect(page.getByText('尚未验收').first()).toBeVisible();
  assert.notEqual((await workTasks(page))[0].status, 'completed');
  check('delivery-pending-human');

  const advanced = page.locator('details.task-advanced');
  if ((await advanced.getAttribute('open')) === null) await advanced.locator('summary').click();
  const accept = page.getByRole('button', { name: '通过此项' });
  if (!(await accept.count())) throw new Error(`accept missing\n${(await page.locator('body').innerText()).slice(0, 1500)}`);
  await accept.click();
  await page.getByRole('button', { name: '确认验收决定' }).click();
  await expect(page.getByText('验收通过').first()).toBeVisible();
  const accepted = (await workTasks(page))[0];
  assert.equal(accepted.status, 'completed');
  const humanItem = accepted.acceptance.find(item => item.description === '改动范围可接受');
  assert.equal(humanItem?.status, 'passed');
  check('human-accepted');

  const toolsBeforeReminder = await tools(page);
  if (await page.getByRole('button', { name: '普通对话', exact: true }).count()) {
    await page.getByRole('button', { name: '普通对话', exact: true }).click();
  }
  await page.getByPlaceholder('和 Serika 聊天').fill(reminderText);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(page, async () => /后台当前不可用|已定：/.test(await page.locator('body').innerText()));
  assert.match(await page.locator('body').innerText(), /后台/);
  worker = spawn(process.execPath, [join(repo, 'packages/assistant/dist/task-worker-entry.js'), '--home', serikaHome, '--workspace', workspace], {
    env: { ...env, RUNLOOM_MODEL: 'mock' }, stdio: 'ignore',
  });
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const back = page.getByRole('button', { name: '返回任务列表' });
  if (await back.count()) await back.click();
  const due = Date.now() + 90_000;
  let opened = false;
  while (Date.now() < due) {
    await page.getByRole('tab', { name: /定时任务/ }).click();
    const done = page.locator('.task-row', { hasText: '执行结束' });
    if (await done.count()) {
      await done.first().click();
      opened = true;
      break;
    }
    await page.waitForTimeout(1_000);
  }
  assert.equal(opened, true);
  await expect(page.getByLabel('提醒结果')).toContainText('复核这份改动');
  const inbox = await page.evaluate(() => window.runloom.getTaskInbox());
  assert.equal(inbox.ok, true);
  const reminder = inbox.value.tasks.find(task => task.promptPreview.includes('复核'));
  assert.ok(reminder);
  const detail = await page.evaluate(id => window.runloom.getScheduledTask(id), reminder.id);
  assert.equal(detail.ok, true);
  assert.equal(detail.value.runId, null);
  assert.equal(detail.value.execution, 'deterministic');
  assert.equal(detail.value.acknowledgedAt, null);
  const toolsAfterReminder = await tools(page);
  for (const name of ['shell_exec', 'edit_file', 'write_file', 'read_file']) {
    assert.equal(countNamed(toolsAfterReminder, name), countNamed(toolsBeforeReminder, name), name);
  }
  assert.equal(countNamed(toolsAfterReminder, 'task_create'), countNamed(toolsBeforeReminder, 'task_create') + 1);
  check('reminder-result');

  const beforeQuit = {
    task: accepted.id,
    runs: (await page.evaluate(() => window.runloom.listRuns())).runs.length,
    slug: digest(await readFile(slugPath)),
    reminder: detail.value.id,
  };
  assert.ok(Date.now() - started < 5 * 60 * 1000, 'prepared-instance demo exceeded five minutes');
  worker.kill('SIGTERM');
  worker = undefined;
  await stop();
  page = await launch('after');
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  const threads = await page.evaluate(() => window.runloom.listThreads());
  const owned = threads.find(thread => (thread.taskCount ?? 0) > 0);
  assert.ok(owned, 'reopened workspace lost the work-task conversation');
  await page.evaluate(id => window.runloom.selectThread(id), owned.threadId);
  await page.waitForTimeout(400);
  assert.ok((await workTasks(page)).some(task => task.id === beforeQuit.task));
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await openWorkTask(page);
  await expect(page.getByText('验收通过').first()).toBeVisible();
  const reopened = (await workTasks(page)).find(task => task.id === beforeQuit.task);
  assert.equal(reopened?.status, 'completed');
  assert.equal(reopened?.runIds.length, accepted.runIds.length);
  await page.getByRole('button', { name: '返回任务列表' }).click();
  await page.getByRole('tab', { name: /定时任务/ }).click();
  await page.locator('.task-row', { hasText: '执行结束' }).click();
  await expect(page.getByLabel('提醒结果')).toContainText('复核这份改动');
  const reminderAgain = await page.evaluate(id => window.runloom.getScheduledTask(id), beforeQuit.reminder);
  assert.equal(reminderAgain.ok && reminderAgain.value.acknowledgedAt, null);
  assert.equal(reminderAgain.value.runId, null);
  assert.equal((await page.evaluate(() => window.runloom.listRuns())).runs.length, beforeQuit.runs);
  assert.equal(digest(await readFile(slugPath)), beforeQuit.slug);
  check('reopen');
  await stop();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(report.failure);
} finally {
  if (worker) worker.kill('SIGTERM');
  await stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, checks: report.checks, failure: report.failure, realModelCalls: 0 }));
if (report.status !== 'passed') process.exitCode = 1;
