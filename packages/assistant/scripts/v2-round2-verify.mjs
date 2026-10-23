import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const value = key => { const index = args.indexOf(key); assert.ok(index >= 0 && args[index + 1]); return resolve(args[index + 1]); };
const home = value('--home'), output = value('--output');
assert.ok(home.startsWith('/private/tmp/serika-v2-round2-'));
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
assert.ok(!output.startsWith(repo + '/') && output !== repo);
await mkdir(home, { recursive: true }); await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...argv) => { const result = spawnSync('git', argv, { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0); return result.stdout; };
const baseline = '68dcda6d4cccca68d4c763b8c8461c1d192c0006';
const report = { runId: randomUUID(), generatedAt: new Date().toISOString(), baseline, sourceCommit: git('rev-parse', 'HEAD').trim(),
  sourceWorktreeDirty: !!git('status', '--porcelain').trim(), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  platform: process.platform, commands: [], frozen: {}, realModelCalls: 0, telegramOutbound: 0, serviceRegistrations: 0, costUsd: 0, status: 'failed' };
async function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: repo, env: { ...process.env, HOME: home, SERIKA_HOME: home, RUNLOOM_HOME: home }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const body = (result.stdout ?? '') + (result.stderr ?? ''), file = `command-${report.commands.length + 1}.log`;
  report.commands.push({ command: [command, ...argv], exitCode: result.status, signal: result.signal, log: file, sha256: sha(body),
    counts: [...body.matchAll(/[ℹ#] (tests|pass|fail|skipped) (\d+)/g)].map(match => [match[1], Number(match[2])]) });
  await writeFile(join(output, file), body); assert.equal(result.status, 0, body.slice(-6000));
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
  const oldRows = JSON.parse(before), actual = JSON.parse(after);
  for (const [key, row] of Object.entries(oldRows)) assert.deepEqual(actual[key], row, key);
  const added = Object.keys(actual).filter(key => !(key in oldRows));
  assert.deepEqual(added, ['terminal/desktop/terminal_exec', 'terminal/telegram/terminal_exec']);
  assert.equal(after, JSON.stringify({ ...oldRows, ...Object.fromEntries(added.map(key => [key, actual[key]])) }, null, 2) + '\n');
  for (const key of added) {
    assert.equal(actual[key].approvals.length, 2);
    assert.ok(actual[key].approvals.every(approval => approval.tool === 'terminal_exec' && approval.remember === null && approval.preview.includes('outside Seatbelt')));
    assert.deepEqual(actual[key].events, ['TOOL_DENIED', 'TOOL_DENIED']);
  }
  report.b0 = { file, beforeSha256: sha(before), afterSha256: sha(after), existingRows: Object.keys(oldRows).length,
    changedExistingKeys: [], addedKeys: added, rows: Object.fromEntries(added.map(key => [key, actual[key]])) };
  report.sharedSeatbelt = {};
  for (const file of ['packages/assistant/src/modules/seatbelt-policy.ts', 'packages/assistant/src/modules/seatbelt-shell-runner.ts', 'packages/assistant/src/modules/seatbelt-runtime.ts']) {
    const before = sha(git('show', `${baseline}:${file}`)), after = sha(await readFile(join(repo, file))); assert.equal(after, before, file); report.sharedSeatbelt[file] = after;
  }
  await run('/bin/sh', ['-c', 'pnpm typecheck && pnpm build:runtime', '--home', home]);
  await run('/bin/sh', ['-c', 'node --test packages/assistant/dist/terminal-control.test.js packages/assistant/dist/permission-boundary.test.js packages/assistant/dist/baseline-assembly.test.js packages/assistant/dist/execution-record-store.test.js packages/assistant/dist/context-compactor.test.js packages/assistant/dist/tui-module-config.test.js', '--home', home]);
  await run('/bin/sh', ['-c', 'pnpm --filter @serika/desktop exec tsx --test src/main/telegram-gateway.test.ts src/main/herdr-target.test.ts src/main/module-settings.test.ts src/main/ipc-forwards.test.ts src/main/resident-transport.test.ts src/main/desktop-runtime.test.ts src/main/runtime-ownership.test.ts src/renderer/src/herdr-target-setting.test.ts src/renderer/src/conversation.test.ts', '--home', home]);
  report.lineChanges = git('diff', '--numstat', baseline, 'HEAD').trim().split('\n').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t');
    const kind = path.endsWith('.snapshot.json') ? 'snapshot' : path.startsWith('docs/') ? 'docs-evidence' : path.includes('/scripts/') || path.includes('.test.') ? 'tests-verification' : 'product';
    return { path, kind, added: Number(added), removed: Number(removed) };
  });
  assert.equal(git('status', '--porcelain').trim(), '');
  report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
finally { await writeFile(join(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, runId: report.runId, failure: report.failure }));
