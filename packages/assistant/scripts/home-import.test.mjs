import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonlAgentStore } from '../../core/dist/index.js';
import { V6MemoryStore } from '../dist/memory-v6-store.js';
import { manifest } from './cm-step7-migrate.mjs';
import { convertImportConfig, importHome } from './home-import.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const stamp = '2026-10-23T01:00:00.000Z';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-home-import-'))), source = join(root, 'source'), home = join(root, 'H');
  const workspace = join(source, 'workspace'), directory = join(source, 'transcripts/t');
  await mkdir(join(workspace, '.runloom'), { recursive: true });
  await new JsonlAgentStore({ directory }).save('t', [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '先给结论。项目记录。' }] }]);
  const memory = new V6MemoryStore(join(workspace, '.runloom/memory.json'));
  assert.ok((await memory.writeV6([{ operation: 'add', text: '先给结论。', category: 'preference', source: { kind: 'conversation', threadId: 't', messageId: 'u', quote: '先给结论。', sentAt: null } },
    { operation: 'add', text: '项目记录。', category: 'document', source: { kind: 'manual' } }], undefined, { now: new Date(stamp) })).ok);
  const document = (await memory.readV6()).value;
  document.library.documents.push({ id: 'doc', title: '项目', folderId: null, entryIds: [document.entries[1].id], scope: { kind: 'workspace' } });
  await writeFile(join(workspace, '.runloom/memory.json'), encoded(document));
  await writeFile(join(source, 'config.json'), encoded({ version: 1, workspace, desktopAutonomy: { workspaceRoot: workspace },
    modules: { memory: { enabled: true, autoConsolidate: false, writePolicy: 'review', semantic: { enabled: false } }, shell: { enabled: true } } }));
  await mkdir(join(source, 'transcripts/no-commit'));
  await writeFile(join(source, 'transcripts/no-commit/execution-records.json'), encoded({version:1,runs:[]}));
  await writeFile(join(source, 'identity.json'), encoded({ version: 2, profiles: [{ configPath: join(source, 'runloom.json'), workspaceRoot: workspace,
    activeThreadId: 't', threads: [{ threadId: 't', transcriptDirectory: directory }, {threadId:'no-commit',transcriptDirectory:join(source,'transcripts/no-commit')}] }] }));
  await writeFile(join(source, 'conversation-drafts.json'), encoded({ version: 1, conversations: { oldKey: { scope: { workspaceRoot: workspace, directory, threadId: 't' }, draft: { text: '草稿', excludeFromMemory: false }, uncertainSteer: null } } }));
  await writeFile(join(source, 'private.env'), 'fake credential archive only');
  await symlink(join(root, 'never-read'), join(source, 'external-link'));
  const entries = await manifest(source);
  const specification = { version: 1, importedAt: stamp, manifest: entries, manifestSha256: sha(encoded(entries)), authorizedDirectories: [{ path: null, access: "readwrite" }],
    userEntryIds: document.entries.map(entry => entry.id), userDocumentIds: ['doc'] };
  return { root, source, home, specification };
}

