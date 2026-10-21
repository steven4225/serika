import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sha = data => createHash('sha256').update(data).digest('hex');
const hash = async path => sha(await readFile(join(repo, path)));
const smokeScript = 'apps/desktop/scripts/electron-smoke.mjs';
assert.equal(await hash(smokeScript), '9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f');
assert.equal(git('status', '--porcelain'), '', 'Commit source before verification');
assert.equal(git('branch', '--show-current'), 'experiment/architecture-v2');
for (const name of Object.keys(process.env)) {
  if (/RUNLOOM.*(LIVE|ACCEPTANCE)/.test(name) && process.env[name]) throw new Error(`Disable paid opt-in ${name} before this offline verification`);
}
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), platform: process.platform,
  process: { node: process.version, pid: process.pid }, sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: false,
  baseCommit: git('rev-parse', 'a183ddf'), scriptSha256: await hash('packages/assistant/scripts/cm-step6-verify.mjs'),
  commands: [], metrics: [], realModelCalls: 0, costUsd: 0, status: 'failed' };
const root = await mkdtemp(join(tmpdir(), 'cm-step6-verification-'));
const evidence = 'docs/v2-pilot/evidence/cm-step6';
const smokeEvidence = 'docs/v2-pilot/evidence/electron-smoke';
const env = { ...process.env, TZ: "UTC", RUNLOOM_SMOKE_DAILY_CONFIG: join(root, `${report.runId}-absent-config.json`) };
function run(command, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const counts = [...output.matchAll(/[ℹ#] (tests|pass|fail|cancelled|skipped) (\d+)/g)].map(match => [match[1], Number(match[2])]);
  report.commands.push({ command: [command, ...args], startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, outputSha256: sha(output), outputBytes: Buffer.byteLength(output), counts });
  for (const match of output.matchAll(/CM_STEP6_METRICS (\{[^\n]+\})/g)) report.metrics.push(JSON.parse(match[1]));
  process.stdout.write(JSON.stringify(report.commands.at(-1)) + '\n');
  assert.equal(result.status, 0, output.slice(-12000));
}
try {
  report.lineChanges = git('diff', '--numstat', 'a183ddf', 'HEAD').split('\n').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t'); return { path, added: Number(added), removed: Number(removed) };
  });
  report.sourceHashes = Object.fromEntries(await Promise.all(report.lineChanges.map(async ({ path }) => [path, await hash(path)])));
  run('pnpm', ['typecheck']);
  run('pnpm', ['test']);
  run('pnpm', ['eval:test']);
  if (process.platform === 'linux') run('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', 'pnpm', '--filter', '@serika/desktop', 'smoke']);
  else run('pnpm', ['--filter', '@serika/desktop', 'smoke']);
  const smokePath = `${smokeEvidence}/result.json`;
  const smoke = JSON.parse(await readFile(join(repo, smokePath), 'utf8'));
  assert.equal(smoke.status, 'passed'); assert.equal(smoke.checks.length, 8); assert.equal(smoke.sourceWorktreeDirty, false);
  assert.equal(smoke.sourceCommit, report.sourceCommit); assert.equal(smoke.scriptSha256, await hash(smokeScript));
  for (const screenshot of smoke.screenshots) assert.equal(screenshot.sha256, await hash(`${smokeEvidence}/${screenshot.file}`));
  report.smoke = { file: smokePath, sha256: await hash(smokePath), scriptSha256: smoke.scriptSha256,
    checks: smoke.checks.map(({ name, result, unexpectedErrors }) => ({ name, result, unexpectedErrors })), screenshots: smoke.screenshots };

  run('node', ['examples/eval/cm-step6-offline-audit.mjs']);
  report.offlineAudit = { file: `${evidence}/offline-audit.json`, sha256: await hash(`${evidence}/offline-audit.json`) };
  report.status = 'passed';
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(-12000) };
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  report.temporaryDirectoryRemoved = true;
  report.finishedAt = new Date().toISOString();
  await mkdir(join(repo, evidence), { recursive: true });
  await writeFile(join(repo, evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.smoke) await writeFile(join(repo, smokeEvidence, 'cm-step6-run.json'), JSON.stringify({ runId: report.runId,
    sourceCommit: report.sourceCommit, startedAt: report.startedAt, finishedAt: report.finishedAt, ...report.smoke }, null, 2) + '\n');
}
