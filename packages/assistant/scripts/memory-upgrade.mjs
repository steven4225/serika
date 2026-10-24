import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryAcquireFlock } from '../dist/flock.js';
import { identifyProject } from '../dist/project.js';
import { validateV7MemoryDocument } from '../dist/memory-v7-store.js';
import { MEMORY_FILE_MAX_BYTES } from '../dist/memory-types.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const preferences = new Set(['978a1257-96f3-43e4-9991-7468dab39116', '41f1d455-ef45-4a87-9f4f-d47435067e35', 'f6e52e58-8fb2-4d03-aabc-70482681be29']);
const projectEntries = new Set(['671b1ca0-e533-4ae7-9fdb-f655af8b39eb', '0a0f2df1-6496-4e69-ab94-8b6fc2e54dd7', '8291bb0f-cbf3-4d8a-83fd-802c45db1293', '99c79249-c065-498b-b5a1-980f083f209c']);
function parse(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('JSON 格式无效，未修改文件'); } }
function legacyScope(scope) { assert.deepEqual(scope, { kind: 'workspace' }, '旧版 scope 必须严格为 workspace'); }
function noNewField(value, field) { assert.ok(!Object.hasOwn(value, field), `旧版数据不能含 ${field}`); }

// Historical importers validate v6 offline; only the v7 store is available at runtime.
export function validateLegacyV6MemoryDocument(value) {
  assert.ok(value && value.version === 6, '仅支持显式升级 v6 记忆');
  const source = structuredClone(value);
  for (const entry of source.entries) legacyScope(entry.scope);
  for (const document of source.library.documents) legacyScope(document.scope);
  for (const progress of source.progress) noNewField(progress, 'projectId');
  for (const item of source.suppressed) noNewField(item, 'scope');
  for (const receipt of source.importReceipts) noNewField(receipt, 'projectId');
  const checked = validateV7MemoryDocument({ ...source, version: 7,
    entries: source.entries.map(entry => ({ ...entry, scope: { kind: 'user' } })),
    library: { ...source.library, documents: source.library.documents.map(document => ({ ...document, scope: { kind: 'user' } })) },
    progress: source.progress.map(item => ({ ...item, projectId: null })),
    suppressed: source.suppressed.map(item => ({ ...item, scope: { kind: 'user' } })),
    importReceipts: source.importReceipts.map(item => ({ ...item, projectId: null })),
  });
  return { ...checked, version: 6,
    entries: checked.entries.map(entry => ({ ...entry, scope: { kind: 'workspace' } })),
    library: { ...checked.library, documents: checked.library.documents.map(document => ({ ...document, scope: { kind: 'workspace' } })) },
    progress: checked.progress.map(({ projectId: _project, ...item }) => item),
    suppressed: checked.suppressed.map(({ scope: _scope, ...item }) => item),
    importReceipts: checked.importReceipts.map(({ projectId: _project, ...item }) => item),
  };
}
function mappingScope(scope) {
  assert.ok(scope && !Array.isArray(scope), 'mapping scope 无效');
  if (scope.kind === 'user') assert.deepEqual(scope, { kind: 'user' }, 'mapping user scope 无效');
  else { assert.equal(scope.kind, 'project', 'mapping scope 必须为 user 或 project'); assert.ok(typeof scope.projectId === 'string' && scope.projectId.length > 0, 'mapping projectId 必须显式指定'); assert.deepEqual(Object.keys(scope).sort(), ['kind', 'projectId']); }
  return scope;
}
export function planMemoryUpgrade(value, project, mapping = []) {
  const before = validateLegacyV6MemoryDocument(value);
  assert.ok(project && typeof project.id === 'string', '必须指定实际项目目录');
  assert.ok(Array.isArray(mapping), 'mapping 必须是逐项 {id,scope} 数组');
  const explicit = new Map();
  for (const row of mapping) { assert.deepEqual(Object.keys(row).sort(), ['id', 'scope']); assert.ok(typeof row.id === 'string' && row.id.length > 0 && !explicit.has(row.id), 'mapping ID 无效或重复'); explicit.set(row.id, mappingScope(row.scope)); }
  const scopeFor = id => preferences.has(id) ? { kind: 'user' } : projectEntries.has(id) ? { kind: 'project', projectId: project.id } : explicit.get(id);
  const used = new Set(), unknown = [], rows = before.entries.map(entry => {
    const approved = scopeFor(entry.id);
    if (explicit.has(entry.id)) { assert.deepEqual(explicit.get(entry.id), approved, 'mapping 不能覆盖已批准归属'); used.add(entry.id); }
    if (!approved) unknown.push({ id: entry.id, category: entry.category });
    return { id: entry.id, category: entry.category, scope: approved ?? null };
  });
  const scopes = new Map(rows.map(row => [row.id, row.scope]));
  const documents = before.library.documents.map(document => {
    const members = document.entryIds.map(id => scopes.get(id));
    assert.ok(members.every(scope => scope !== undefined), '文档引用不存在的条目');
    const scope = members[0] ?? null;
    if (members.some(item => item && scope && JSON.stringify(item) !== JSON.stringify(scope))) throw new Error('文档分块归属不一致，需人工核对');
    return { id: document.id, scope: members.every(Boolean) ? scope : null };
  });
  const suppressed = before.suppressed.map((item, index) => {
    const id = `suppressed:${index}`, matches = before.entries.filter(entry => entry.identity?.subject === item.identity.subject && entry.identity?.attribute === item.identity.attribute && entry.sources.some(source => source.kind === 'conversation' && source.threadId === item.threadId && source.messageId === item.messageId));
    const candidates = [...new Map(matches.map(entry => [JSON.stringify(scopes.get(entry.id)), scopes.get(entry.id)])).values()].filter(Boolean);
    const scope = explicit.get(id) ?? (candidates.length === 1 ? candidates[0] : null);
    if (explicit.has(id)) used.add(id);
    if (!scope) unknown.push({ id, category: 'suppressed' });
    return { ...item, scope };
  });
  assert.ok([...explicit.keys()].every(id => used.has(id)), 'mapping 含当前文件不存在的 ID');
  const report = { ok: unknown.length === 0, project: { id: project.id, directory: project.directory }, entries: rows, documents, suppressed: suppressed.map((item, index) => ({ id: `suppressed:${index}`, scope: item.scope })), unknown,
    counts: { entries: before.entries.length, preferences: before.entries.filter(entry => entry.category === 'preference').length, documents: before.entries.filter(entry => entry.category === 'document').length, libraryDocuments: before.library.documents.length } };
  if (!report.ok) return { report };
  const after = validateV7MemoryDocument({ ...before, version: 7, entries: before.entries.map(entry => ({ ...entry, scope: scopes.get(entry.id) })),
    library: { ...before.library, documents: before.library.documents.map((document, index) => ({ ...document, scope: documents[index].scope })) },
    progress: before.progress.map(item => ({ ...item, projectId: null })), suppressed,
    importReceipts: before.importReceipts.map(item => ({ ...item, projectId: null })),
  });
  return { report, after };
}
async function read(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '记忆、备份和回执必须是无硬链接的常规文件'); assert.ok(stat.size <= MEMORY_FILE_MAX_BYTES, '记忆文件超过 16 MiB'); return { bytes: await file.readFile(), mode: stat.mode & 0o777 }; }
  finally { await file.close(); }
}
async function syncDirectory(path) { const file = await open(dirname(path), 'r'); try { await file.sync(); } finally { await file.close(); } }
async function writeNew(path, bytes, mode = 0o600) { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); } finally { await file.close(); } await syncDirectory(path); }
async function replace(path, bytes, expectedSha, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`; let renamed = false;
  try { await writeNew(temporary, bytes, mode); assert.equal(sha((await read(path)).bytes), expectedSha, '记忆已变化，未覆盖'); await rename(temporary, path); renamed = true; await syncDirectory(path); }
  catch (error) { if (renamed) throw new Error('记忆写入结果未确认；请核对 SHA 和回执，勿自动重试', { cause: error }); throw error; }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function canonicalMemory(path) { assert.ok(typeof path === 'string' && isAbsolute(path), '--memory 必须显式指定绝对路径'); return join(await realpath(dirname(path)), basename(path)); }
async function locked(path, operation) {
  const file = await open(`${path}.lock`, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '记忆锁必须是无硬链接的常规文件'); } finally { await file.close(); }
  const lock = await tryAcquireFlock(`${path}.lock`); assert.ok(lock, '记忆正被其他进程修改，请停用所有写入者后离线升级');
  try { return await operation(); } finally { await lock.release(); }
}
export async function upgradeMemory({ memoryPath, projectPath, mappingPath, dryRun = false }) {
  const path = await canonicalMemory(memoryPath);
  assert.ok(typeof projectPath === 'string' && isAbsolute(projectPath), '--project 必须显式指定绝对路径');
  const project = await identifyProject(projectPath);
  if (mappingPath !== undefined) assert.ok(typeof mappingPath === 'string' && isAbsolute(mappingPath), '--mapping 必须为绝对路径');
  const mapping = mappingPath === undefined ? [] : parse((await read(mappingPath)).bytes);
  const prepare = original => planMemoryUpgrade(parse(original.bytes), project, mapping);
  if (dryRun) { const original = await read(path), plan = prepare(original); return { ...plan.report, dryRun: true, memoryPath: path, originalSha256: sha(original.bytes) }; }
  return locked(path, async () => {
    const original = await read(path), plan = prepare(original);
    assert.ok(plan.report.ok, '存在未裁决归属，请先 --dry-run，逐项提供 --mapping 后再升级');
    const bytes = Buffer.from(encoded(plan.after)); assert.ok(bytes.length <= MEMORY_FILE_MAX_BYTES, '升级后的记忆文件超过 16 MiB，未修改文件');
    const id = randomUUID(), backupPath = `${path}.v6-${id}.backup`, receiptPath = `${path}.v7-${id}.receipt.json`;
    const receipt = { version: 1, operation: 'memory-v6-to-v7', id, memoryPath: path, backupPath, originalSha256: sha(original.bytes), upgradedSha256: sha(bytes), originalMode: original.mode, ...plan.report };
    await writeNew(backupPath, original.bytes);
    await writeNew(receiptPath, encoded(receipt));
    await replace(path, bytes, receipt.originalSha256, original.mode);
    return { ...receipt, receiptPath };
  });
}
export async function rollbackMemory({ memoryPath, receiptPath }) {
  const path = await canonicalMemory(memoryPath);
  assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath), '--rollback 必须显式指定回执绝对路径');
  return locked(path, async () => {
    const receipt = parse((await read(receiptPath)).bytes);
    assert.ok(receipt.version === 1 && receipt.operation === 'memory-v6-to-v7' && receipt.memoryPath === path, '回执不属于此记忆升级');
    assert.ok(typeof receipt.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.id) && receipt.backupPath === `${path}.v6-${receipt.id}.backup`, '备份路径与升级回执不符');
    assert.ok(/^[a-f0-9]{64}$/.test(receipt.originalSha256) && /^[a-f0-9]{64}$/.test(receipt.upgradedSha256), '回执 SHA 无效');
    assert.ok(Number.isInteger(receipt.originalMode) && receipt.originalMode >= 0 && receipt.originalMode <= 0o777, '回执权限无效');
    const backup = await read(receipt.backupPath), current = await read(path);
    assert.equal(sha(backup.bytes), receipt.originalSha256, '备份 SHA 不符，未回滚');
    assert.equal(sha(current.bytes), receipt.upgradedSha256, '记忆已变化，未回滚');
    const rollbackReceiptPath = `${receiptPath}.${randomUUID()}.rollback.json`;
    await replace(path, backup.bytes, receipt.upgradedSha256, receipt.originalMode);
    const restoredSha256 = sha((await read(path)).bytes); assert.equal(restoredSha256, receipt.originalSha256, '回滚后 SHA 不符');
    const result = { version: 1, operation: 'memory-v7-to-v6-rollback', memoryPath: path, upgradeReceiptPath: receiptPath, originalSha256: receipt.originalSha256, restoredSha256, identical: true };
    try { await writeNew(rollbackReceiptPath, encoded(result)); } catch (error) { throw new Error('记忆已恢复但回滚回执未确认；请核对 SHA，勿自动重试', { cause: error }); }
    return { ...result, rollbackReceiptPath };
  });
}
async function main() {
  const args = process.argv.slice(2), options = {}; let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = { '--memory': 'memoryPath', '--project': 'projectPath', '--mapping': 'mappingPath' }[arg];
    if (key) { assert.ok(options[key] === undefined, `${arg} 重复`); options[key] = args[++i]; }
    else if (['--dry-run', '--upgrade', '--rollback'].includes(arg)) { assert.ok(!mode, '只允许指定一种操作'); mode = arg; if (arg === '--rollback') options.receiptPath = args[++i]; }
    else throw new Error(`未知参数：${arg}`);
  }
  assert.ok(mode, '用法：node <memory-upgrade.mjs绝对路径> --memory <绝对路径> --project <项目绝对路径> [--mapping <绝对路径>] --dry-run | --upgrade | --rollback <回执绝对路径>');
  const result = mode === '--rollback' ? await rollbackMemory(options) : await upgradeMemory({ ...options, dryRun: mode === '--dry-run' });
  process.stdout.write(encoded(result)); if (result.ok === false) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