test('dry-run, full private backup/rehearsal/rollback, cold read and exact replay preserve IDs, sources, bytes and scope mapping', async () => {
  const f = await fixture();
  try {
    const before = await manifest(f.source), preview = await importHome(f);
    assert.equal(preview.status, 'dry-run'); await assert.rejects(readFile(join(f.home, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.home + '.import', 'intent.json')), { code: 'ENOENT' });
    const result = await importHome({ ...f, execute: true }); assert.equal(result.status, 'passed');
    assert.ok(Object.values(result.rollback).every(value => value === true));
    assert.deepEqual(await manifest(f.source), before);
    assert.deepEqual(await manifest(join(f.home + '.import', 'backup')), before);
    assert.deepEqual(await manifest(join(f.home + '.import', 'rehearsal')), before);
    assert.equal(await readFile(join(f.home, 'data/memory.json'), 'utf8'), await readFile(join(f.source, 'workspace/.runloom/memory.json'), 'utf8'));
    assert.equal(result.documentScopes[0].scope, 'user'); assert.deepEqual(result.registeredWithoutTranscript, ['no-commit']); assert.equal(result.scopes.length, 2); assert.ok(result.scopes.every(item => item.scope === 'user' && item.disposition === '暂时在 user'));
    const config = JSON.parse(await readFile(join(f.home, 'config.json')));
    assert.equal(config.workspace, undefined); assert.equal(config.desktopAutonomy, undefined); assert.equal(config.modules.memory.writePolicy, undefined);
    assert.equal(config.modules.memory.autoConsolidate, false); assert.equal(config.modules.shell.enabled, false);
    const imported = await new V6MemoryStore(join(f.home, 'data/memory.json')).readV6(); assert.ok(imported.ok); assert.equal(imported.value.entries.length, 2);
    const identity = JSON.parse(await readFile(join(f.home, 'desktop/desktop-identity.json')));
    assert.equal(identity.profiles[0].activeThreadId, 't'); assert.equal(identity.profiles[0].threads[0].transcriptDirectory, join(f.home, 'transcripts/t'));
    const messages = await new JsonlAgentStore({ directory: identity.profiles[0].threads[0].transcriptDirectory }).getModelMessages('t'); assert.equal(messages[0].id, 'u');
    const targetBefore = await manifest(f.home); assert.equal((await importHome({ ...f, execute: true })).replay, true); assert.deepEqual(await manifest(f.home), targetBefore);
    await writeFile(join(f.home, 'data/memory.json'), '{}'); await assert.rejects(importHome({ ...f, execute: true }), /Target content changed/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('source drift and undeclared scope fail without creating a target', async () => {
  const f = await fixture();
  try {
    await assert.rejects(importHome({ ...f, specification: { ...f.specification, userEntryIds: [] } }), /explicit approved user mapping/);
    await writeFile(join(f.source, 'new-file'), 'changed');
    await assert.rejects(importHome({ ...f, execute: true }), /Source changed/);
    await assert.rejects(readFile(join(f.home, 'imports/receipt.json')), { code: 'ENOENT' });
    await assert.rejects(importHome({ ...f, home: resolve(process.env.HOME, '.serika') }), /Daily data/);
    const config = convertImportConfig({ version: 1, workspace: '/old', telegramAutonomy: { workspaceRoot: '/old' }, modules: { memory: { writePolicy: 'automatic', autoConsolidate: true } } }, { authorizedDirectory: '/explicit' });
    assert.equal(config.config.authorizedDirectories[0].path, '/explicit'); assert.equal(config.config.telegramAutonomy, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('every persisted interruption requires explicit recovery, never marks incomplete data successful, then replay is write-free', async () => {
  for (const phase of ['after-backup', 'after-rehearsal', 'after-data', 'before-publish', 'after-publish', 'before-receipt-rename', 'after-receipt-rename', 'after-receipt']) {
    const f = await fixture();
    try {
      await assert.rejects(importHome({ ...f, execute: true, boundary: point => { if (point === phase) throw new Error('simulated interruption'); } }), /simulated interruption/);
      if (!['after-receipt-rename', 'after-receipt'].includes(phase)) await assert.rejects(readFile(join(f.home, 'imports/receipt.json')), { code: 'ENOENT' });
      if (!['after-receipt-rename', 'after-receipt'].includes(phase)) await assert.rejects(importHome({ ...f, execute: true }), /explicitly recover/);
      assert.equal((await importHome({ ...f, execute: true, recover: true })).status, 'passed');
      const before = await manifest(f.home); assert.equal((await importHome({ ...f, execute: true })).replay, true); assert.deepEqual(await manifest(f.home), before);
      assert.deepEqual(await manifest(f.source), f.specification.manifest);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('CLI requires explicit home, defaults to dry-run and recovers an actual killed child only on explicit invocation', async () => {
  const f = await fixture();
  try {
    const plan = join(f.root, 'plan.json'); await writeFile(plan, encoded(f.specification));
    const script = new URL('./home-import.mjs', import.meta.url).pathname;
    const args = [script, '--source', f.source, '--home', f.home, '--manifest', plan];
    const dry = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH } }); assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).status, 'dry-run');
    const runner = join(f.root, 'crash.mjs');
    await writeFile(runner, `import {importHome} from ${JSON.stringify(new URL('./home-import.mjs', import.meta.url).href)};\nimport {readFile} from 'node:fs/promises';\nawait importHome({source:process.argv[2],home:process.argv[4],specification:JSON.parse(await readFile(process.argv[5])),execute:true,boundary:p=>{if(p==='after-publish')process.exit(73)}});`);
    const crash = spawnSync(process.execPath, [runner, f.source, '--home', f.home, plan], { encoding: 'utf8', env: { PATH: process.env.PATH } }); assert.equal(crash.status, 73, crash.stderr);
    const refused = spawnSync(process.execPath, [...args, '--execute'], { encoding: 'utf8' }); assert.equal(refused.status, 1);
    const recovered = spawnSync(process.execPath, [...args, '--execute', '--recover'], { encoding: 'utf8' }); assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).status, 'passed');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('cutover CLI admits only absent or empty default home under explicit flag; simulated HOME never reaches daily data', async () => {
  const f = await fixture();
  try {
    const plan = join(f.root, 'plan.json'); await writeFile(plan, encoded(f.specification));
    const script = new URL('./home-import.mjs', import.meta.url).pathname;
    for (const kind of ['absent', 'empty', 'hidden', 'symlink', 'dangling', 'file']) {
      const simulatedUser = join(f.root, kind); await mkdir(simulatedUser);
      const home = join(simulatedUser, '.serika');
      if (kind === 'empty' || kind === 'hidden') await mkdir(home);
      if (kind === 'hidden') await writeFile(join(home, '.sentinel'), 'preserve');
      if (kind === 'file') await writeFile(home, 'preserve');
      if (kind === 'symlink' || kind === 'dangling') await symlink(kind === 'symlink' ? f.source : join(f.root, 'missing'), home);
      const env = { PATH: process.env.PATH, HOME: simulatedUser };
      const args = [script, '--source', f.source, '--home', home, '--manifest', plan];
      const denied = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      assert.equal(denied.status, 1, kind);
      const result = spawnSync(process.execPath, [...args, '--cutover', '--execute'], { env, encoding: 'utf8' });
      const allowed = ['absent', 'empty'].includes(kind);
      assert.equal(result.status, allowed ? 0 : 1, kind + result.stderr);
      if (allowed) {
        assert.equal(JSON.parse(result.stdout).status, 'passed');
        const repeated = spawnSync(process.execPath, [...args, '--cutover', '--execute'], { env, encoding: 'utf8' });
        assert.equal(repeated.status, 1, 'Nonempty default home must be refused even for exact replay');
      }
      if (kind === 'hidden') assert.equal(await readFile(join(home, '.sentinel'), 'utf8'), 'preserve');
      const nested = spawnSync(process.execPath, [script, '--source', f.source, '--home', join(home, 'nested'), '--manifest', plan, '--cutover'], { env, encoding: 'utf8' });
      assert.equal(nested.status, 1);
      const sourceDenied = spawnSync(process.execPath, [script, '--source', home, '--home', f.home, '--manifest', plan, '--cutover'], { env, encoding: 'utf8' });
      assert.equal(sourceDenied.status, 1);
    }
    assert.deepEqual(await manifest(f.source), f.specification.manifest);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
