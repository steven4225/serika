import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const approvedIds = ['978a1257','0113bb19','ac6798c5','7436ddc8','9f80adf7','04df6c43','e8087dd4','c3b19d9b','41f1d455','671b1ca0','0a0f2df1','f6e52e58','8291bb0f','ba71d2c9'];
export const approvedSourceSha = '0a3b46794629c9b2ca9437f2d79321321c3bad2548d57a35271da5f97df629a8';
const keep = new Set([1, 9, 12]), documents = new Set([10, 11, 13]);
const titles = { 10: 'Serika 实验分支工作约定', 11: '历史开发约束与现行计划优先级', 13: 'automationRefresh / reconnecting 项目决策' };

export async function manifest(root) {
  const entries = [];
  async function walk(relative) {
    const path = join(root, relative), stat = await lstat(path);
    const item = { path: relative.split('\\').join('/'), mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) entries.push({ ...item, type: 'symlink', target: await readlink(path) });
    else if (stat.isDirectory()) { entries.push({ ...item, type: 'directory' }); for (const name of (await readdir(path)).sort()) await walk(join(relative, name)); }
    else { assert.ok(stat.isFile(), 'Unsupported backup file type'); const bytes = await readFile(path); entries.push({ ...item, type: 'file', bytes: bytes.length, sha256: sha(bytes) }); }
  }
  for (const name of (await readdir(root)).sort()) await walk(name);
  return entries;
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

// This is the approved fourteen-row decision, not a legacy-format inference engine.
export function migrateDocument(old, stamp) {
  assert.ok([4, 5].includes(old.version), 'Only the reviewed v4/v5 source is supported');
  assert.equal(old.entries.length, 14, 'Re-review a changed source before migrating');
  assert.deepEqual(old.entries.map(entry => entry.id.slice(0, 8)), approvedIds);
  const current = old.entries.map(entry => {
    const values = entry.assertions.filter(value => value.systemTime.to === null && value.state === 'asserted' &&
      (value.validTime.from === null || value.validTime.from <= stamp) && (value.validTime.to === null || value.validTime.to > stamp));
    assert.equal(values.length, 1, 'Each reviewed row must have one current assertion');
    assert.equal(entry.status, 'active'); assert.ok(!entry.expiresAt || entry.expiresAt > stamp);
    return values[0];
  });
  const entries = [], rows = [];
  for (let index = 0; index < old.entries.length; index++) {
    const number = index + 1, original = old.entries[index], assertion = current[index];
    const disposition = keep.has(number) ? 'preference' : documents.has(number) ? 'document' : 'discard';
    let text = assertion.text;
    if (number === 9) text += '（明确授权实施或测试时不适用）';
    if (number === 10) text = '项目仓库：github.com/steven4225/serika；工作分支：experiment/architecture-v2。用户要求不碰 main（只读可），直接提交不走 PR、不强推，每个提交推送，说明用 UTF-8。';
    if (number === 11) text += '\n这是历史约束记录；与现行 docs/context-memory-refactor-plan.md 冲突时，以现行计划为准。';
    const sources = assertion.sources.map(source => source.kind === 'conversation' ? { kind: 'conversation', threadId: source.threadId, messageId: source.messageId, quote: source.quote, sentAt: source.sentAt ?? null } : { kind: 'manual' });
    if (text !== assertion.text) sources.push({ kind: 'manual' });
    const result = { id: original.id, revision: original.revision, text, uncertain: false, category: disposition,
      identity: { subject: 'user', attribute: number === 1 ? '复盘格式' : number === 9 ? '只读代码时运行测试' : number === 12 ? '产品操作与配置' : '项目记录:' + original.id, value: text },
      scope: { kind: 'workspace' }, pinned: original.pinned, state: 'active', createdAt: original.createdAt, updatedAt: stamp,
      sources, replaces: [], supersededBy: null, withdrawal: null };
    if (disposition !== 'discard') entries.push(result);
    rows.push({ number, id: original.id, disposition, originalScope: original.scope, originalTextSha256: sha(assertion.text),
      ...(disposition === 'discard' ? {} : { textSha256: sha(text), category: disposition, sourceCount: sources.length, identity: { subject: result.identity.subject, attribute: result.identity.attribute }, pinned: result.pinned }) });
  }
  const library = structuredClone(old.library ?? { revision: 0, folders: [], documents: [] });
  // This source's approved disposition covers every body. Unknown library ownership fails closed.
  for (const document of library.documents) {
    assert.equal(document.scope.kind, 'workspace', 'Thread documents require explicit review');
    assert.ok(document.entryIds.every(id => entries.some(entry => entry.id === id)), 'Document points at a discarded row');
  }
  for (const number of documents) {
    const entry = entries.find(item => item.id === old.entries[number - 1].id);
    if (!library.documents.some(document => document.entryIds.includes(entry.id))) library.documents.push({ id: 'cm7-project-' + entry.id,
      title: titles[number], folderId: null, entryIds: [entry.id], scope: { kind: 'workspace' } });
  }
  library.revision++;
  return { document: { version: 6, lastWrittenAt: stamp, entries, excludedSources: [], progress: [], suppressed: [], library, importReceipts: [] }, rows,
    legacy: { version: old.version, entries: old.entries.length, assertions: old.entries.reduce((sum, entry) => sum + entry.assertions.length, 0),
      candidates: old.candidates?.length ?? 0, pendingCandidates: old.candidates?.filter(item => item.status === 'pending').length ?? 0,
      cursors: old.consolidationCursors?.length ?? 0, receipts: old.consolidationReceipts?.length ?? 0 },
    archivedOnly: ['assertion history', 'administrative versions', 'legacy candidates', 'legacy coverage receipts'] };
}

// Full entries stay in private review artifacts; stdout contains counts and status only.
export function memoryDelta(baselineBytes, sourceBytes, expectedSha = approvedSourceSha) {
  assert.equal(sha(baselineBytes), expectedSha, 'Reviewed baseline SHA mismatch');
  const baseline = JSON.parse(baselineBytes), source = JSON.parse(sourceBytes);
  assert.ok([4, 5].includes(source.version), 'Only v4/v5 source is supported');
  const index = document => {
    const result = new Map(document.entries.map(entry => [entry.id, entry]));
    assert.equal(result.size, document.entries.length, 'Duplicate memory IDs');
    return result;
  };
  const before = index(baseline), after = index(source), changes = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(id) ?? null, current = after.get(id) ?? null;
    if (JSON.stringify(previous) !== JSON.stringify(current)) changes.push({ id,
      change: previous === null ? 'added' : current === null ? 'deleted' : 'modified',
      before: previous, after: current, decision: null });
  }
  const metadata = document => Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'entries'));
  const metadataChanged = JSON.stringify(metadata(baseline)) !== JSON.stringify(metadata(source));
  return { version: 1, baselineSha256: expectedSha, sourceSha256: sha(sourceBytes), changes,
    metadata: { before: metadata(baseline), after: metadata(source), changed: metadataChanged },
    metadataDecision: metadataChanged ? null : 'accept-current' };
}

