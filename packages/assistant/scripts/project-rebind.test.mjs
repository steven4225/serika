import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { identifyProject, selectProject } from '../dist/project.js';
import { V7MemoryStore } from '../dist/memory-v7-store.js';
import { tryAcquireFlock } from '../dist/flock.js';
const exec = promisify(execFile), script = fileURLToPath(new URL('./project-rebind.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), encoded = value => JSON.stringify(value, null, 4) + '\n\n';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-project-rebind-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, 'home/data'), oldPath = join(root, 'old-project'), newPath = join(root, 'moved-project'); await mkdir(oldPath);
  const old = await selectProject({ dataDirectory, directory: oldPath }), scope = { kind: 'project', projectId: old.id }, stamp = '2026-10-25T00:00:00Z';
  const entry = (id, category, entryScope = scope) => ({ id, category, scope: entryScope, revision: 2, text: `FIXTURE_${id}`, uncertain: false, pinned: false, state: 'active', createdAt: stamp, updatedAt: stamp, sources: [{ kind: 'conversation', threadId: 'thread', messageId: `user-${id}`, quote: `FIXTURE_${id}`, sentAt: stamp }], replaces: [], supersededBy: null, withdrawal: null });
  const document = { version: 7, lastWrittenAt: stamp, entries: [entry('note', 'note'), entry('body', 'document'), entry('pref', 'preference', { kind: 'user' })], excludedSources: [{ threadId: 'thread', messageId: 'excluded' }],
    library: { revision: 3, folders: [], documents: [{ id: 'document', title: 'PROJECT_DOCUMENT', folderId: null, entryIds: ['body'], scope }] },
    progress: [{ threadId: 'thread', projectId: old.id, throughMessageId: 'user-note', prefixHash: 'original-transcript-hash', pending: [], retry: null }],
    suppressed: [{ threadId: 'thread', messageId: 'withdrawn', scope, identity: { subject: 'user', attribute: 'fixture' } }],
    importReceipts: [{ operationId: 'import', requestHash: 'a'.repeat(64), projectId: old.id, threadId: 'thread', committedAt: stamp, items: [{ id: 'note', status: 'saved' }] }] };
  const memoryPath = join(dataDirectory, 'memory.json'), registryPath = join(dataDirectory, 'projects.json'); await writeFile(memoryPath, encoded(document)); await chmod(memoryPath, 0o640); await chmod(registryPath, 0o640);
  const originals = await Promise.all([memoryPath, registryPath].map(path => readFile(path))); await rename(oldPath, newPath);
  const cli = (...args) => exec(process.execPath, [script, '--data', dataDirectory, ...args]);
  return { root, dataDirectory, oldPath, newPath, old, document, memoryPath, registryPath, originals, cli };
}
test('moved project reports an absolute CLI command, rebinds all v7 associations and rolls back both exact SHAs', async t => {
  const f = await fixture(t), beforeFiles = await readdir(f.dataDirectory);
  let cliError;
  await assert.rejects(selectProject({ dataDirectory: f.dataDirectory }), /项目 old-project 在 .*old-project 找不到了；如已移动，运行 '\/.*' '\/.*project-rebind.mjs'/);
  const cliPath = fileURLToPath(new URL('../../../apps/cli/dist/index.js', import.meta.url));
  const env = Object.fromEntries(['PATH', 'LANG', 'NODE_OPTIONS', 'SERIKA_TEST_HOME', 'SERIKA_TEST_VIOLATIONS', 'SERIKA_TEST_PROTECTED_ROOT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, { HOME: f.root, RUNLOOM_MODEL: 'mock' });
  try { await selectProject({ dataDirectory: f.dataDirectory }); } catch (error) { cliError = String(error); }
  const cli = exec(process.execPath, [cliPath, '--tui', '--home', join(f.root, 'home')], { cwd: f.newPath, env });
  cli.child.stdin.end('/exit\n');
  await cli;
  const dry = JSON.parse((await f.cli('--from', f.oldPath, '--to', f.newPath, '--dry-run')).stdout);
  assert.deepEqual(dry.affected, { entries: 2, documents: 1, progress: 1, receipts: 1, suppressed: 1, registrations: 1, selected: 1 });
  assert.deepEqual(await readdir(f.dataDirectory), beforeFiles); assert.doesNotMatch(JSON.stringify(dry), /FIXTURE_note/);
  for (const [i, path] of [f.memoryPath, f.registryPath].entries()) assert.deepEqual(await readFile(path), f.originals[i]);
  const receipt = JSON.parse((await f.cli('--from', f.old.id, '--to', f.newPath, '--upgrade')).stdout), target = await identifyProject(f.newPath);
  const selected = await selectProject({ dataDirectory: f.dataDirectory }); assert.equal(selected.id, target.id);
  const cold = new V7MemoryStore(f.memoryPath, target.id), list = await cold.readV7(); assert.ok(list.ok); assert.equal(list.value.entries.length, 3); assert.equal(list.value.library.documents.length, 1); assert.equal(list.value.progress.length, 1); assert.equal(list.value.importReceipts.length, 1); assert.equal(list.value.suppressed.length, 1);
  assert.equal((await new V7MemoryStore(f.memoryPath, f.old.id).readV7()).value.entries.length, 1);
  assert.equal(list.value.importReceipts[0].requestHash, f.document.importReceipts[0].requestHash); assert.equal(list.value.progress[0].prefixHash, f.document.progress[0].prefixHash);
  for (const [i, entry] of list.value.entries.entries()) assert.deepEqual({ ...entry, scope: f.document.entries[i].scope }, f.document.entries[i]);
  const rollback = JSON.parse((await f.cli('--rollback', receipt.receiptPath)).stdout); assert.equal(rollback.identical, true);
  for (const [i, path] of [f.memoryPath, f.registryPath].entries()) { assert.deepEqual(await readFile(path), f.originals[i]); assert.equal((await stat(path)).mode & 0o777, 0o640); }
  await assert.rejects(selectProject({ dataDirectory: f.dataDirectory }), /找不到了/);
  if (process.env.SERIKA_PROJECT_REBIND_EVIDENCE) {
    const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceWorktreeDirty = !!(await exec('git', ['status', '--porcelain'])).stdout.trim();
    const evidence = { runId: randomUUID(), sourceCommit, sourceWorktreeDirty, scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), verification: 'synthetic-data-real-cli-offline-rebind-v7-store-rollback', realModelCalls: 0, status: 'passed', diagnostic: cliError.match(/Error: (项目[^\n]+)/)[1], affected: dry.affected, visibleAfterRebind: { entries: 3, projectEntries: 2, documents: 1, progress: 1, receipts: 1, suppressed: 1 }, originalHistoricalHashesPreserved: true, files: rollback.files, modesIdentical: true };
    await writeFile(process.env.SERIKA_PROJECT_REBIND_EVIDENCE, encoded(evidence));
  }
});
test('existing target associations stop rebind without merging, including inactive entries and progress-only targets', async t => {
  const f = await fixture(t), target = await identifyProject(f.newPath);
  for (const field of ['entries', 'documents', 'progress', 'importReceipts', 'suppressed']) {
    const doc = structuredClone(f.document);
    if (field === 'entries') doc.entries.push({ ...doc.entries[0], id: 'target', state: 'disabled', scope: { kind: 'project', projectId: target.id } });
    else if (field === 'documents') doc.library.documents.push({ ...doc.library.documents[0], id: 'target', scope: { kind: 'project', projectId: target.id } });
    else if (field === 'suppressed') doc.suppressed.push({ ...doc.suppressed[0], scope: { kind: 'project', projectId: target.id } });
    else doc[field].push({ ...doc[field][0], projectId: target.id });
    await writeFile(f.memoryPath, encoded(doc)); const before = await readFile(f.memoryPath);
    for (const mode of ['--dry-run', '--upgrade']) await assert.rejects(f.cli('--from', f.old.id, '--to', f.newPath, mode), /目标项目已有/);
    assert.deepEqual(await readFile(f.memoryPath), before); assert.deepEqual(await readFile(f.registryPath), f.originals[1]);
  }
});
test('partial two-file commit rolls back, while drift, corrupt backup, links and a held lock refuse overwrites', async t => {
  const f = await fixture(t), rebind = () => f.cli('--from', f.old.id, '--to', f.newPath, '--upgrade');
  const lock = await tryAcquireFlock(`${f.memoryPath}.lock`); assert.ok(lock); try { await assert.rejects(rebind(), /数据正被其他进程使用/); } finally { await lock.release(); }
  for (const kind of ['symlink', 'hardlink']) {
    const original = `${f.memoryPath}.original`; await rename(f.memoryPath, original);
    await (kind === 'symlink' ? symlink(original, f.memoryPath) : link(original, f.memoryPath)); await assert.rejects(rebind()); await rm(f.memoryPath); await rename(original, f.memoryPath);
  }
  const receipt = JSON.parse((await rebind()).stdout), rollback = () => f.cli('--rollback', receipt.receiptPath), rebound = await readFile(f.memoryPath);
  await writeFile(f.memoryPath, rebound + ' '); await assert.rejects(rollback(), /当前文件已变化/); await writeFile(f.memoryPath, rebound);
  const row = receipt.files.find(row => row.path === f.registryPath), backup = await readFile(row.backupPath); await writeFile(row.backupPath, 'bad'); await assert.rejects(rollback(), /备份 SHA 不符/); assert.deepEqual(await readFile(f.memoryPath), rebound); await writeFile(row.backupPath, backup);
  await writeFile(f.registryPath, f.originals[1]); const result = JSON.parse((await rollback()).stdout); assert.ok(result.identical);
  assert.deepEqual(await readFile(f.memoryPath), f.originals[0]); assert.deepEqual(await readFile(f.registryPath), f.originals[1]);
});
test('a registered project without memory can rebind and rollback without creating memory', async t => {
  const f = await fixture(t); await rm(f.memoryPath);
  const result = JSON.parse((await f.cli('--from', f.old.id, '--to', f.newPath, '--upgrade')).stdout); assert.equal(result.files.length, 1);
  assert.equal((await new V7MemoryStore(f.memoryPath, result.to.id).list()).entries.length, 0);
  assert.ok(JSON.parse((await f.cli('--rollback', result.receiptPath)).stdout).identical); assert.deepEqual(await readFile(f.registryPath), f.originals[1]);
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});
