import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifest } from './cm-step7-migrate.mjs';
import { readThreadTranscript } from '../../core/dist/index.js';
import { validateV6MemoryDocument, validateTaskDocument, restoreTaskDocument, validateWorkTaskDocument,
  validateCheckpointDocument, validateDreamingDocument, validateRssDocument, validateExecutionRunRecord } from '../dist/api.js';
import { RecipeStore } from '../dist/recipe-store.js';
import { resolveTuiModuleConfig } from '../dist/tui-module-config.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const within = (root, path) => path === root || path.startsWith(root + sep);
const safeRelative = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).some(part => part === '..' || part === '.');
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function sync(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await sync(dirname(path));
}
function guardPath(path) {
  for (const daily of [join(homedir(), '.serika'), join(homedir(), 'Library/Application Support/@aisdk-agent/desktop'), join(homedir(), '.config/@aisdk-agent/desktop')])
    assert.ok(!within(daily, path), 'Daily data is outside the offline importer boundary');
}

export function convertImportConfig(original, { authorizedDirectory = null } = {}) {
  const config = structuredClone(original), changes = [];
  const remove = (object, key, field) => { if (object && key in object) { delete object[key]; changes.push({ field, action: 'archived-only' }); } };
  remove(config, 'workspace', 'workspace -> authorizedDirectory');
  remove(config, 'authorizedDirectory', 'previous authorizedDirectory');
  if (authorizedDirectory !== null) config.authorizedDirectory = authorizedDirectory;
  for (const field of ['desktopAutonomy', 'telegramAutonomy', 'fileAuthorizations', 'automation', 'herdrBinding']) remove(config, field, field);
  const memory = config.modules?.memory;
  for (const field of ['writePolicy', 'queryRewrite', 'semantic', 'contextView']) remove(memory, field, 'modules.memory.' + field);
  for (const field of ['mode', 'warningRatio']) remove(config.contextCompaction, field, 'contextCompaction.' + field);
  for (const id of ['shell', 'computer', ...(authorizedDirectory === null ? ['read-file', 'checkpoint'] : [])]) {
    if (config.modules?.[id]) { config.modules[id] = { enabled: false }; changes.push({ field: 'modules.' + id, action: 'disabled-until-explicit-configuration' }); }
  }
  return { config, changes, authority: 'old grants, service configuration and execution permission remain archived' };
}

const validators = { 'memory.json': validateV6MemoryDocument, 'tasks.json': validateTaskDocument,
  'work-tasks.json': validateWorkTaskDocument, 'checkpoint.json': validateCheckpointDocument,
  'dreaming.json': validateDreamingDocument, 'rss.json': validateRssDocument };
async function inspect(root) {
  const files = await manifest(root), counts = { stores: {}, threads: 0, messages: 0, transcriptFiles: 0, executionRuns: 0 };
  const messages = new Map();
  assert.ok(files.some(item => item.path === 'workspace/.runloom/memory.json' && item.type === 'file'), 'Current v6 memory must be a regular file');
  for (const item of files.filter(item => item.type === 'file')) {
    const name = basename(item.path);
    if (item.path.startsWith('workspace/.runloom/') && name in validators) {
      const doc = validators[name](await json(join(root, item.path)));
      counts.stores[name] = { version: doc.version, ...Object.fromEntries(Object.entries(doc).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) };
      if (name === 'memory.json') counts.memory = { categories: Object.fromEntries(['preference', 'note', 'document'].map(category => [category, doc.entries.filter(entry => entry.category === category).length])),
        folders: doc.library.folders.length, documents: doc.library.documents.length, receipts: doc.importReceipts.length };
    }
    if (/^[a-f0-9]{64}\.jsonl$/.test(name)) {
      const bytes = await readFile(join(root, item.path), 'utf8'), first = JSON.parse(bytes.split('\n').find(Boolean));
      assert.equal(name, sha(first.threadId) + '.jsonl', 'Transcript filename/Thread mismatch');
      const transcript = await readThreadTranscript(join(root, item.path), first.threadId, { companions: true });
      assert.ok(!messages.has(first.threadId), 'Duplicate Thread transcript requires explicit reconciliation');
      messages.set(first.threadId, transcript.messages); counts.transcriptFiles++; counts.messages += transcript.messages.length;
    }
    if (name === 'execution-records.json') {
      const record = await json(join(root, item.path)); assert.equal(record.version, 1);
      record.runs.forEach(validateExecutionRunRecord); counts.executionRuns += record.runs.length;
    }
  }
  counts.threads = messages.size;
  if (files.some(item => item.path === 'workspace/.runloom/recipes.json')) {
    const recipes = await new RecipeStore(join(root, 'workspace'), join(root, 'workspace/.runloom/recipes.json')).list(new AbortController().signal);
    counts.stores['recipes.json'] = { version: 1, recipes: recipes.length };
  }
  const memory = validateV6MemoryDocument(await json(join(root, 'workspace/.runloom/memory.json')));
  for (const entry of memory.entries) for (const source of entry.sources) if (source.kind === 'conversation') {
    const message = messages.get(source.threadId)?.find(item => item.id === source.messageId);
    assert.ok(message?.role === 'user' && message.parts.some(part => part.type === 'text' && part.text.includes(source.quote)), 'Memory source/Thread/quote mismatch');
    if (source.proposal) assert.ok(messages.get(source.threadId)?.some(item => item.id === source.proposal.messageId && item.role === 'assistant'), 'Proposal source missing');
  }
  for (const progress of memory.progress) assert.ok(messages.get(progress.threadId)?.some(item => item.id === progress.throughMessageId) || progress.throughMessageId === null, 'Extraction progress Thread/message missing');
  return { files, counts, memory };
}

