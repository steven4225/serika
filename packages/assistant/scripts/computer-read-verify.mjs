import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadata } from '../../../scripts/test-home.mjs';

const [flag, home, outputFlag, destination] = process.argv.slice(2);
assert.equal(flag, '--home'); assert.equal(outputFlag, '--output');
assert.equal(resolve(home), process.env.SERIKA_TEST_HOME, 'Run through scripts/test-home.mjs');
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const output = resolve(destination); assert.ok(!output.startsWith(repo)); await mkdir(output, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const sha = data => createHash('sha256').update(data).digest('hex');
const baseline = '63cc724540b0e17b40e4f930b5e9b082234a8fd9';
const report = { runId: randomUUID(), generatedAt: new Date().toISOString(), baseline,
  sourceCommit: git('rev-parse', 'HEAD').trim(), status: 'failed', frozen: {}, rows: {}, metadataOnly: true };
try {
  assert.equal(git('status', '--porcelain').trim(), '');
  assert.equal(git('branch', '--show-current').trim(), 'experiment/architecture-v2');
  for (const file of ['apps/desktop/scripts/electron-smoke.mjs', 'examples/eval/cm-step6-live.mjs',
    'packages/assistant/scripts/cm-step6-verify.mjs', 'packages/assistant/scripts/seatbelt-s1-check.mjs',
    'packages/assistant/scripts/seatbelt-s1-audit.mjs', 'apps/desktop/scripts/seatbelt-s1-electron.mjs',
    'packages/assistant/scripts/v2-round1-verify.mjs', 'packages/assistant/scripts/v2-round2-verify.mjs', 'packages/assistant/scripts/v2-round3-verify.mjs',
    'packages/assistant/src/permission-decisions.snapshot.ts', 'packages/assistant/src/modules/seatbelt-policy.ts',
    'packages/assistant/src/modules/seatbelt-shell-runner.ts', 'packages/assistant/src/modules/seatbelt-runtime.ts']) {
    const before = sha(git('show', `${baseline}:${file}`)), after = sha(await readFile(join(repo, file)));
    assert.equal(after, before, file); report.frozen[file] = after;
  }
  const file = 'packages/assistant/src/permission-boundary.snapshot.json';
  const before = JSON.parse(git('show', `${baseline}:${file}`)), bytes = await readFile(join(repo, file)), after = JSON.parse(bytes);
  const approved = ['desktop', 'telegram'].flatMap(source => [`round3/${source}/computer_check/check`, `round3/${source}/computer_observe/observe`]);
  const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  assert.deepEqual(changed, approved);
  const added = Object.keys(after).filter(key => !(key in before));
  assert.deepEqual(added, ['desktop', 'telegram'].map(source => `round3/${source}/computer_observe/unauthorized`));
  for (const key of [...approved, ...added]) {
    assert.deepEqual(after[key].approvals, []); assert.deepEqual(after[key].events, []);
    if (key.endsWith('/unauthorized')) assert.deepEqual(after[key].results, Array.from({ length: 2 }, () => ({ ok: false,
      error: { code: 'COMPUTER_PRECHECK_FAILED', message: 'Application is not allowed' } })));
  }
  report.rows = { preserved: Object.keys(before).length - changed.length, changed, added, total: Object.keys(after).length,
    sha256: sha(bytes), actual: Object.fromEntries([...approved, ...added].map(key => [key, after[key]])) };
  const entries = await metadata(join(userInfo().homedir, '.serika'));
  const priorPath = 'docs/v2-pilot/evidence/architecture-v2-a2-correction/default-data-metadata.json';
  const prior = JSON.parse(await readFile(join(repo, priorPath), 'utf8'));
  report.defaultHome = { entries, priorEvidence: priorPath, comparisons: prior.files.map(file => {
    const current = entries.find(entry => entry.path === join(userInfo().homedir, '.serika/data', file.name));
    assert.ok(current); assert.equal(current.bytes, file.size);
    const deltaMs = Math.abs(Number(BigInt(current.mtimeNs)) / 1e6 - Date.parse(file.modified));
    assert.ok(deltaMs < 1, 'Historical metadata has millisecond precision');
    return { path: current.path, sizeUnchanged: true, mtimeDeltaMs: deltaMs };
  }) };
  report.rounds = [];
  for (const round of [1, 2, 3]) {
    const path = `docs/v2-pilot/evidence/v2-round${round}/unified/docs/v2-pilot/evidence/cm-step6/verification.json`;
    const value = JSON.parse(await readFile(join(repo, path), 'utf8'));
    report.rounds.push({ round, path, startedAt: value.startedAt, finishedAt: value.finishedAt, commandCount: value.commands.length });
    assert.ok(entries.every(entry => Date.parse(entry.mtime) < Date.parse(value.startedAt)));
  }
  report.lineChanges = git('diff', '--numstat', baseline, 'HEAD').trim().split('\n').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t');
    const kind = path.endsWith('.snapshot.json') ? 'snapshot' : path.startsWith('docs/') ? 'docs-evidence'
      : path.includes('/scripts/') || path.startsWith('scripts/') || path.endsWith('package.json') || path.includes('.test.') ? 'test-verification' : 'product';
    return { path, kind, added: Number(added), removed: Number(removed) };
  });
  report.status = 'passed';
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
await writeFile(join(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, runId: report.runId, failure: report.failure }));
