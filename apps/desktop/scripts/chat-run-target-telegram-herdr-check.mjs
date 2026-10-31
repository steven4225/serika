import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryAcquireFlock } from '@serika/assistant';
import { setup, addPi, cleanup } from './chat-run-target-live-herdr.mjs';
import { telegramTestSettings, prepareTelegramTestProfile } from './chat-run-target-telegram-profile.mjs';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const outputIndex = process.argv.indexOf('--output');
assert.ok(outputIndex >= 0 && process.argv[outputIndex + 1], '--output is required');
const output = resolve(process.argv[outputIndex + 1]);
assert.ok(output !== resolve(repo) && !output.startsWith(resolve(repo) + '/'), 'Evidence must be outside the repository');
await mkdir(output);
const profileRoot = await mkdtemp('/private/tmp/s197p-');
const model = 'deepseek/deepseek-v4.1-flash-fast';
const settings = telegramTestSettings({ source: { SERIKA_TG_TEST_ONLY: '1', SERIKA_TG_TEST_BOT_ID: '123456',
  SERIKA_TG_TEST_OWNER_USER_ID: '42', SERIKA_TG_TEST_OWNER_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: '123456:offline-only',
  COMMAND_CODE_BASE_URL: 'https://api.commandcode.ai/provider/v1', COMMAND_CODE_MODEL_ID: model, COMMAND_CODE_API_KEY: 'offline-only',
  SERIKA_TG_TEST_PROFILE_ROOT: profileRoot }, forbiddenBotId: 8797046945 });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const report = { batchId: randomUUID(), startedAt: new Date().toISOString(), verification: 'real-herdr-start-connect-two-offline-pi',
  sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: !!git('status', '--porcelain'), platform: process.platform, node: process.version,
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  runtimeRoot: settings.runtimeRoot, profileRoot, status: 'failed', modelProxyRequests: 0, realModelCalls: 0, telegramCalls: 0, costUsd: 0 };
const proxy = createServer((_req, res) => { report.modelProxyRequests++; res.writeHead(503); res.end('Offline check forbids model requests'); });
let lease, fixture;
try {
  lease = await prepareTelegramTestProfile(settings);
  report.leaseAcquired = true;
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  fixture = await setup(settings.runtimeRoot, `http://127.0.0.1:${proxy.address().port}/pi/v1`, model);
  report.secondPi = await addPi(fixture.statePath);
  report.workspaceList = JSON.parse(execFileSync('/opt/homebrew/bin/herdr', ['--session', fixture.target.session, 'workspace', 'list'],
    { cwd: fixture.work, env: fixture.env, encoding: 'utf8', timeout: 35000 }));
  assert.equal(report.workspaceList.error, undefined);
  assert.equal(report.workspaceList.result.type, 'workspace_list');
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  assert.equal(state.phase, 'ready'); assert.equal(state.unknown, false);
  assert.equal(state.targets.length, 2); assert.equal(state.piSessions.length, 2);
  assert.equal(state.operations.filter(row => row.phase.endsWith('pi-start')).length, 2);
  process.kill(state.serverPid, 0);
  report.serverPid = state.serverPid;
  await assert.rejects(prepareTelegramTestProfile(settings), /Another test host owns this profile/);
  report.concurrentHostRejected = true;
  report.initialObservation = state.initialObservation;
  assert.equal(report.modelProxyRequests, 0, 'Offline Pi unexpectedly requested a model');
  report.cleanup = await cleanup(fixture.statePath);
  assert.equal(report.modelProxyRequests, 0);
  await copyFile(fixture.statePath, join(output, 'herdr-state.json'));
  await copyFile(join(fixture.root, 'server.log'), join(output, 'server.log'));
  await rm(settings.runtimeRoot, { recursive: true });
  await lease.release(); lease = undefined;
  const released = await tryAcquireFlock(join(profileRoot, 'harness.lock'));
  assert.ok(released, 'Test profile lease was not released');
  await released.release(); report.leaseReleasedAndReacquired = true;
  report.status = 'passed';
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  report.retainedRuntime = settings.runtimeRoot;
  process.exitCode = 1;
} finally {
  await new Promise(done => proxy.close(done));
  if (lease) await lease.release();
  if (report.status === 'passed') await rm(profileRoot, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, runtimeRoot: settings.runtimeRoot, modelProxyRequests: report.modelProxyRequests, failure: report.failure, output }));
