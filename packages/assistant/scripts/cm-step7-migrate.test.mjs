import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { JsonlAgentStore } from '../../core/dist/index.js';
import { approvedIds, migrateCopy, migrateDocument, runMigration } from './cm-step7-migrate.mjs';

const stamp = '2026-10-22T08:00:00.000Z';
const legacy = () => ({ version: 4, lastWrittenAt: stamp, entries: approvedIds.map((id, index) => ({ id: id + '-fixture', revision: 1,
  scope: [4, 5, 6, 7].includes(index) ? { kind: 'thread', threadId: 't' } : { kind: 'workspace' }, pinned: index === 0, status: 'active', expiresAt: null,
  createdAt: stamp, updatedAt: stamp, assertions: [{ assertionId: 'a-' + index, text: index === 8 ? '只读代码不运行测试' : '测试原文' + index, kind: 'preference',
    state: 'asserted', validTime: { from: null, to: null }, systemTime: { from: stamp, to: null },
    sources: [{ kind: 'conversation', threadId: 't', messageId: 'u-' + index, quote: '测试原文' + index }] }], versions: [] })),
  candidates: [{ status: 'pending' }], consolidationCursors: [{ threadId: 't', throughMessageId: 'u-13', prefixHash: 'old-protocol' }], consolidationReceipts: [] });

test('reviewed migration retains decisions and metadata, rejects source drift and historical-only rows', () => {
  const old = legacy();
  old.library = { revision: 7, folders: [{ id: 'folder', name: '资料' }], documents: [{ id: 'existing', title: '原文档', folderId: 'folder', entryIds: [old.entries[9].id], scope: { kind: 'workspace' } }] };
  const result = migrateDocument(old, stamp);
  assert.equal(result.document.entries.length, 6);
  assert.equal(result.rows.filter(item => item.disposition === 'discard').length, 8);
  assert.equal(result.document.entries[0].pinned, true);
  assert.ok(result.document.entries.find(item => item.id.startsWith('41f1d455')).text.endsWith('（明确授权实施或测试时不适用）'));
  assert.deepEqual(result.document.library.folders, old.library.folders);
  assert.deepEqual(result.document.library.documents[0], old.library.documents[0]);
  assert.equal(result.document.library.documents.length, 3);
  const changed = legacy(); changed.entries[0].assertions[0].systemTime.to = stamp;
  assert.throws(() => migrateDocument(changed, stamp), /one current assertion/);
});

test('real JSONL source validation, complete tar rollback and a separate migrated copy preserve bytes and counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm7-migration-'));
  try {
    const source = join(root, 'source'), workspace = join(source, 'workspaces/personal'), directory = join(source, 'transcripts/t');
    await mkdir(join(workspace, '.runloom'), { recursive: true }); await mkdir(directory, { recursive: true });
    const original = legacy();
    original.consolidationCursors[0].prefixHash = createHash('sha256').update(JSON.stringify(['runloom-consolidation-prefix/v1', approvedIds.map((_, index) => ['u-' + index, '测试原文' + index])])).digest('hex');
    const bytes = JSON.stringify(original);
    await writeFile(join(workspace, '.runloom/memory.json'), bytes);
    await writeFile(join(source, 'runloom.json'), JSON.stringify({ workspace }));
    await writeFile(join(source, 'desktop-identity.json'), JSON.stringify({ profiles: [{ workspaceRoot: workspace, configPath: join(source, 'runloom.json'), threads: [{ threadId: 't', transcriptDirectory: directory }] }] }));
    await writeFile(join(source, 'conversation-drafts.json'), '{}');
    const store = new JsonlAgentStore({ directory });
    await store.save('t', approvedIds.map((_, index) => ({ id: 'u-' + index, role: 'user', parts: [{ type: 'text', text: '测试原文' + index }], metadata: { sentAt: stamp } })));
    const result = await runMigration({ source, output: join(root, 'review'), expectedSha: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(result.status, 'passed'); assert.deepEqual(result.rollback.counts, result.backup.counts);
    assert.equal(result.realData.preferences, 3); assert.equal(result.realData.projectDocuments, 3);
    assert.equal(await readFile(join(workspace, '.runloom/memory.json'), 'utf8'), bytes);
    const migrated = JSON.parse(await readFile(join(root, 'review/v6-review/workspace/.runloom/memory.json'), 'utf8'));
    assert.equal(migrated.progress[0].throughMessageId, 'u-13'); assert.notEqual(migrated.progress[0].prefixHash, 'old-protocol');
    assert.ok(migrated.entries.every(entry => entry.scope.kind === 'workspace' && entry.sources.some(source => source.threadId === 't')));
    assert.equal(result.realData.legacy.pendingCandidates, 1);
    const rehearsal = join(root, 'review/rehearsal');
    const tampered = structuredClone(original); tampered.consolidationCursors[0].prefixHash = 'invalid-old-prefix';
    const tamperedBytes = JSON.stringify(tampered);
    await writeFile(join(rehearsal, 'workspace/.runloom/memory.json'), tamperedBytes);
    await assert.rejects(migrateCopy(rehearsal, { expectedSha: createHash('sha256').update(tamperedBytes).digest('hex'), stamp }), /Legacy cursor prefix changed/);
    assert.equal(await readFile(join(rehearsal, 'workspace/.runloom/memory.json'), 'utf8'), tamperedBytes);
    await assert.rejects(readFile(join(rehearsal, 'workspace/.runloom/memory.json.pre-v6')), { code: 'ENOENT' });
    const linked = join(root, 'linked-copy'); await mkdir(join(linked, 'workspace'), { recursive: true });
    await symlink(join(workspace, '.runloom'), join(linked, 'workspace/.runloom'), 'dir');
    await assert.rejects(migrateCopy(linked), /Migration target cannot contain a symbolic link/);
    assert.equal(await readFile(join(workspace, '.runloom/memory.json'), 'utf8'), bytes);
    assert.deepEqual(await readdir(join(workspace, '.runloom')), ['memory.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
