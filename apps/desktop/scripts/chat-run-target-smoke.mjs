import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalChain, confirmApproval, observeApprovals } from './chat-run-target-approval.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url)), repo = resolve(desktop, '../..');
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
assert.ok(outputIndex >= 0 && args[outputIndex + 1], '--output requires an evidence directory outside the repository');
const output = resolve(args[outputIndex + 1]);
assert.ok(!output.startsWith(repo + '/'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const git = (...values) => execFileSync('git', values, { cwd: repo, encoding: 'utf8' }).trim();
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), verification: 'real-electron-scripted-model-offline-herdr',
  sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: !!git('status', '--porcelain'),
  scriptSha256: await hash(fileURLToPath(import.meta.url)), realModelCalls: 0, costUsd: 0,
  checks: [], screenshots: [], approvalEvents: [], decisions: [], selections: [], consoleErrors: [], pageErrors: [], status: 'failed' };
assert.equal(report.sourceWorktreeDirty, false, 'Commit source before recording Electron evidence');
await mkdir(output, { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-run-target-smoke-')));
const workspace = join(root, 'workspace'), home = join(root, 'home'), profile = join(root, 'profile'), bin = join(root, 'bin');
await Promise.all([workspace, home, bin].map(path => mkdir(path)));
const state = join(root, 'identities.json'), log = join(root, 'prompts.jsonl'), artifact = join(workspace, 'answer.json');
await writeFile(state, JSON.stringify({ p1: 't1', p2: 't2' }));
await writeFile(join(bin, 'herdr'), `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), identities=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8'));
const pane=args[4], identity={pane_id:pane,terminal_id:identities[pane]}, agent={...identity,agent:'pi',agent_status:'idle',state_change_seq:1};
if(args[0]==='session')console.log(JSON.stringify({sessions:[{name:'isolated',running:true}]}));
else if(args[2]==='pane'&&args[3]==='list')console.log(JSON.stringify({result:{type:'pane_list',panes:Object.entries(identities).map(([pane_id,terminal_id])=>({pane_id,terminal_id,terminal_title_stripped:pane_id==='p1'?'Pi one':'Pi two'}))}}));
else if(args[2]==='pane')console.log(JSON.stringify({result:{type:'pane_info',pane:identity}}));
else if(args[3]==='prompt'){appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');writeFileSync(${JSON.stringify(artifact)},JSON.stringify({request:args[5],paneId:pane,answer:56}));console.log(JSON.stringify({result:{type:'agent_prompted',agent}}));}
else if(args[3]==='read')console.log('本次隔离任务已经写入 answer.json，须独立读文件核对。');
else console.log(JSON.stringify({result:{type:'agent_info',agent}}));
`);
await chmod(join(bin, 'herdr'), 0o700);
const config = join(root, 'config.json'), envFile = join(root, 'test.env');
await writeFile(config, JSON.stringify({ version: 2, projectDirectory: workspace,
  authorizedDirectories: [{ path: workspace, access: 'readwrite' }], desktopAutonomy: { authorizedDirectory: workspace },
  modules: { terminal: { enabled: true }, 'read-file': { enabled: true }, memory: { enabled: false }, shell: { enabled: true } } }), { mode: 0o600 });
await writeFile(envFile, 'RUNLOOM_MODEL=mock\n', { mode: 0o600 });
report.configSha256Before = await hash(config);
const env = Object.fromEntries(['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'DISPLAY', 'XAUTHORITY'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
Object.assign(env, { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
  RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1', RUNLOOM_USER_DATA: profile, RUNLOOM_CONFIG: config,
  RUNLOOM_ENV_FILE: envFile, RUNLOOM_WORKSPACE: workspace, RUNLOOM_TRANSCRIPTS: join(root, 'transcripts'), RUNLOOM_THREAD: 'chat-run-target-smoke' });
let running, page;
const snapshot = () => page.evaluate(() => window.runloom.snapshot());
const until = async check => {
  const deadline = Date.now() + 30_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Electron feature path did not settle'); await new Promise(done => setTimeout(done, 20)); }
};
const shot = async name => {
  const file = `${name}.png`;
  await page.screenshot({ path: join(output, file) });
  const evidence = { file, sha256: await hash(join(output, file)) };
  report.screenshots.push(evidence);
  return evidence;
};
const send = async text => {
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  await observeApprovals({ page, onEvent: event => report.approvalEvents.push(event) });
  await page.getByPlaceholder('和 Serika 聊天').fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('region', { name: '本轮 Pi 目标选择' })).toBeVisible();
  return snapshot();
};
const idle = () => until(async () => (await snapshot()).state.kind === 'idle');
const prompts = async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const decide = (approvalId, decision) => confirmApproval({ page, approvalId, decision, decisions: report.decisions });
const receipt = async runId => {
  const result = await page.evaluate(id => window.runloom.getRun(id), runId);
  assert.equal(result.ok, true); assert.ok(result.run); return result.run;
};
try {
  report.artifactHashes = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(async path => [path, await hash(join(desktop, path))])));
  running = await electron.launch({ args: [join(desktop, 'out/main/index.js'), '--home', join(home, '.serika')], cwd: root, env, timeout: 30_000 });
  page = await running.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  report.main = await running.evaluate(({ app }) => ({ electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
  report.renderer = await page.evaluate(() => ({ userAgent: navigator.userAgent, url: location.href }));
  assert.ok(report.main.electron); assert.equal(report.main.userData, profile); assert.equal(report.main.home, home);
  assert.match(report.renderer.userAgent, /Electron\//); assert.match(report.renderer.url, /^file:/);
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  const first = await send(`S2 pi ${report.runId}-first`);
  const selection = first.pendingHerdrSelection;
  assert.ok(selection); assert.equal(selection.candidates.length, 2); assert.equal(first.pendingApproval, null);
  assert.deepEqual(await prompts(), []);
  assert.equal((await receipt(first.state.runId)).tools[0].status, 'completed');
  assert.equal(report.approvalEvents.filter(row => row.type === 'event' && row.event.runId === first.state.runId && row.event.type === 'step.started').length, 1);
  await shot('choose-pi');
  await page.reload();
  await observeApprovals({ page, onEvent: event => report.approvalEvents.push(event) });
  await expect(page.getByRole('region', { name: '本轮 Pi 目标选择' })).toBeVisible();
  assert.equal((await snapshot()).pendingHerdrSelection.selectionId, selection.selectionId);
  const selected = { runId: first.state.runId, selectionId: selection.selectionId, candidateId: selection.candidates[1].candidateId,
    source: 'native-button-click', actor: 'codex-offline-script', status: 'attempting' };
  report.selections.push(selected);
  await page.getByRole('button', { name: '本轮使用', exact: true }).nth(1).click();
  await until(async () => report.approvalEvents.some(row => row.type === 'herdr-selection-decision' && row.runId === selected.runId && row.input.selectionId === selected.selectionId));
  selected.hostDecision = report.approvalEvents.find(row => row.type === 'herdr-selection-decision' && row.runId === selected.runId && row.input.selectionId === selected.selectionId);
  assert.equal(selected.hostDecision.input.candidateId, selected.candidateId);
  assert.equal(selected.hostDecision.selection.toolCallId, selection.toolCallId);
  assert.equal(selected.hostDecision.source, 'runtime-bridge');
  selected.response = { accepted: selected.hostDecision.accepted };
  assert.deepEqual(selected.response, { accepted: true }); selected.status = 'accepted';
  await until(async () => !!(await snapshot()).pendingApproval?.preview);
  const approved = await snapshot();
  assert.equal(approved.state.runId, first.state.runId);
  assert.equal(approved.pendingApproval.herdr.target.terminalId, 't2');
  assert.deepEqual(approved.pendingApproval.herdr.target, selection.candidates[1].target);
  assert.equal(approved.pendingApproval.herdr.selectionVersion, 1);
  assert.equal(approved.pendingHerdrSelection, null); assert.deepEqual(await prompts(), []);
  await shot('approve-frozen-pi');
  assert.deepEqual(await decide('unmatched-probe', 'allow'), { accepted: false });
  assert.deepEqual(await decide(approved.pendingApproval.approvalId, 'allow'), { accepted: true });
  await idle();
  await expect(page.getByText('S2_PI_DONE', { exact: true })).toBeVisible();
  const completed = await receipt(first.state.runId), result = JSON.parse(await readFile(artifact, 'utf8'));
  assert.deepEqual(completed.tools.map(tool => tool.toolName), ['herdr_pi_discover', 'herdr_pi_control', 'herdr_pi_read', 'read_file']);
  assert.ok(completed.tools.every(tool => tool.status === 'completed'));
  assert.equal(completed.tools.find(tool => tool.toolName === 'read_file').approvalRequestedAt, undefined);
  assert.ok(!report.approvalEvents.some(row => row.type === 'approval' && row.runId === first.state.runId && row.approval.toolName === 'read_file'));
  assert.equal(result.answer, 56); assert.equal(result.paneId, 'p2'); assert.equal(result.request, `S2 pi ${report.runId}-first`);
  assert.equal((await prompts()).length, 1);
  assert.equal((await snapshot()).pendingHerdrSelection, null);
  report.approvalChain = approvalChain({ runId: first.state.runId, receipt: completed, decisions: report.decisions, events: report.approvalEvents });
  assert.equal(report.approvalChain.filter(row => row.dispatched).length, 1);
  const dispatch = report.approvalChain.find(row => row.dispatched);
  const argv = (await prompts())[0];
  assert.equal(argv[1], dispatch.frozen.target.session); assert.equal(argv[4], dispatch.frozen.target.paneId);
  assert.equal(argv[5], dispatch.frozen.action.text);
  assert.equal(report.selections.filter(row => row.runId === first.state.runId && row.response.accepted).length, 1);
  assert.equal(report.approvalEvents.filter(row => row.type === 'herdr-selection-decision' && row.runId === first.state.runId && row.accepted).length, 1);
  assert.ok(report.approvalEvents.some(row => row.type === 'herdr-selection-click' && row.runId === first.state.runId && row.selectionId === selection.selectionId && row.candidateId === selected.candidateId && row.isTrusted));
  report.checks.push({ name: 'choose-continue-approve-readback-independent-file-check', result: 'passed', runId: first.state.runId,
    selectionId: selection.selectionId, approvalId: approved.pendingApproval.approvalId,
    adopted: approved.pendingApproval.herdr,
    fileApprovalId: null, filePermission: 'existing-workspace-autonomy', actualArtifact: result,
    tools: completed.tools.map(({ toolName, status }) => ({ toolName, status })), screenshot: await shot('independently-verified') });
  const second = await send(`S2 pi ${report.runId}-replaced`);
  assert.notEqual(second.pendingHerdrSelection.selectionId, selection.selectionId);
  assert.deepEqual(await page.evaluate(input => window.runloom.selectHerdrTarget(input), {
    selectionId: selection.selectionId, candidateId: selection.candidates[0].candidateId,
  }), { accepted: false });
  await page.getByRole('button', { name: '本轮使用', exact: true }).nth(1).click();
  await until(async () => !!(await snapshot()).pendingApproval?.preview);
  const stale = (await snapshot()).pendingApproval;
  assert.deepEqual(await decide(approved.pendingApproval.approvalId, 'allow'), { accepted: false });
  assert.equal((await snapshot()).pendingApproval.approvalId, stale.approvalId);
  report.checks.push({ name: 'original-preload-exact-approval-id-rejects-stale-and-unmatched', result: 'passed' });
  await writeFile(state, JSON.stringify({ p1: 't1', p2: 'replacement-t2' }));
  assert.deepEqual(await decide(stale.approvalId, 'allow'), { accepted: true });
  await idle();
  await expect(page.getByText('S2_PI_STOPPED', { exact: true })).toBeVisible();
  const changed = await receipt(second.state.runId);
  assert.equal(changed.tools.length, 2);
  assert.match(changed.tools[1].resultPreview, /HERDR_TARGET_CHANGED/);
  assert.equal((await prompts()).length, 1);
  assert.deepEqual(await page.evaluate(input => window.runloom.confirm(input), { approvalId: stale.approvalId, decision: 'allow' }), { accepted: false });
  report.approvalChain.push(...approvalChain({ runId: second.state.runId, receipt: changed, decisions: report.decisions, events: report.approvalEvents }));
  report.checks.push({ name: 'new-run-reselects-old-choice-invalid-replacement-blocks-old-approval', result: 'passed', runId: second.state.runId,
    failureCode: 'HERDR_TARGET_CHANGED', promptDispatches: (await prompts()).length, screenshot: await shot('replacement-blocked') });
  const cancelled = await send(`S2 pi ${report.runId}-cancelled`);
  const cancelSelection = cancelled.pendingHerdrSelection;
  assert.deepEqual(await page.evaluate(input => window.runloom.selectHerdrTarget(input), { selectionId: cancelSelection.selectionId, candidateId: null }), { accepted: true });
  await idle();
  assert.equal((await prompts()).length, 1);
  const cancelledReceipt = await receipt(cancelled.state.runId);
  assert.deepEqual(cancelledReceipt.tools.map(tool => tool.toolName), ['herdr_pi_discover']);
  assert.ok(!report.decisions.some(row => row.runId === cancelled.state.runId && row.response?.accepted));
  report.checks.push({ name: 'cancel-choice-zero-dispatch', result: 'passed', runId: cancelled.state.runId, selectionId: cancelSelection.selectionId });
  const denied = await send(`S2 pi ${report.runId}-denied`);
  await page.getByRole('button', { name: '本轮使用', exact: true }).nth(0).click();
  await until(async () => !!(await snapshot()).pendingApproval?.preview);
  const denyApproval = (await snapshot()).pendingApproval;
  assert.deepEqual(await decide(denyApproval.approvalId, 'deny'), { accepted: true });
  await idle();
  assert.equal((await prompts()).length, 1);
  report.approvalChain.push(...approvalChain({ runId: denied.state.runId, receipt: await receipt(denied.state.runId), decisions: report.decisions, events: report.approvalEvents }));
  report.checks.push({ name: 'deny-control-zero-dispatch', result: 'passed', runId: denied.state.runId, approvalId: denyApproval.approvalId });
  const shellStart = await page.evaluate(text => window.runloom.run(text), `S1 shell node -e 'require("node:fs").writeFileSync("shell-answer.json",JSON.stringify({total:7*8}))'`);
  assert.equal(shellStart.ok, true);
  const shellRun = shellStart.runId;
  await idle();
  const shellReceipt = await receipt(shellRun);
  assert.equal(shellReceipt.tools.length, 1); assert.equal(shellReceipt.tools[0].toolName, 'shell_exec');
  assert.equal(shellReceipt.tools[0].shell?.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, 'shell-answer.json'), 'utf8')), { total: 56 });
  report.checks.push({ name: 'electron-minimal-PATH-seatbelt-shell-independent-artifact', result: 'passed', runId: shellRun,
    tool: shellReceipt.tools[0], artifact: { total: 56 }, screenshot: await shot('shell-artifact-verified') });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  report.configSha256After = await hash(config);
  assert.equal(report.configSha256After, report.configSha256Before);
  assert.equal(JSON.parse(await readFile(config, 'utf8')).modules.terminal.target, undefined);
  report.status = 'passed';
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(0, 1500) };
  if (page) await shot('failure').catch(() => undefined);
} finally {
  if (running) {
    const child = running.process();
    await running.close();
    assert.notEqual(child.exitCode, null);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    report.electronStopped = true;
  }
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root), { code: 'ENOENT' });
  report.temporaryDirectoryRemoved = true;
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ output, status: report.status, checks: report.checks.map(item => item.name), failure: report.failure }));
if (report.status !== 'passed') process.exitCode = 1;