async function buildTarget(source, home, spec, inspection) {
  const files = new Map(), mappings = [];
  const add = (path, bytes, from, operation) => { assert.ok(!files.has(path), 'Conflicting target mapping'); files.set(path, bytes); mappings.push({ from, to: path, operation }); };
  for (const path of ['config.json', 'identity.json']) assert.ok(inspection.files.some(item => item.path === path && item.type === 'file'), 'Declared configuration and identity must be regular files');
  if ((inspection.counts.stores['work-tasks.json']?.tasks ?? 0) > 0) assert.ok(spec.authorizedDirectory, 'WorkTask reconciliation requires an explicit authorized directory mapping');
  const original = await json(join(source, 'config.json'));
  const converted = convertImportConfig(original, { authorizedDirectory: spec.authorizedDirectory ?? null });
  add('config.json', encoded(converted.config), 'config.json', 'configuration-fields');
  const identity = await json(join(source, 'identity.json'));
  assert.equal(identity.version, 2); assert.equal(identity.profiles.length, 1, 'Additional profiles need a declared mapping');
  const profile = identity.profiles[0], oldProfileRoot = dirname(profile.configPath);
  const mapTranscript = directory => { const path = relative(oldProfileRoot, directory); assert.ok(safeRelative(path) && path.startsWith('transcripts/'), 'Transcript directory outside declared snapshot'); return join(home, path); };
  const registeredWithoutTranscript = [];
  for (const thread of profile.threads) {
    const path = relative(home, mapTranscript(thread.transcriptDirectory));
    assert.ok(inspection.files.some(item => item.path === path && item.type === 'directory'), 'Registered Thread directory missing');
    if (!inspection.files.some(item => item.path === path + '/' + sha(thread.threadId) + '.jsonl')) registeredWithoutTranscript.push(thread.threadId);
  }
  const mappedProfile = { ...profile, configPath: join(home, 'config.json'), workspaceRoot: converted.config.authorizedDirectory ?? null,
    threads: profile.threads.map(thread => ({ ...thread, transcriptDirectory: mapTranscript(thread.transcriptDirectory) })) };
  add('desktop/desktop-identity.json', encoded({ ...identity, profiles: [mappedProfile] }), 'identity.json', 'preserve-thread-ids-remap-paths');
  if (inspection.files.some(item => item.path === 'conversation-drafts.json')) {
    const drafts = await json(join(source, 'conversation-drafts.json')), conversations = {};
    for (const draft of Object.values(drafts.conversations)) {
      const scope = { ...draft.scope, workspaceRoot: mappedProfile.workspaceRoot, directory: mapTranscript(draft.scope.directory) };
      const key = sha(JSON.stringify([scope.workspaceRoot, scope.directory, scope.threadId]));
      assert.ok(!conversations[key]); conversations[key] = { ...draft, scope };
    }
    add('desktop/conversation-drafts.json', encoded({ ...drafts, conversations }), 'conversation-drafts.json', 'draft-scope-paths');
  }
  const stamp = spec.importedAt;
  for (const item of inspection.files.filter(item => item.type === 'file')) {
    let target = null, operation = 'copy-bytes', bytes;
    if (item.path.startsWith('transcripts/') || item.path.startsWith('workspace/.runloom/task-transcripts/')) {
      if (!/\.lock$|(?:^|\/)(auth-token|[^/]*\.sock)$/.test(item.path)) target = item.path.replace('workspace/.runloom/task-transcripts/', 'transcripts/tasks/');
    } else if (item.path.startsWith('workspace/.runloom/') && (basename(item.path) in validators || basename(item.path) === 'recipes.json')) {
      if (basename(item.path) === 'checkpoint.json') { mappings.push({ from: item.path, to: null, operation: 'archive-until-project-mapping-c1' }); continue; }
      target = 'data/' + basename(item.path);
    }
    if (target !== null) {
      bytes = await readFile(join(source, item.path));
      if (target === 'data/tasks.json') { bytes = encoded(restoreTaskDocument(JSON.parse(bytes), stamp)); operation = 'existing-offline-task-restore'; }
      if (target === 'data/rss.json') { const rss = JSON.parse(bytes); rss.enabled = false; bytes = encoded(rss); operation = 'disable-service'; }
      add(target, bytes, item.path, operation);
    } else if (!['config.json', 'identity.json', 'conversation-drafts.json'].includes(item.path)) mappings.push({ from: item.path, to: null, operation: 'private-backup-only' });
  }
  assert.deepEqual([...spec.userEntryIds].sort(), inspection.memory.entries.map(item => item.id).sort(), 'Every entry requires explicit approved user mapping');
  assert.deepEqual([...spec.userDocumentIds].sort(), inspection.memory.library.documents.map(item => item.id).sort(), 'Every document requires explicit provisional user mapping');
  const scopes = inspection.memory.entries.map(entry => ({ id: entry.id, category: entry.category, scope: 'user', disposition: '暂时在 user', storageScope: entry.scope,
    textSha256: sha(entry.text), sourcesSha256: sha(JSON.stringify(entry.sources)), revision: entry.revision }));
  return { files, mappings, scopes, configChanges: converted.changes, registeredThreads: mappedProfile.threads.length, registeredWithoutTranscript,
    documentScopes: inspection.memory.library.documents.map(item => ({ id: item.id, scope: 'user', disposition: '暂时在 user' })) };
}

