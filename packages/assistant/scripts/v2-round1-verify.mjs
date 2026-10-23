import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
assert.ok(args.includes('--home') && args.includes('--output'));
const home = resolve(value('--home')), output = resolve(value('--output'));
assert.ok(home.startsWith('/private/tmp/serika-s1-round1-'));
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
assert.ok(!output.startsWith(repo + '/'));
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => { const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0); return result.stdout; };
const baseline = '86b518a2e2fed68ef3485fef35099e1d35933db0';
const report = { runId: randomUUID(), generatedAt: new Date().toISOString(), sourceCommit: git('rev-parse', 'HEAD').trim(),
  sourceWorktreeDirty: !!git('status', '--porcelain').trim(), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  platform: process.platform, commands: [], frozen: {}, realModelCalls: 0, telegramOutbound: 0, serviceRegistrations: 0, costUsd: 0, status: 'failed' };
function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: repo, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const body = (result.stdout ?? '') + (result.stderr ?? '');
  const file = `command-${report.commands.length + 1}.log`;
  report.commands.push({ command: [command, ...argv], exitCode: result.status, signal: result.signal, log: file, sha256: sha(body),
    counts: [...body.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/g)].map(match => [match[1], Number(match[2])]) });
  return writeFile(join(output, file), body).then(() => { assert.equal(result.status, 0, body.slice(-5000)); });
}
try {
  assert.equal(report.sourceWorktreeDirty, false, 'Commit source first');
  assert.equal(git('branch', '--show-current').trim(), 'experiment/architecture-v2');
  for (const file of ['apps/desktop/scripts/electron-smoke.mjs', 'examples/eval/cm-step6-live.mjs',
    'packages/assistant/scripts/cm-step6-verify.mjs', 'packages/assistant/scripts/seatbelt-s1-check.mjs',
    'packages/assistant/scripts/seatbelt-s1-audit.mjs', 'apps/desktop/scripts/seatbelt-s1-electron.mjs',
    'packages/assistant/src/permission-decisions.snapshot.ts']) {
    const before = sha(git('show', `${baseline}:${file}`)), after = sha(await readFile(join(repo, file)));
    assert.equal(after, before, file); report.frozen[file] = after;
  }
  const file = 'packages/assistant/src/permission-boundary.snapshot.json';
  const before = git('show', `${baseline}:${file}`), after = await readFile(join(repo, file), 'utf8');
  const oldRows = JSON.parse(before), actual = JSON.parse(after), expected = structuredClone(oldRows);
  expected['telegram/shell_exec'] = { approvals: [], status: 'completed', events: [{ type: 'tool.call.completed', ok: true, code: null }] };
  assert.equal(after, JSON.stringify(expected, null, 2) + '\n');
  const changedKeys = Object.keys(actual).filter(key => JSON.stringify(actual[key]) !== JSON.stringify(oldRows[key]));
  assert.deepEqual(changedKeys, ['telegram/shell_exec']);
  report.b0 = { file, beforeSha256: sha(before), afterSha256: sha(after), approvedChangedKeys: ['telegram/shell_exec'], actualChangedKeys: changedKeys,
    otherBytesUnchanged: true, before: oldRows['telegram/shell_exec'], after: actual['telegram/shell_exec'] };
  const protectedFiles = ['packages/assistant/src/modules/seatbelt-policy.ts', 'packages/assistant/src/modules/seatbelt-shell-runner.ts', 'packages/assistant/src/modules/seatbelt-runtime.ts'];
  report.sharedSeatbelt = {};
  for (const file of protectedFiles) { const before = sha(git('show', `${baseline}:${file}`)), after = sha(await readFile(join(repo, file))); assert.equal(after, before); report.sharedSeatbelt[file] = after; }
  await run('/bin/sh', ['-c', 'pnpm typecheck', '--home', home]);
  await run('/bin/sh', ['-c', 'pnpm --filter @serika/desktop exec tsx --test --test-name-pattern="ordinary TG|stop pauses|independent TG authorization|TG grant survives|Steer supersedes" src/main/telegram-gateway.test.ts', '--home', home]);
  await run(process.execPath, ['packages/assistant/scripts/seatbelt-s1-check.mjs', '--home', join(dirname(home), 'native/H'), '--output', join(output, 'native')]);
  const native = JSON.parse(await readFile(join(output, 'native/native-result.json'), 'utf8')); assert.equal(native.status, 'passed');
  report.native = { runId: native.runId, file: 'native/native-result.json', sha256: sha(await readFile(join(output, 'native/native-result.json'))) };
  report.lineChanges = git('diff', '--numstat', baseline, 'HEAD').trim().split('\n').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t');
    const kind = path.startsWith('docs/') || path.endsWith('.json') ? 'docs-evidence' : path.includes('/scripts/') || path.includes('.test.') ? 'tests-verification' : 'product';
    return { path, kind, added: Number(added), removed: Number(removed) };
  });
  report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
finally { await writeFile(join(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, runId: report.runId, failure: report.failure }));
