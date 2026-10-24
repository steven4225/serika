import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tryAcquireFlock } from '../dist/flock.js';
import { V7MemoryStore } from '../dist/memory-v7-store.js';
import { identifyProject } from '../dist/project.js';
import { planMemoryUpgrade, validateLegacyV6MemoryDocument } from './memory-upgrade.mjs';
const exec = promisify(execFile), script = fileURLToPath(new URL('./memory-upgrade.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), encoded = value => JSON.stringify(value, null, 4) + '\n\n';
const ids = ['978a1257-96f3-43e4-9991-7468dab39116', '41f1d455-ef45-4a87-9f4f-d47435067e35', 'f6e52e58-8fb2-4d03-aabc-70482681be29', '671b1ca0-e533-4ae7-9fdb-f655af8b39eb', '0a0f2df1-6496-4e69-ab94-8b6fc2e54dd7', '8291bb0f-cbf3-4d8a-83fd-802c45db1293'];
const stamp = '2026-10-24T01:00:00.000Z';
function fixtureDocument() {
  const entries = ids.map((id, index) => ({ id, revision: 2, text: `PRIVATE_FIXTURE_BODY_${index}`, uncertain: false,
    category: index < 3 ? 'preference' : 'document', identity: { subject: 'user', attribute: `attribute-${index}`, value: `value-${index}` }, scope: { kind: 'workspace' }, pinned: index === 0, state: 'active', createdAt: stamp, updatedAt: stamp,
    sources: [{ kind: 'conversation', threadId: 'thread', messageId: `message-${index}`, quote: `PRIVATE_FIXTURE_BODY_${index}`, sentAt: stamp }], replaces: [], supersededBy: null, withdrawal: null }));
  return { version: 6, lastWrittenAt: stamp, entries, excludedSources: [], progress: [{ threadId: 'thread', throughMessageId: 'message-5', prefixHash: 'prefix', pending: [], retry: null }], suppressed: [],
    library: { revision: 3, folders: [{ id: 'folder', name: 'fixture' }], documents: entries.slice(3).map(entry => ({ id: `document-${entry.id}`, title: 'fixture', folderId: 'folder', entryIds: [entry.id], scope: { kind: 'workspace' } })) },
    importReceipts: [{ operationId: 'old-import', requestHash: 'a'.repeat(64), threadId: 'thread', items: [{ id: entries[0].id, status: 'saved' }], committedAt: stamp }] };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-memory-upgrade-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, 'project'); await mkdir(projectPath); await mkdir(join(projectPath, '.git'));
  const memoryPath = join(root, 'memory.json'), document = fixtureDocument(), original = Buffer.from(encoded(document));
  await writeFile(memoryPath, original); await chmod(memoryPath, 0o640);
  const cli = (...args) => exec(process.execPath, [script, '--memory', memoryPath, '--project', projectPath, ...args]);
  return { root, projectPath, memoryPath, document, original, cli };
}

test('offline dry-run is read-only; upgrade preserves all sources and counts, cold opens v7, and rollback restores exact SHA and mode', async t => {
  const f = await fixture(t), before = await readdir(f.root), project = await identifyProject(f.projectPath);
  const preview = JSON.parse((await f.cli('--dry-run')).stdout);
  assert.equal(preview.ok, true); assert.deepEqual(preview.counts, { entries: 6, preferences: 3, documents: 3, libraryDocuments: 3 });
  assert.ok(preview.entries.slice(0, 3).every(row => row.scope.kind === 'user'));
  assert.ok(preview.entries.slice(3).every(row => row.scope.projectId === project.id));
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_FIXTURE_BODY/); assert.deepEqual(await readdir(f.root), before); assert.deepEqual(await readFile(f.memoryPath), f.original);
  const receipt = JSON.parse((await f.cli('--upgrade')).stdout), upgraded = JSON.parse(await readFile(f.memoryPath, 'utf8'));
  assert.deepEqual(await readFile(receipt.backupPath), f.original); assert.equal(receipt.originalSha256, sha(f.original)); assert.equal(receipt.upgradedSha256, sha(await readFile(f.memoryPath)));
  assert.equal(upgraded.version, 7); assert.equal(upgraded.entries.length, 6); assert.equal(upgraded.library.documents.length, 3);
  assert.deepEqual(upgraded.progress, f.document.progress.map(item => ({ ...item, projectId: null })));
  assert.deepEqual(upgraded.importReceipts, f.document.importReceipts.map(item => ({ ...item, projectId: null })));
  for (let i = 0; i < upgraded.entries.length; i++) { const { scope: _scope, ...entry } = upgraded.entries[i], { scope: _old, ...old } = f.document.entries[i]; assert.deepEqual(entry, old); }
  const cold = await new V7MemoryStore(f.memoryPath, project.id).readV7(); assert.equal(cold.ok, true);
  assert.equal((await stat(f.memoryPath)).mode & 0o777, 0o640); assert.equal((await stat(receipt.backupPath)).mode & 0o777, 0o600);
  const restored = JSON.parse((await f.cli('--rollback', receipt.receiptPath)).stdout);
  assert.equal(restored.identical, true); assert.equal(restored.originalSha256, restored.restoredSha256); assert.equal(restored.restoredSha256, sha(f.original)); assert.deepEqual(await readFile(f.memoryPath), f.original);
  await assert.rejects(f.cli('--rollback', receipt.receiptPath), /记忆已变化/);
});

