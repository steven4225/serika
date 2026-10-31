import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'serika-chat-target-verification-'));
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), verification: 'offline-build-and-repository-tests',
  platform: process.platform, sourceCommit: git('rev-parse', 'HEAD'), sourceWorktreeDirty: !!git('status', '--porcelain'),
  scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), realModelCalls: 0, costUsd: 0, phases: [], status: 'running' };
const home = await mkdtemp(join(tmpdir(), 'serika-chat-target-verification-home-'));
const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
Object.assign(env, { HOME: home, SERIKA_TEST_HOME: home, SERIKA_B2_RECORD_CONCURRENT_HOME: '1' });
const save = () => writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
for (const [name, command] of [
  ['typecheck', ['pnpm', 'typecheck']],
  ['herdr-start-connect', [process.execPath, 'apps/desktop/scripts/chat-run-target-telegram-herdr-check.mjs', '--output', join(output, 'herdr')]],
  ['full-test', ['pnpm', 'test']],
]) {
  const log = join(output, `${name}.log`), fd = openSync(log, 'w');
  const row = { name, command, startedAt: new Date().toISOString(), log: `${name}.log` };
  report.phases.push(row);
  await save();
  console.log(JSON.stringify({ phase: name, status: 'running', output }));
  try {
    const child = spawn(command[0], command.slice(1), { cwd: repo, env, stdio: ['ignore', fd, fd] });
    const result = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (exitCode, signal) => done({ exitCode, signal })); });
    Object.assign(row, result);
  } finally { closeSync(fd); }
  const bytes = await readFile(log), text = bytes.toString('utf8');
  row.logSha256 = sha(bytes);
  row.finishedAt = new Date().toISOString();
  row.counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key,
    [...text.matchAll(new RegExp(`^ℹ ${key} (\\d+)`, 'gm'))].reduce((total, match) => total + Number(match[1]), 0)]));
  await save();
  console.log(JSON.stringify(row));
  if (row.exitCode !== 0) { report.status = 'failed'; break; }
}
if (report.status === 'running') report.status = 'passed';
report.finishedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ output, status: report.status }));
if (report.status !== 'passed') process.exitCode = 1;
