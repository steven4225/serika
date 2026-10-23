import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './test-home-guard.mjs';

export async function metadata(root) {
  const entries = [];
  async function visit(path) {
    let stat;
    try { stat = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    entries.push({ path, type, bytes: Number(stat.size), mtime: new Date(Number(stat.mtimeMs)).toISOString(),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), inode: String(stat.ino) });
    if (type === 'directory') for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return entries;
}

export async function guardedRun({ home, command, protectedRoot = join(userInfo().homedir, '.serika') }) {
  const isolatedHome = canonical(home), temporaryRoots = [canonical(tmpdir()), ...(process.platform === "win32" ? [] : [canonical("/tmp")])], realRoot = canonical(protectedRoot);
  assert.ok(temporaryRoots.some(root => isolatedHome.startsWith(root + sep)), '--home must be an absolute temporary directory');
  assert.ok(!isolatedHome.startsWith(realRoot + sep) && isolatedHome !== realRoot, '--home must not be the real Serika home');
  await mkdir(isolatedHome, { recursive: true });
  const output = await mkdtemp(join(isolatedHome, 'write-guard-'));
  const violationFile = join(output, 'violations.jsonl');
  await writeFile(violationFile, '');
  const before = await metadata(realRoot);
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), home: isolatedHome, protectedRoot: realRoot,
    command, before, after: null, events: [], exitCode: null, signal: null, status: 'failed' };
  const watched = before.length ? realRoot : dirname(realRoot);
  let child;
  const pendingChecks = [];
  const stop = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const watcher = watch(watched, { recursive: true }, (event, filename) => {
    const path = resolve(watched, String(filename ?? ''));
    if (path !== realRoot && !path.startsWith(realRoot + sep)) return;
    pendingChecks.push(metadata(realRoot).then(current => {
      if (JSON.stringify(current) === JSON.stringify(before)) return;
      report.events.push({ at: new Date().toISOString(), event, path });
      stop('SIGTERM');
    }));
  });
  const preload = new URL('./test-home-guard.mjs', import.meta.url).href;
  const env = { ...process.env, HOME: isolatedHome, SERIKA_HOME: isolatedHome, RUNLOOM_HOME: isolatedHome,
    SERIKA_TEST_HOME: isolatedHome, SERIKA_TEST_PROTECTED_ROOT: realRoot, SERIKA_TEST_VIOLATIONS: violationFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim() };
  const forward = stop;
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    child = spawn(command[0], command.slice(1), { env, stdio: 'inherit', detached: true });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    report.exitCode = result.code; report.signal = result.signal;
  } finally {
    watcher.close(); await Promise.all(pendingChecks); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    report.after = await metadata(realRoot);
    report.violations = (await readFile(violationFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    report.metadataUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    report.status = report.exitCode === 0 && report.metadataUnchanged && !report.events.length && !report.violations.length ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ testHomeGuard: report.status, evidence: join(output, 'result.json'),
      violations: report.violations.length, changes: report.events.length, metadataUnchanged: report.metadataUnchanged }));
  }
  return report.status === 'passed' ? 0 : report.exitCode || 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, home, separator, ...command] = process.argv.slice(2);
  assert.equal(flag, '--home');
  assert.ok(home && home.startsWith('/'), 'Pass an explicit temporary --home');
  assert.equal(separator, '--'); assert.ok(command.length);
  process.exitCode = await guardedRun({ home, command });
}