function applyMemoryDecisions(original, stamp, review, decisions) {
  const expected = { ...review, metadataDecision: decisions.metadataDecision,
    changes: review.changes.map((row, index) => ({ ...row, decision: decisions.changes?.[index]?.decision })) };
  assert.deepEqual(decisions, expected, 'Decision file differs from the exact baseline/source delta');
  assert.equal(decisions.metadataDecision, 'accept-current', 'Review current metadata before migrating');
  const result = migrateDocument(original, stamp), entries = new Map(result.document.entries.map(entry => [entry.id, entry]));
  for (const row of decisions.changes) {
    const decision = row.decision;
    assert.ok(decision && ['keep-reviewed', 'discard', 'accept-current'].includes(decision.action), 'Every delta row needs an explicit decision');
    if (decision.action === 'keep-reviewed') {
      assert.ok(row.before, 'New rows have no reviewed version');
      assert.deepEqual(decision, { action: 'keep-reviewed' });
    } else if (decision.action === 'discard') {
      assert.deepEqual(decision, { action: 'discard' }); entries.delete(row.id);
    } else {
      assert.ok(row.after, 'Deleted rows have no current version');
      assert.ok(['preference', 'note', 'document'].includes(decision.category), 'Explicit delta category required');
      assert.deepEqual(decision, { action: 'accept-current', category: decision.category });
      const reviewedRow = result.rows.find(item => item.id === row.id);
      if (reviewedRow) assert.equal(decision.category, reviewedRow.disposition, 'Original fourteen-row disposition cannot change');
      const entry = row.after;
      const values = entry.assertions.filter(value => value.systemTime.to === null && value.state === 'asserted' &&
        (value.validTime.from === null || value.validTime.from <= stamp) && (value.validTime.to === null || value.validTime.to > stamp));
      assert.equal(values.length, 1, 'Accepted delta needs one current assertion');
      assert.equal(entry.status, 'active'); assert.ok(!entry.expiresAt || entry.expiresAt > stamp);
      const assertion = values[0];
      entries.set(row.id, { id: entry.id, revision: entry.revision, text: assertion.text, uncertain: false, category: decision.category,
        identity: { subject: 'user', attribute: entries.get(row.id)?.identity.attribute ?? '增量记录:' + entry.id, value: assertion.text }, scope: { kind: 'workspace' }, pinned: entry.pinned,
        state: 'active', createdAt: entry.createdAt, updatedAt: stamp,
        sources: assertion.sources.map(source => source.kind === 'conversation' ? { kind: 'conversation', threadId: source.threadId,
          messageId: source.messageId, quote: source.quote, sentAt: source.sentAt ?? null } : { kind: 'manual' }),
        replaces: [], supersededBy: null, withdrawal: null });
    }
  }
  result.document.entries = [...entries.values()];
  result.document.library.documents = result.document.library.documents.map(document => ({ ...document,
    entryIds: document.entryIds.filter(id => entries.has(id)) })).filter(document => document.entryIds.length > 0);
  for (const entry of entries.values()) if (entry.category === 'document' && !result.document.library.documents.some(document => document.entryIds.includes(entry.id)))
    result.document.library.documents.push({ id: 'cm7-delta-' + entry.id, title: entry.text.split('\n')[0], folderId: null,
      entryIds: [entry.id], scope: { kind: 'workspace' } });
  result.delta = { baselineSha256: review.baselineSha256, sourceSha256: review.sourceSha256,
    decisionsSha256: sha(JSON.stringify(decisions)), metadataDecision: decisions.metadataDecision,
    changes: decisions.changes.map(({ id, change, decision }) => ({ id, change, decision })) };
  return result;
}

