import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryAcquireFlock } from '../dist/flock.js';
import { identifyProject, projectRegistrySchema } from '../dist/project.js';
import { validateV7MemoryDocument } from '../dist/memory-v7-store.js';
import { MEMORY_FILE_MAX_BYTES } from '../dist/memory-types.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const parse = bytes => JSON.parse(bytes.toString('utf8'));
async function read(path, optional = false) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '文件必须为无硬链接的常规文件'); assert.ok(stat.size <= MEMORY_FILE_MAX_BYTES, '文件超过 16 MiB'); return { bytes: await file.readFile(), mode: stat.mode & 0o777 }; }
  finally { await file.close(); }
}
async function syncParent(path) { const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
async function writeNew(path, bytes, mode = 0o600) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
  await syncParent(path);
}
async function replace(path, bytes, expectedSha, mode) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeNew(temp, bytes, mode); assert.equal(sha((await read(path)).bytes), expectedSha, '文件已变化，未覆盖'); await rename(temp, path); await syncParent(path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function dataPath(path) { assert.ok(typeof path === 'string' && isAbsolute(path), '--data 必须显式指定 H/data 的绝对路径'); return realpath(path); }
async function locked(data, operation) {
  const locks = [];
  try {
    for (const name of ['memory.json', 'projects.json']) {
      const path = join(data, `${name}.lock`), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '锁必须为无硬链接的常规文件'); } finally { await file.close(); }
      const lock = await tryAcquireFlock(path); assert.ok(lock, '数据正被其他进程使用，请停止全部 Serika 写入者后离线重绑'); locks.push(lock);
    }
    return await operation();
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
function plan(registry, memory, from, target) {
  assert.ok(typeof from === 'string' && from.length > 0, '--from 必须为已注册的旧绝对路径或项目 ID');
  const old = registry.projects.find(project => project.id === from || project.directory === from);
  assert.ok(old, '未找到旧项目注册，不猜测归属'); assert.notEqual(old.id, target.id, '新旧项目 ID 相同，无需重绑');
  const owns = (scope, id) => scope.kind === 'project' && scope.projectId === id;
  const counts = id => ({ entries: memory?.entries.filter(e => owns(e.scope, id)).length ?? 0,
    documents: memory?.library.documents.filter(d => owns(d.scope, id)).length ?? 0,
    progress: memory?.progress.filter(p => p.projectId === id).length ?? 0,
    receipts: memory?.importReceipts.filter(r => r.projectId === id).length ?? 0,
    suppressed: memory?.suppressed.filter(s => owns(s.scope, id)).length ?? 0 });
  assert.ok(Object.values(counts(target.id)).every(count => count === 0), '目标项目已有记忆、文档、进度或回执，停止重绑，不合并');
  const scope = value => owns(value, old.id) ? { kind: 'project', projectId: target.id } : value;
  const afterRegistry = projectRegistrySchema.parse({ ...registry, projects: [...registry.projects.filter(p => p.id !== old.id && p.id !== target.id), target], selected: registry.selected === old.id ? target.id : registry.selected });
  const afterMemory = memory && validateV7MemoryDocument({ ...memory, entries: memory.entries.map(e => ({ ...e, scope: scope(e.scope) })),
    library: { ...memory.library, documents: memory.library.documents.map(d => ({ ...d, scope: scope(d.scope) })) },
    progress: memory.progress.map(p => ({ ...p, projectId: p.projectId === old.id ? target.id : p.projectId })),
    suppressed: memory.suppressed.map(s => ({ ...s, scope: scope(s.scope) })),
    importReceipts: memory.importReceipts.map(r => ({ ...r, projectId: r.projectId === old.id ? target.id : r.projectId })) });
  return { report: { from: old, to: target, affected: { ...counts(old.id), registrations: 1, selected: Number(registry.selected === old.id) }, historicalHashesPreserved: true }, afterRegistry, afterMemory };
}
export async function rebindProject({ dataDirectory, from, to, dryRun = false }) {
  const data = await dataPath(dataDirectory); assert.ok(typeof to === 'string' && isAbsolute(to), '--to 必须为新项目绝对路径');
  const target = await identifyProject(to);
  const prepare = async () => {
    const projects = await read(join(data, 'projects.json')), memory = await read(join(data, 'memory.json'), true);
    return { projects, memory, ...plan(projectRegistrySchema.parse(parse(projects.bytes)), memory && validateV7MemoryDocument(parse(memory.bytes)), from, target) };
  };
  if (dryRun) { const p = await prepare(); return { ...p.report, dryRun: true, files: { projects: sha(p.projects.bytes), memory: p.memory ? sha(p.memory.bytes) : null } }; }
  return locked(data, async () => {
    const p = await prepare(), id = randomUUID(), receiptPath = join(data, `project-rebind-${id}.receipt.json`);
    const files = [{ name: 'memory.json', before: p.memory, after: p.afterMemory }, { name: 'projects.json', before: p.projects, after: p.afterRegistry }].filter(row => row.before).map(row => {
      const bytes = encode(row.after); assert.ok(bytes.length <= MEMORY_FILE_MAX_BYTES, '重绑后文件超过 16 MiB');
      return { ...row, bytes, path: join(data, row.name), backupPath: join(data, `${row.name}.rebind-${id}.backup`), originalSha256: sha(row.before.bytes), reboundSha256: sha(bytes), originalMode: row.before.mode };
    });
    const receipt = { version: 1, operation: 'project-rebind', id, dataDirectory: data, ...p.report,
      files: files.map(({ path, backupPath, originalSha256, reboundSha256, originalMode }) => ({ path, backupPath, originalSha256, reboundSha256, originalMode })) };
    for (const row of files) await writeNew(row.backupPath, row.before.bytes);
    await writeNew(receiptPath, encode(receipt));
    try { for (const row of files) await replace(row.path, row.bytes, row.originalSha256, row.originalMode); }
    catch (error) { throw new Error(`重绑写入结果未确认；停止启动/重试，请使用 --rollback '${receiptPath}' 核对恢复`, { cause: error }); }
    return { ...receipt, receiptPath };
  });
}
export async function rollbackProject({ dataDirectory, receiptPath }) {
  const data = await dataPath(dataDirectory); assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath), '--rollback 必须为回执绝对路径');
  return locked(data, async () => {
    const receipt = parse((await read(receiptPath)).bytes);
    assert.ok(receipt.version === 1 && receipt.operation === 'project-rebind' && receipt.dataDirectory === data, '回执不属于此项目重绑');
    assert.match(receipt.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.ok(Array.isArray(receipt.files) && receipt.files.length >= 1 && receipt.files.length <= 2, '回执文件列表无效');
    assert.equal(new Set(receipt.files.map(f => f.path)).size, receipt.files.length, '回执文件重复');
    assert.ok(receipt.files.some(f => f.path === join(data, 'projects.json')), '回执缺少项目注册');
    if (!receipt.files.some(f => f.path === join(data, 'memory.json'))) assert.equal(await read(join(data, 'memory.json'), true), null, '重绑后出现新的记忆文件，未回滚');
    const checked = [];
    for (const row of receipt.files) {
      assert.ok(['memory.json', 'projects.json'].some(name => row.path === join(data, name)), '回执文件路径无效');
      assert.equal(row.backupPath, `${row.path}.rebind-${receipt.id}.backup`, '备份路径不符');
      for (const hash of [row.originalSha256, row.reboundSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(row.originalMode) && row.originalMode >= 0 && row.originalMode <= 0o777, '原文件权限无效');
      const backup = await read(row.backupPath), current = await read(row.path), currentSha = sha(current.bytes);
      assert.equal(sha(backup.bytes), row.originalSha256, '备份 SHA 不符，未回滚');
      assert.ok([row.originalSha256, row.reboundSha256].includes(currentSha), '当前文件已变化，未回滚');
      assert.equal(current.mode, row.originalMode, '当前文件权限已变化，未回滚');
      checked.push({ ...row, backup, currentSha });
    }
    const rollbackReceiptPath = `${receiptPath}.${randomUUID()}.rollback.json`;
    try { for (const row of checked) if (row.currentSha !== row.originalSha256) await replace(row.path, row.backup.bytes, row.currentSha, row.originalMode); }
    catch (error) { throw new Error(`回滚结果未确认；保留回执并核对两个文件 SHA：${receiptPath}`, { cause: error }); }
    const files = [];
    for (const row of checked) { const restored = await read(row.path); assert.equal(sha(restored.bytes), row.originalSha256); assert.equal(restored.mode, row.originalMode); files.push({ path: row.path, originalSha256: row.originalSha256, restoredSha256: sha(restored.bytes), identical: true }); }
    const result = { version: 1, operation: 'project-rebind-rollback', rebindReceiptPath: receiptPath, files, identical: true };
    try { await writeNew(rollbackReceiptPath, encode(result)); }
    catch (error) { throw new Error('文件已恢复但回滚回执未确认；请核对 SHA，勿自动重试', { cause: error }); }
    return { ...result, rollbackReceiptPath };
  });
}
async function main() {
  const args = process.argv.slice(2), options = {}; let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = { '--data': 'dataDirectory', '--from': 'from', '--to': 'to' }[arg];
    if (key) { assert.equal(options[key], undefined, `${arg} 重复`); options[key] = args[++i]; }
    else if (['--dry-run', '--upgrade', '--rollback'].includes(arg)) { assert.ok(!mode, '只允许一种操作'); mode = arg; if (arg === '--rollback') options.receiptPath = args[++i]; }
    else throw new Error(`未知参数：${arg}`);
  }
  assert.ok(mode, '用法：node <project-rebind.mjs绝对路径> --data <H/data绝对路径> --from <旧路径或ID> --to <新绝对路径> --dry-run | --upgrade | --rollback <回执绝对路径>');
  const result = mode === '--rollback' ? await rollbackProject(options) : await rebindProject({ ...options, dryRun: mode === '--dry-run' });
  process.stdout.write(encode(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
