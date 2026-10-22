import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp, symlink, readdir, access } from 'node:fs/promises';
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
const outputRoot = process.env.SERIKA_CM6_VERIFY_OUTPUT ? resolve(process.env.SERIKA_CM6_VERIFY_OUTPUT) : repo;
assert.ok(outputRoot === repo || !outputRoot.startsWith(repo + '/'), 'External verification output must be outside the checkout');
const root = await mkdtemp(join(tmpdir(), 'cm-step6-verification-'));
const evidence = 'docs/v2-pilot/evidence/cm-step6';
const smokeEvidence = 'docs/v2-pilot/evidence/electron-smoke';
const auditDirectory = join(root, 'audit'), smokeCheckout = join(root, 'smoke-source');
const env = { ...process.env, TZ: process.env.TZ ?? "UTC", RUNLOOM_SMOKE_DAILY_CONFIG: join(root, `${report.runId}-absent-config.json`), SERIKA_CM6_EVIDENCE_DIR: auditDirectory };
report.timeZone = env.TZ;
const portable = value => typeof value === 'string' ? value.replaceAll(repo, '.').replaceAll(root, '<temporary>')
  : Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)])) : value;
function run(command, args, cwd = repo) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const counts = [...output.matchAll(/[ℹ#] (tests|pass|fail|cancelled|skipped) (\d+)/g)].map(match => [match[1], Number(match[2])]);
  report.commands.push({ command: portable([command, ...args]), cwd: portable(cwd), startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, outputSha256: sha(output), outputBytes: Buffer.byteLength(output), counts });
  for (const match of output.matchAll(/CM_STEP6_METRICS (\{[^\n]+\})/g)) report.metrics.push(JSON.parse(match[1]));
  process.stdout.write(JSON.stringify(report.commands.at(-1)) + '\n');
  assert.equal(result.status, 0, output.slice(-12000));
}
try {
  report.lineChanges = git('diff', '--numstat', 'a183ddf', 'HEAD').split('\n').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t'); return { path, added: Number(added), removed: Number(removed) };
  });
  report.sourceHashes = Object.fromEntries(await Promise.all(report.lineChanges.map(async ({ path }) => {
    try { return [path, await hash(path)]; }
    catch (error) { if (error.code === 'ENOENT' && git('ls-tree', 'HEAD', '--', path) === '') return [path, null]; throw error; }
  })));
  run('pnpm', ['typecheck']);
  for (const timeZone of ['UTC', 'Asia/Shanghai']) run('env', [`TZ=${timeZone}`, 'pnpm', 'test']);
  run('pnpm', ['eval:test']);
  // Keep the independently reproduced smoke script unchanged in a clean temporary checkout.
  run('git', ['clone', '--shared', '--no-checkout', repo, smokeCheckout]);
  run('git', ['checkout', '--detach', report.sourceCommit], smokeCheckout);
  // Git's node_modules/ rule does not cover directory symlinks.
  await writeFile(join(smokeCheckout, '.git/info/exclude'), '**/node_modules\n');
  const linkDependencies = async relative => {
    const source = join(repo, relative, 'node_modules');
    try { await access(source); } catch { return; }
    await symlink(source, join(smokeCheckout, relative, 'node_modules'), 'dir');
  };
  await linkDependencies('');
  for (const group of ['apps', 'packages']) for (const entry of await readdir(join(repo, group), { withFileTypes: true })) {
    if (entry.isDirectory()) await linkDependencies(join(group, entry.name));
  }
  if (process.platform === 'linux') run('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', 'pnpm', '--filter', '@serika/desktop', 'smoke'], smokeCheckout);
  else run('pnpm', ['--filter', '@serika/desktop', 'smoke'], smokeCheckout);
  const smokePath = `${smokeEvidence}/result.json`;
  const smokeBytes = await readFile(join(smokeCheckout, smokePath));
  const smoke = JSON.parse(smokeBytes);
  assert.equal(smoke.status, 'passed'); assert.equal(smoke.checks.length, 8); assert.equal(smoke.sourceWorktreeDirty, false);
  assert.equal(smoke.sourceCommit, report.sourceCommit); assert.equal(smoke.scriptSha256, await hash(smokeScript));
  for (const screenshot of smoke.screenshots) assert.equal(screenshot.sha256, sha(await readFile(join(smokeCheckout, smokeEvidence, screenshot.file))));
  report.smoke = { file: smokePath, sha256: sha(smokeBytes), scriptSha256: smoke.scriptSha256,
    checks: smoke.checks.map(({ name, result, unexpectedErrors }) => ({ name, result, unexpectedErrors })), screenshots: smoke.screenshots };

  run('node', ['examples/eval/cm-step6-offline-audit.mjs']);
  report.offlineAudit = { file: `${evidence}/offline-audit.json`, sha256: sha(await readFile(join(auditDirectory, 'offline-audit.json'))) };
  assert.equal(git('status', '--porcelain'), '', 'Verification must leave the source checkout clean until all checks finish');
  report.sourceStayedCleanDuringVerification = true;
  report.status = 'passed';
} catch (error) {
  report.failure = { name: error.name, message: portable(error.message.slice(-12000)) };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(join(outputRoot, evidence), { recursive: true });
  if (report.smoke) await cp(join(smokeCheckout, smokeEvidence), join(outputRoot, smokeEvidence), { recursive: true });
  try { await access(auditDirectory); await cp(auditDirectory, join(outputRoot, evidence), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(root, { recursive: true, force: true });
  report.temporaryDirectoryRemoved = true;
  await writeFile(join(outputRoot, evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.smoke) await writeFile(join(outputRoot, smokeEvidence, 'cm-step6-run.json'), JSON.stringify({ runId: report.runId,
    sourceCommit: report.sourceCommit, startedAt: report.startedAt, finishedAt: report.finishedAt, ...report.smoke }, null, 2) + '\n');
}
