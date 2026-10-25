import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tryAcquireFlock } from '../dist/flock.js';
import { EXPECTED_MEMORY_SHA, EXPECTED_PROJECTS, PERSONAL_PROJECT, RELEASE_PROJECT_ID, planDailyProjectRepair } from './daily-project-repair.mjs';
const exec = promisify(execFile), script = fileURLToPath(new URL('./daily-project-repair.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixtureMemory() {
  const stamp = '2026-10-25T00:00:00Z';
  return { version: 7, lastWrittenAt: stamp, entries: [], library: { revision: 3, folders: [], documents: [] }, excludedSources: [], importReceipts: [], suppressed: [],
    progress: [...Array.from({ length: 14 }, (_, i) => ({ projectId: null, threadId: `thread-${i}`, throughMessageId: `message-${i}`, prefixHash: `prefix-${i}`, pending: [], retry: null })),
      { projectId: RELEASE_PROJECT_ID, threadId: 'thread-0', throughMessageId: 'new-prefix', prefixHash: 'mistaken-prefix', pending: [], retry: { throughMessageId: 'failed', prefixHash: 'retry-prefix', failures: 2 } }] };
}
test('approved repair preserves every memory field except progress ownership and the mistaken progress', () => {
  const before = fixtureMemory(), original = structuredClone(before), plan = planDailyProjectRepair(before);
  assert.deepEqual(before, original);
  assert.deepEqual(plan.afterProjects, { version: 1, projects: [PERSONAL_PROJECT], selected: PERSONAL_PROJECT.id });
  assert.equal(plan.afterMemory.progress.length, 14);
  for (const [i, row] of plan.afterMemory.progress.entries()) assert.deepEqual(row, { ...before.progress[i], projectId: PERSONAL_PROJECT.id });
  assert.deepEqual({ ...plan.afterMemory, progress: before.progress }, before);
  assert.equal(plan.diff.filter(row => row.path.endsWith('/projectId')).length, 14);
  assert.deepEqual(plan.diff.find(row => row.path === '/progress/14').before, before.progress[14]);
  const changed = structuredClone(before); changed.progress.pop(); assert.throws(() => planDailyProjectRepair(changed), /一条发布目录/);
  changed.progress.push({ ...before.progress[14], projectId: PERSONAL_PROJECT.id }); assert.throws(() => planDailyProjectRepair(changed), /一条发布目录/);
});
test('CLI refuses unapproved SHA without creating locks, backups or any data mutation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-daily-repair-reject-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(join(home, 'data'), { recursive: true });
  const memory = JSON.stringify(fixtureMemory()); await writeFile(join(home, 'data/memory.json'), memory); await writeFile(join(home, 'data/projects.json'), EXPECTED_PROJECTS);
  for (const mode of ['--dry-run', '--apply']) await assert.rejects(exec(process.execPath, [script, '--home', home, mode]), /SHA 不等于获批/);
  assert.deepEqual(await readdir(root), ['home']); assert.deepEqual((await readdir(join(home, 'data'))).sort(), ['memory.json', 'projects.json']);
  assert.equal(await readFile(join(home, 'data/memory.json'), 'utf8'), memory);
  assert.equal(await readFile(join(home, 'data/projects.json'), 'utf8'), EXPECTED_PROJECTS);
});
if (process.env.SERIKA_DAILY_REPAIR_FIXTURE_HOME) test('approved daily-home COPY supports dry-run, full backup, SHA rollback protection and partial rollback', async () => {
  const source = process.env.SERIKA_DAILY_REPAIR_FIXTURE_HOME, root = await realpath(await mkdtemp(join(tmpdir(), 'serika-daily-repair-integration-'))), home = join(root, 'home');
  await exec('/bin/cp', ['-a', source, home]);
  const memoryPath = join(home, 'data/memory.json'), projectsPath = join(home, 'data/projects.json');
  const originals = await Promise.all([memoryPath, projectsPath].map(path => readFile(path)));
  assert.equal(sha(originals[0]), EXPECTED_MEMORY_SHA); assert.equal(originals[1].toString('utf8'), EXPECTED_PROJECTS);
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [script, '--home', home, ...args])).stdout);
  const beforeData = await readdir(join(home, 'data')), dry = await cli('--dry-run');
  assert.equal(dry.diff.length, 17); assert.deepEqual(await readdir(join(home, 'data')), beforeData);
  await writeFile(projectsPath, originals[1] + '\n'); await assert.rejects(cli('--apply'), /projects.json 不等于获批现值/); await writeFile(projectsPath, originals[1]);
  const held = await tryAcquireFlock(memoryPath + '.lock'); assert.ok(held);
  try { await assert.rejects(cli('--apply'), /数据正被使用/); } finally { await held.release(); }
  const result = await cli('--apply'), rollback = () => cli('--rollback', result.receiptPath, '--receipt-sha', result.receiptSha256);
  assert.equal(result.phase, 'applied'); assert.equal(result.files.length, 2);
  const repaired = await readFile(memoryPath), after = JSON.parse(repaired);
  assert.equal(after.progress.length, 14); assert.ok(after.progress.every(row => row.projectId === PERSONAL_PROJECT.id));
  assert.deepEqual({ ...after, progress: JSON.parse(originals[0]).progress }, JSON.parse(originals[0]));
  for (const row of result.files) assert.equal(sha(await readFile(row.backupPath)), row.beforeSha256);
  await assert.rejects(cli('--apply'), /SHA 不等于获批/);
  await assert.rejects(cli('--rollback', result.receiptPath, '--receipt-sha', '0'.repeat(64)), /回执 SHA 不符/);
  await writeFile(memoryPath, repaired + ' '); await assert.rejects(rollback(), /当前文件已变化/); await writeFile(memoryPath, repaired);
  await writeFile(projectsPath, originals[1]);
  assert.equal((await rollback()).identical, true);
  for (const [i, path] of [memoryPath, projectsPath].entries()) assert.deepEqual(await readFile(path), originals[i]);
  assert.equal((await rollback()).identical, true);
  for (const [i, path] of ['data/memory.json', 'data/projects.json'].entries()) assert.deepEqual(await readFile(join(source, path)), originals[i]);
  console.log(JSON.stringify({ integrationHome: home, backupDirectory: result.backupDirectory, receiptSha256: result.receiptSha256, sourceUnchanged: true, rollbackIdentical: true }));
});