test('unknown preference is listed without content and blocks upgrade until an exact explicit mapping is provided', async t => {
  const f = await fixture(t), unknown = { ...f.document.entries[0], id: 'unknown-preference' };
  f.document.entries.push(unknown); await writeFile(f.memoryPath, encoded(f.document)); const original = await readFile(f.memoryPath);
  await assert.rejects(f.cli('--dry-run'), error => { const result = JSON.parse(error.stdout); assert.equal(result.ok, false); assert.deepEqual(result.unknown, [{ id: unknown.id, category: 'preference' }]); assert.doesNotMatch(error.stdout, /PRIVATE_FIXTURE_BODY/); return true; });
  await assert.rejects(f.cli('--upgrade'), /未裁决归属/); assert.deepEqual(await readFile(f.memoryPath), original);
  const mappingPath = join(f.root, 'mapping.json'); await writeFile(mappingPath, JSON.stringify([{ id: unknown.id, scope: { kind: 'user' } }]));
  assert.equal(JSON.parse((await f.cli('--mapping', mappingPath, '--upgrade')).stdout).ok, true);
});

test('additional approved note maps to Serika; suppression needs its own scope and document chunks cannot disagree', async t => {
  const f = await fixture(t), project = await identifyProject(f.projectPath), note = { ...f.document.entries[0], id: '99c79249-c065-498b-b5a1-980f083f209c', category: 'note' };
  f.document.entries.push(note); f.document.suppressed.push({ threadId: 'deleted-thread', messageId: 'deleted-message', identity: { subject: 'user', attribute: 'deleted' } });
  const pending = planMemoryUpgrade(f.document, project); assert.equal(pending.report.entries.at(-1).scope.projectId, project.id); assert.deepEqual(pending.report.unknown, [{ id: 'suppressed:0', category: 'suppressed' }]);
  const mapped = planMemoryUpgrade(f.document, project, [{ id: 'suppressed:0', scope: { kind: 'project', projectId: project.id } }]); assert.equal(mapped.after.suppressed[0].scope.projectId, project.id);
  f.document.library.documents[0].entryIds.push(f.document.entries[0].id); assert.throws(() => planMemoryUpgrade(f.document, project), /分块归属不一致/);
});

test('legacy validation rejects new/unknown fields and normalizes only old schema defaults', () => {
  const original = fixtureDocument(); delete original.entries[0].uncertain; delete original.excludedSources; delete original.progress[0].pending;
  const checked = validateLegacyV6MemoryDocument(original); assert.equal(checked.entries[0].uncertain, false); assert.deepEqual(checked.excludedSources, []); assert.deepEqual(checked.progress[0].pending, []);
  for (const change of [doc => { doc.unexpected = true; }, doc => { doc.entries[0].scope = { kind: 'workspace', projectId: 'forged' }; }, doc => { doc.progress[0].projectId = null; }, doc => { doc.importReceipts[0].projectId = null; }]) { const copy = fixtureDocument(); change(copy); assert.throws(() => validateLegacyV6MemoryDocument(copy)); }
});

test('held lock, symlink, hardlink, changed current bytes and corrupt backup fail without overwriting', async t => {
  const f = await fixture(t), lock = await tryAcquireFlock(`${f.memoryPath}.lock`); assert.ok(lock);
  try { await assert.rejects(f.cli('--upgrade'), /其他进程修改/); } finally { await lock.release(); }
  const alias = join(f.root, 'alias.json'); await symlink(f.memoryPath, alias); await assert.rejects(exec(process.execPath, [script, '--memory', alias, '--project', f.projectPath, '--upgrade'])); await rm(alias);
  await link(f.memoryPath, alias); await assert.rejects(f.cli('--upgrade'), /无硬链接/); await rm(alias);
  const receipt = JSON.parse((await f.cli('--upgrade')).stdout), upgraded = await readFile(f.memoryPath);
  await writeFile(f.memoryPath, Buffer.concat([upgraded, Buffer.from(' ')])); await assert.rejects(f.cli('--rollback', receipt.receiptPath), /记忆已变化/);
  await writeFile(f.memoryPath, upgraded); await writeFile(receipt.backupPath, 'corrupt'); await assert.rejects(f.cli('--rollback', receipt.receiptPath), /备份 SHA 不符/); assert.deepEqual(await readFile(f.memoryPath), upgraded);
});