export async function migrateCopy(root, { expectedSha = approvedSourceSha, stamp = new Date().toISOString(), reviewedBytes, decisions } = {}) {
  for (const relative of ['', 'workspace', 'workspace/.runloom', 'workspace/.runloom/memory.json']) {
    assert.equal((await lstat(join(root, relative))).isSymbolicLink(), false, 'Migration target cannot contain a symbolic link');
  }
  const file = join(root, 'workspace/.runloom/memory.json'), bytes = await readFile(file);
  const original = JSON.parse(bytes);
  const review = reviewedBytes && memoryDelta(reviewedBytes, bytes, expectedSha);
  if (!review) assert.equal(sha(bytes), expectedSha, 'Source SHA differs from reviewed source');
  const before = await manifest(root);
  const migrated = review && review.sourceSha256 !== expectedSha
    ? applyMemoryDecisions(JSON.parse(reviewedBytes), stamp, review, decisions) : migrateDocument(original, stamp);
  if (migrated.delta) {
    migrated.legacy = { version: original.version, entries: original.entries.length,
      assertions: original.entries.reduce((sum, entry) => sum + entry.assertions.length, 0), candidates: original.candidates?.length ?? 0,
      pendingCandidates: original.candidates?.filter(item => item.status === 'pending').length ?? 0,
      cursors: original.consolidationCursors?.length ?? 0, receipts: original.consolidationReceipts?.length ?? 0 };
    const library = original.library ?? { revision: 0, folders: [], documents: [] };
    for (const document of library.documents) {
      assert.equal(document.scope.kind, 'workspace', 'Thread documents require explicit review');
      assert.ok(document.entryIds.every(id => migrated.document.entries.some(entry => entry.id === id)), 'Current library points at a discarded row');
    }
    migrated.document.library = { ...structuredClone(library), revision: library.revision + 1, documents: [
      ...structuredClone(library.documents), ...migrated.document.library.documents.filter(document => !library.documents.some(item => item.id === document.id))] };
  }
  const { validateV6MemoryDocument, V6MemoryStore } = await import('../dist/memory-v6-store.js');
  validateV6MemoryDocument(migrated.document);
  // Legacy deletion/exclusion controls cannot silently disappear or regain authority.
  const privateTranscript = join(root, 'transcripts');
  const { JsonlAgentStore, hashCanonicalJson } = await import('../../core/dist/index.js');
  const { userStartedTurns, isAutoConsolidationRequest } = await import('../dist/consolidation.js');
  const threads = [], verifiedSources = new Set();
  for (const name of (await readdir(privateTranscript)).sort()) {
    const directory = join(privateTranscript, name); if (!(await lstat(directory)).isDirectory()) continue;
    const store = new JsonlAgentStore({ directory });
    const messages = await store.getModelMessages(name);
    for (const entry of migrated.document.entries) for (const source of entry.sources) if (source.kind === 'conversation' && source.threadId === name) {
      const message = messages.find(item => item.id === source.messageId);
      assert.ok(message, 'Retained memory source must remain readable after exclusions');
      assert.equal(message.role, 'user');
      assert.ok(message.parts.some(part => part.type === 'text' && part.text.includes(source.quote)), 'Retained source quote differs from transcript');
      source.sentAt = message.metadata?.receivedAt ?? message.metadata?.sentAt ?? null;
      verifiedSources.add(source.threadId + ':' + source.messageId + ':' + source.quote);
    }
    const cursor = original.consolidationCursors?.find(item => item.threadId === name);
    if (cursor) {
      const index = messages.findIndex(message => message.id === cursor.throughMessageId);
      assert.ok(index >= 0, 'Legacy extraction boundary is unavailable');
      const users = userStartedTurns(messages).map(turn => turn[0]).filter(user => !isAutoConsolidationRequest(user));
      const boundary = users.findIndex(user => user.id === cursor.throughMessageId);
      assert.ok(boundary >= 0, 'Legacy cursor must bind an ordinary user');
      assert.equal(cursor.prefixHash, sha(JSON.stringify(['runloom-consolidation-prefix/v1', users.slice(0, boundary + 1).map(user =>
        [user.id, user.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')])])), 'Legacy cursor prefix changed');
      migrated.document.progress.push({ threadId: name, throughMessageId: cursor.throughMessageId,
        prefixHash: hashCanonicalJson(JSON.parse(JSON.stringify(messages.slice(0, index + 1)))), pending: [], retry: null });
    }
    migrated.document.excludedSources.push(...(await store.getTranscriptExclusions(name)).map(item => ({ threadId: name, messageId: item.messageId })));
    threads.push({ threadId: name, messages: messages.length, compactions: (await store.getContextCompactions(name)).length });
  }
  for (const entry of migrated.document.entries) for (const source of entry.sources) if (source.kind === 'conversation') {
    assert.ok(verifiedSources.has(source.threadId + ':' + source.messageId + ':' + source.quote), 'Retained source Thread is missing');
  }
  assert.equal(migrated.document.progress.length, original.consolidationCursors?.length ?? 0);
  validateV6MemoryDocument(migrated.document);
  const originalBackup = file + '.pre-v6';
  await writeFile(originalBackup, bytes, { flag: 'wx', mode: 0o400 });
  const temporary = file + '.cm7-' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(migrated.document) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  const store = new V6MemoryStore(join(join(root, 'workspace'), ".runloom/memory.json")), read = await store.readV6();
  assert.ok(read.ok); assert.deepEqual(read.value, validateV6MemoryDocument(migrated.document));
  assert.equal(read.value.library.documents.length, migrated.document.library.documents.length);
  assert.deepEqual(read.value.library.folders, original.library?.folders ?? []);
  assert.deepEqual(read.value.library.documents.slice(0, original.library?.documents.length ?? 0), original.library?.documents ?? []);
  const after = await manifest(root);
  assert.deepEqual(after.filter(item => !['workspace/.runloom/memory.json','workspace/.runloom/memory.json.pre-v6'].includes(item.path)),
    before.filter(item => item.path !== 'workspace/.runloom/memory.json'), 'Only memory format and its retained old file may change');
  return { migratedAt: stamp, oldSha256: sha(bytes), newSha256: sha(await readFile(file)), rows: migrated.rows, legacy: migrated.legacy,
    archivedOnly: migrated.archivedOnly, entries: read.value.entries.length, preferences: read.value.entries.filter(entry => entry.category === 'preference').length,
    projectDocuments: read.value.entries.filter(entry => entry.category === 'document').length, delta: migrated.delta ?? null,
    originalLibrary: original.library ?? null, threads, beforeManifestSha256: sha(JSON.stringify(before)), afterManifestSha256: sha(JSON.stringify(after)) };
}

async function logicalCounts(root) {
  const memory = await json(join(root, 'workspace/.runloom/memory.json'));
  return { version: memory.version, entries: memory.entries.length, assertions: memory.entries.reduce((sum, entry) => sum + (entry.assertions?.length ?? 0), 0),
    candidates: memory.candidates?.length ?? 0, cursors: memory.consolidationCursors?.length ?? 0, receipts: memory.consolidationReceipts?.length ?? 0,
    libraryFolders: memory.library?.folders.length ?? 0, libraryDocuments: memory.library?.documents.length ?? 0,
    transcriptFiles: (await manifest(join(root, 'transcripts'))).filter(item => item.type === 'file').length };
}

export async function runMigration({ source, output, expectedSha = approvedSourceSha, reviewedMemory, reviewDirectory, decisionsFile }) {
  source = resolve(source); output = resolve(output);
  assert.ok(output !== source && !output.startsWith(source + '/'), 'Output must be isolated');
  const configBefore = await json(join(source, 'runloom.json'));
  const sourceBytes = await readFile(join(configBefore.workspace, '.runloom/memory.json'));
  let reviewedBytes, decisions;
  if (sha(sourceBytes) !== expectedSha) {
    assert.ok(reviewedMemory && reviewDirectory, 'Changed memory requires a private reviewed baseline and review directory');
    reviewedBytes = await readFile(reviewedMemory);
    const review = memoryDelta(reviewedBytes, sourceBytes, expectedSha);
    let privateDirectory = resolve(reviewDirectory);
    const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    assert.ok(privateDirectory !== checkout && !privateDirectory.startsWith(checkout + '/'), 'Memory review must stay outside the repository');
    assert.ok(privateDirectory !== output && !privateDirectory.startsWith(output + '/'), 'Review directory must be separate from migration output');
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    assert.equal((await lstat(privateDirectory)).isSymbolicLink(), false, 'Review directory cannot be a symlink');
    privateDirectory = await realpath(privateDirectory);
    assert.ok(privateDirectory !== checkout && !privateDirectory.startsWith(checkout + '/'), 'Memory review must stay outside the repository');
    for (let ancestor = privateDirectory; ; ancestor = dirname(ancestor)) {
      try { await lstat(join(ancestor, '.git')); assert.fail('Memory review must stay outside every repository'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ancestor === dirname(ancestor)) break;
    }
    await chmod(privateDirectory, 0o700);
    const template = join(privateDirectory, 'memory-delta-' + review.sourceSha256 + '.json');
    try { await writeFile(template, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(template); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Template must be a regular private file');
      await chmod(template, 0o600); assert.deepEqual(await json(template), review, 'Preserve template; put decisions in a separate file');
    }
    if (!decisionsFile) return { status: 'awaiting-memory-decisions', reviewFile: template,
      changes: Object.fromEntries(['added', 'modified', 'deleted'].map(kind => [kind, review.changes.filter(row => row.change === kind).length])) };
    decisions = await json(decisionsFile);
    applyMemoryDecisions(JSON.parse(reviewedBytes), new Date().toISOString(), review, decisions);
  } else assert.ok(!decisionsFile, 'No delta decisions apply to an unchanged source');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const staging = join(output, 'snapshot'), backup = join(output, 'backup.tar');
  const config = await json(join(source, 'runloom.json')), identity = await json(join(source, 'desktop-identity.json'));
  assert.equal(identity.profiles.length, 1, 'Review additional profiles explicitly');
  const profile = identity.profiles[0];
  assert.equal(profile.workspaceRoot, config.workspace);
  assert.equal(resolve(profile.configPath), join(source, 'runloom.json'));
  for (const thread of profile.threads) assert.ok(resolve(thread.transcriptDirectory).startsWith(join(source, 'transcripts/')));
  const paths = [['workspace', config.workspace], ['transcripts', join(source, 'transcripts')], ['config.json', join(source, 'runloom.json')],
    ['identity.json', join(source, 'desktop-identity.json')], ['conversation-drafts.json', join(source, 'conversation-drafts.json')]];
  const sourceManifest = async () => {
    const result = [];
    for (const [label, path] of paths) { const stat = await lstat(path); result.push({ path: label, type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o7777,
      ...(stat.isFile() ? { bytes: stat.size, sha256: sha(await readFile(path)) } : {}) });
      if (stat.isDirectory()) result.push(...(await manifest(path)).map(item => ({ ...item, path: label + '/' + item.path }))); }
    return result.sort((a,b) => a.path.localeCompare(b.path, 'en'));
  };
  const before = await sourceManifest();
  await mkdir(staging, { mode: 0o700 });
  for (const [label, path] of paths) await cp(path, join(staging, label), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  assert.deepEqual(await sourceManifest(), before, 'Source changed while copying; discard snapshot and retry');
  const captured = (await manifest(staging)).sort((a,b) => a.path.localeCompare(b.path, 'en'));
  assert.deepEqual(captured, before, 'Backup must match source file set, hashes and modes');
  await writeJson(join(output, 'backup-manifest.json'), captured);
  const counts = await logicalCounts(staging);
  execFileSync('tar', ['-cf', backup, '-C', staging, '.']); await chmod(backup, 0o400);
  await rm(staging, { recursive: true });
  const restore = async target => { await rm(target, { recursive: true, force: true }); await mkdir(target, { mode: 0o700 }); execFileSync('tar', ['-xf', backup, '-C', target]); };
  const a = join(output, 'rehearsal'), b = join(output, 'rollback-control');
  await restore(a); await restore(b);
  const rehearsal = await migrateCopy(a, { expectedSha, reviewedBytes, decisions });
  await writeJson(join(output, 'rehearsal-migrated-manifest.json'), await manifest(a));
  await restore(a);
  assert.deepEqual(await manifest(a), await manifest(b));
  assert.deepEqual((await manifest(a)).sort((x,y) => x.path.localeCompare(y.path, 'en')), captured);
  assert.deepEqual(await logicalCounts(a), counts); assert.deepEqual(await logicalCounts(b), counts);
  await writeJson(join(output, 'rollback-manifest.json'), await manifest(a));
  const target = join(output, 'v6-review'); await restore(target);
  const realData = await migrateCopy(target, { expectedSha, reviewedBytes, decisions });
  const latest = await sourceManifest();
  const sourceChanges = latest.filter(item => JSON.stringify(item) !== JSON.stringify(before.find(old => old.path === item.path))).map(item => item.path);
  sourceChanges.push(...before.filter(item => !latest.some(current => current.path === item.path)).map(item => item.path));
  assert.ok(sourceChanges.every(path => path === 'workspace/.runloom/task-worker-health.json'), 'Daily business data changed after snapshot; review before using this copy');
  await writeJson(join(output, 'migrated-manifest.json'), await manifest(target));
  const report = { runId: randomUUID(), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), status: 'passed', realModelCalls: 0, dailySourceWritten: false, sourceVersion: counts.version,
    backup: { file: 'backup.tar', sha256: sha(await readFile(backup)), manifest: 'backup-manifest.json', manifestSha256: sha(await readFile(join(output, 'backup-manifest.json'))),
      files: captured.filter(item => item.type === 'file').length, entries: captured.length, counts },
    rehearsal, rollback: { fileSetEqual: true, sha256Equal: true, modesEqual: true, logicalCountsEqual: true, counts }, realData,
    sourceChangesDuringRehearsal: sourceChanges, migratedWorkspace: 'v6-review/workspace', applicationStarted: false, configurationActivated: false };
  await writeJson(join(output, 'result.json'), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index++) {
      assert.ok(['--source', '--output', '--home', '--reviewed-memory', '--review-directory', '--decisions'].includes(args[index]), 'Unknown argument');
      assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), 'Missing argument');
      options[args[index].slice(2)] = args[++index];
    }
    assert.ok(options.source && options.output && options.home, 'Explicit --source, --output and --home required');
    const report = await runMigration({ source: options.source, output: options.output,
      reviewedMemory: options['reviewed-memory'], reviewDirectory: options['review-directory'], decisionsFile: options.decisions });
    console.log(JSON.stringify({ status: report.status, changes: report.changes, runId: report.runId, sourceVersion: report.sourceVersion,
      backupFiles: report.backup?.files, preferences: report.realData?.preferences, projectDocuments: report.realData?.projectDocuments, realModelCalls: 0 }));
    if (report.status !== 'passed') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof SyntaxError ? 'INVALID_JSON' : error instanceof assert.AssertionError ? 'MIGRATION_CHECK_FAILED' : 'MIGRATION_IO_FAILED' }));
    process.exitCode = 1;
  }
}