export async function importHome({ source, home, specification, execute = false, recover = false, cutover = false, boundary = async () => {} }) {
  assert.ok(home && source, 'Explicit source and --home are required');
  source = resolve(source); home = resolve(home); guardPath(source);
  const defaultCutover = cutover && home === join(homedir(), '.serika');
  if (!defaultCutover) guardPath(home);
  let emptyTarget;
  if (defaultCutover && await exists(home)) {
    emptyTarget = await lstat(home);
    assert.ok(emptyTarget.isDirectory() && !emptyTarget.isSymbolicLink(), 'Cutover home must be a directory, never a symlink');
    assert.deepEqual(await readdir(home), [], 'Cutover home must be absent or empty');
  }
  assert.ok(!within(source, home) && !within(home, source), 'Source and home must be disjoint');
  assert.equal((await lstat(source)).isSymbolicLink(), false, 'Source root cannot be a symlink');
  source = await realpath(source);
  assert.equal(await realpath(dirname(home)), dirname(home), 'Home parent cannot contain symlinks');
  guardPath(source); if (!defaultCutover) guardPath(home);
  const spec = structuredClone(specification);
  assert.equal(spec.version, 1); assert.ok(Number.isFinite(Date.parse(spec.importedAt)), 'Explicit fixed import time required');
  assert.ok(Array.isArray(spec.manifest) && spec.manifest.every(item => safeRelative(item.path)), 'Explicit relative source manifest required');
  assert.equal(sha(encoded(spec.manifest)), spec.manifestSha256, 'Manifest digest mismatch');
  const rootMode = (await lstat(source)).mode & 0o7777;
  const before = await manifest(source); assert.deepEqual(before, spec.manifest, 'Source changed from approved manifest');
  const inspection = await inspect(source), plan = await buildTarget(source, home, spec, inspection);
  const importId = sha(encoded({ version: 1, sourceDigest: spec.manifestSha256, spec, home }));
  const targetFiles = [...plan.files].map(([path, bytes]) => ({ path, sha256: sha(bytes) }));
  const preview = { importId, sourceDigest: spec.manifestSha256, counts: inspection.counts, registeredThreads: plan.registeredThreads, registeredWithoutTranscript: plan.registeredWithoutTranscript,
    scopes: plan.scopes, documentScopes: plan.documentScopes, mappings: plan.mappings, configChanges: plan.configChanges, targetFiles, status: 'dry-run', realModelCalls: 0 };
  const checks = { fileSetEqual: true, sha256Equal: true, countsEqual: true, modesEqual: true, noExtraFiles: true };
  const prepared = { ...preview, status: 'prepared', backup: { manifestSha256: spec.manifestSha256, counts: inspection.counts }, rollback: checks };
  const receiptPath = join(home, 'imports/receipt.json'), preparedPath = join(home, 'imports/prepared.json');
  const pendingReceipt = join(home, 'imports/receipt.pending');
  const finish = async () => {
    await write(pendingReceipt, encoded({ ...prepared, status: 'passed' }));
    await boundary('before-receipt-rename'); await rename(pendingReceipt, receiptPath); await sync(join(home, 'imports'));
    await boundary('after-receipt-rename'); await sync(home); await sync(dirname(home));
  };
  const verifyTarget = async root => {
    for (const file of targetFiles) {
      assert.ok((await lstat(join(root, file.path))).isFile(), 'Target must remain a regular file');
      assert.equal(sha(await readFile(join(root, file.path))), file.sha256, 'Target content changed; do not merge or replay');
    }
    const actual = (await manifest(root)).filter(item => item.type !== 'directory').map(item => item.path).sort();
    assert.deepEqual(actual, [...targetFiles.map(item => item.path), 'imports/intent.json', 'imports/prepared.json', ...(await exists(join(root, 'imports/receipt.json')) ? ['imports/receipt.json'] : []), ...(await exists(join(root, 'imports/receipt.pending')) ? ['imports/receipt.pending'] : [])].sort(), 'Unexpected target files');
  };
  if (!emptyTarget && await exists(home)) {
    assert.deepEqual(await json(preparedPath), prepared, 'Target/source mapping conflict');
    await verifyTarget(home);
    if (await exists(receiptPath)) { const receipt = await json(receiptPath); assert.deepEqual(receipt, { ...prepared, status: 'passed' }); return { ...receipt, replay: true }; }
    assert.ok(execute && recover, 'Published data has no success receipt; explicitly recover after inspection');
    await rm(pendingReceipt, { force: true }); await finish();
    return { ...prepared, status: 'passed', recovered: true };
  }
  if (!execute) return preview;
  const work = home + '.import', backup = join(work, 'backup'), rehearsal = join(work, 'rehearsal');
  if (await exists(work)) {
    assert.ok(recover, 'Interrupted import artifacts exist; explicitly recover after inspection');
    const owner = await json(join(work, 'intent.json')); assert.equal(owner.importId, importId, 'Import/source changed; preserve previous backup');
    assert.deepEqual(await manifest(backup), before, 'Incomplete or changed backup requires manual inspection');
  } else {
    await mkdir(work, { mode: 0o700 }); await write(join(work, 'intent.json'), encoded({ importId }));
    await cp(source, backup, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await chmod(backup, (await lstat(source)).mode & 0o7777);
    assert.deepEqual(await manifest(backup), before, 'Backup file set/SHA/modes differ');
    for (const item of before.filter(item => item.type !== 'symlink').reverse()) await sync(join(backup, item.path));
    await sync(backup); await sync(work);
  }
  assert.deepEqual(await manifest(source), before, 'Source changed during backup');
  await boundary('after-backup');
  const backupInspection = await inspect(backup); assert.deepEqual(backupInspection.counts, inspection.counts);
  const staging = home + '.staging';
  if (await exists(staging)) {
    assert.ok(recover, 'Staging requires explicit recovery');
    const marker = await json(join(staging, 'imports/intent.json')); assert.equal(marker.importId, importId);
    const allowed = new Set([...targetFiles.map(item => item.path), 'imports/intent.json', 'imports/prepared.json']);
    for (const item of await manifest(staging)) assert.ok(item.type === 'directory' || item.type === 'file' && allowed.has(item.path), 'Unexpected staging entry; preserve for inspection');
    await rm(staging, { recursive: true });
  }
  await rm(rehearsal, { recursive: true, force: true }); await mkdir(rehearsal, { mode: 0o700 });
  const rehearsalPlan = await buildTarget(backup, home, spec, backupInspection);
  for (const [path, bytes] of rehearsalPlan.files) await write(join(rehearsal, path), bytes);
  const parsed = await resolveTuiModuleConfig({ configPath: join(rehearsal, 'config.json'), dataDirectory: join(rehearsal, 'data') }, { cwd: rehearsal });
  assert.equal(parsed.authorizedDirectory, spec.authorizedDirectory ?? null);
  await rm(rehearsal, { recursive: true }); await cp(backup, rehearsal, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  assert.deepEqual(await manifest(rehearsal), before, 'Rollback file list/SHA/modes differ');
  assert.equal((await lstat(rehearsal)).mode & 0o7777, rootMode, 'Rollback root mode differs');
  assert.deepEqual((await inspect(rehearsal)).counts, inspection.counts, 'Rollback logical counts differ');
  await write(join(work, 'rollback-report.json'), encoded(checks)).catch(async error => { if (error.code !== 'EEXIST') throw error; assert.deepEqual(await json(join(work, 'rollback-report.json')), checks); });
  await boundary('after-rehearsal');
  await mkdir(staging, { mode: 0o700 }); await write(join(staging, 'imports/intent.json'), encoded({ importId }));
  for (const [path, bytes] of rehearsalPlan.files) await write(join(staging, path), bytes);
  await boundary('after-data');
  await write(join(staging, 'imports/prepared.json'), encoded(prepared));
  await sync(join(staging, 'imports'));
  await verifyTarget(staging); assert.deepEqual(await manifest(source), before, 'Source changed before publish');
  for (const item of (await manifest(staging)).filter(item => item.type === 'directory').reverse()) await sync(join(staging, item.path));
  await sync(staging);
  await boundary('before-publish');
  if (emptyTarget) {
    const current = await lstat(home);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.ino === emptyTarget.ino && current.dev === emptyTarget.dev, 'Empty target changed; preserve staging');
    await rmdir(home);
  }
  assert.equal(await exists(home), false, 'Target appeared; preserve staging and refuse merge');
  await rename(staging, home); await sync(dirname(home));
  await boundary('after-publish');
  const receipt = { ...prepared, status: 'passed' };
  await finish();
  await boundary('after-receipt');
  assert.deepEqual(await manifest(source), before, 'Source changed after import');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (['--execute', '--recover', '--cutover'].includes(args[i])) options[args[i].slice(2)] = true;
      else { assert.ok(['--source', '--home', '--manifest'].includes(args[i]), 'Unknown argument'); assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing argument'); options[args[i].slice(2)] = args[++i]; }
    }
    assert.ok(options.source && options.home && options.manifest, 'Usage: home-import.mjs --source <static-copy> --home <new-home> --manifest <private-approved-plan.json> [--execute] [--recover] [--cutover]');
    const manifestPath = await realpath(resolve(options.manifest)); guardPath(manifestPath);
    assert.equal((await lstat(resolve(options.manifest))).isSymbolicLink(), false, 'Manifest must not be a symlink');
    const result = await importHome({ ...options, specification: await json(manifestPath) });
    console.log(JSON.stringify({ status: result.status, importId: result.importId, counts: result.counts, replay: result.replay ?? false, rollback: result.rollback ?? null, realModelCalls: 0 }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.code ?? (error instanceof assert.AssertionError ? 'IMPORT_CHECK_FAILED' : 'IMPORT_FAILED'), message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Inspect private artifacts before an explicit recovery' })); process.exitCode = 1;
  }
}
