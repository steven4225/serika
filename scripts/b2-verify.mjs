import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url))), runId = randomUUID();
const output = resolve(process.argv[2] ?? join(tmpdir(), `serika-b2-verification-${runId}`));
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'serika-b2-tests-'));
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { runId, startedAt: new Date().toISOString(), verification: 'isolated-tests-with-fake-models-and-native-seatbelt',
  platform: process.platform, arch: process.arch, release: release(), node: process.version,
  sourceCommit: git(['rev-parse', 'HEAD']), sourceWorktreeDirty: !!git(['status', '--porcelain']), realModelCalls: 0,
  scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), commands: [], status: 'failed' };
const frozen = ['examples/eval/cm-step6-live.mjs', 'packages/assistant/scripts/cm-step6-verify.mjs',
  ...[1, 2, 3].map(n => `packages/assistant/scripts/v2-round${n}-verify.mjs`), 'apps/desktop/scripts/electron-smoke.mjs'];
report.frozenDiff = git(['diff', '8e0222f', '--', ...frozen, 'packages/assistant/src/__baseline__']);
assert.equal(report.frozenDiff, '');
const snapshotPath = 'packages/assistant/src/permission-boundary.snapshot.json';
const before = JSON.parse(git(['show', `8e0222f:${snapshotPath}`]));
const after = JSON.parse(await readFile(join(repo, snapshotPath), 'utf8'));
report.snapshot = { originalRows: Object.keys(before).length, added: Object.keys(after).filter(key => !(key in before)),
  changed: Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])), sha256: sha(await readFile(join(repo, snapshotPath))) };
assert.equal(report.snapshot.originalRows, 111); assert.deepEqual(report.snapshot.changed, []);
for (const command of [['pnpm', 'typecheck'], ['pnpm', 'test']]) {
  const log = join(output, `${command[1]}.log`), fd = openSync(log, 'w');
  const result = spawnSync(command[0], command.slice(1), { cwd: repo, stdio: ['ignore', fd, fd],
    env: { ...process.env, SERIKA_TEST_HOME: home, SERIKA_B2_RECORD_CONCURRENT_HOME: '1', SERIKA_B0_CAPTURE: join(output, 'b0-capture.json'), SERIKA_B2_CAPTURE: join(output, 'b2-capture.json') } });
  closeSync(fd);
  const text = await readFile(log, 'utf8');
  report.commands.push({ command: command.join(' '), exitCode: result.status, signal: result.signal,
    logSha256: sha(text), summaries: text.split('\n').filter(line => /^(ℹ (tests|pass|fail|skipped|cancelled|duration_ms)|# (tests|pass|fail|skipped)|\{"testHomeGuard")/.test(line) || line.startsWith('✔ b2 ') || line.startsWith('✔ b0 ')) });
  if (result.status !== 0) break;
}
report.status = report.commands.length === 2 && report.commands.every(item => item.exitCode === 0) ? 'passed' : 'failed';
if (report.status === 'passed') {
  const captured = JSON.parse(await readFile(join(output, 'b0-capture.json'), 'utf8'));
  report.snapshot.executedOriginalRows = Object.keys(captured).length;
  report.snapshot.executionDifferences = Object.keys(captured).filter(key => JSON.stringify(captured[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(report.snapshot.executionDifferences, []);
}
report.finishedAt = new Date().toISOString();
await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, output, commands: report.commands.map(({ command, exitCode }) => ({ command, exitCode })) }));
if (report.status !== 'passed') process.exitCode = 1;
