import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink, mkdir, lstat, readdir, readlink, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { tryAcquireFlock } from '../dist/flock.js';
import { projectRegistrySchema } from '../dist/project.js';
import { validateV7MemoryDocument } from '../dist/memory-v7-store.js';
import { MEMORY_FILE_MAX_BYTES } from '../dist/memory-types.js';

export const EXPECTED_MEMORY_SHA = '0f4aa629f06fc2327912dbef47bcdbced1514cac1028660c4fd6796f322fb9bc';
export const RELEASE_PROJECT_ID = '51cb91fdad93f355d936d0396a389c545fa451e6637fe6c7588a585d5f852910';
export const PERSONAL_PROJECT = Object.freeze({ id: '2edc36f50ce8b4bd28ea7ec30b5eb9223d3fd70eb65c6d0a6786babf043c89eb', directory: '/Users/a1-6/Serika-workspaces/personal', name: 'personal', kind: 'folder' });
export const EXPECTED_PROJECTS = '{"version":1,"projects":[{"id":"51cb91fdad93f355d936d0396a389c545fa451e6637fe6c7588a585d5f852910","directory":"/Users/a1-6/Applications/Serika-releases/983e8d394ad2e7367532e550b2df9681b39ca70d","name":"983e8d394ad2e7367532e550b2df9681b39ca70d","kind":"git"}],"selected":"51cb91fdad93f355d936d0396a389c545fa451e6637fe6c7588a585d5f852910"}';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const fileNames = ['memory.json', 'projects.json'];

export function planDailyProjectRepair(memory) {
  validateV7MemoryDocument(memory);
  const old = memory.progress.filter(row => row.projectId === null), mistaken = memory.progress.filter(row => row.projectId === RELEASE_PROJECT_ID);
  assert.equal(old.length, 14, '必须恰有 14 条旧 null progress，未修改');
  assert.equal(mistaken.length, 1, '必须恰有一条发布目录 progress，未修改');
  assert.equal(memory.progress.length, 15, '出现未经批准的其他 progress，未修改');
  const progress = old.map(row => ({ ...row, projectId: PERSONAL_PROJECT.id }));
  const afterMemory = { ...memory, progress };
  validateV7MemoryDocument(afterMemory);
  const afterProjects = projectRegistrySchema.parse({ version: 1, projects: [PERSONAL_PROJECT], selected: PERSONAL_PROJECT.id });
  return { afterMemory, afterProjects, diff: [
    { file: 'projects.json', path: '/projects', before: parse(Buffer.from(EXPECTED_PROJECTS)).projects, after: afterProjects.projects },
    { file: 'projects.json', path: '/selected', before: RELEASE_PROJECT_ID, after: PERSONAL_PROJECT.id },
    ...memory.progress.flatMap((row, index) => row.projectId === null
      ? [{ file: 'memory.json', path: `/progress/${index}/projectId`, threadId: row.threadId, before: null, after: PERSONAL_PROJECT.id }]
      : [{ file: 'memory.json', path: `/progress/${index}`, before: row, after: { absent: true } }]),
  ] };
}
async function read(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '目标、备份、回执必须为无硬链接的常规文件'); assert.ok(stat.size <= MEMORY_FILE_MAX_BYTES, '数据文件超过既有 16 MiB 上限'); return { bytes: await file.readFile(), mode: stat.mode & 0o777 }; }
  finally { await file.close(); }
}
async function syncParent(path) { const file = await open(dirname(path), 'r'); try { await file.sync(); } finally { await file.close(); } }
async function writeNew(path, bytes, mode = 0o600) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
  await syncParent(path);
}
async function replace(path, bytes, expectedSha, mode) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeNew(temp, bytes, mode); const current = await read(path); assert.equal(sha(current.bytes), expectedSha, '当前文件 SHA 已变化，停止覆盖'); assert.equal(current.mode, mode, '当前文件权限已变化'); await rename(temp, path); await syncParent(path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function manifest(root) {
  const rows = [];
  async function visit(path = '') {
    const full = join(root, path), stat = await lstat(full), base = { path, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) rows.push({ ...base, type: 'symlink', target: await readlink(full) });
    else if (stat.isDirectory()) { rows.push({ ...base, type: 'directory' }); for (const name of (await readdir(full)).sort()) await visit(join(path, name)); }
    else { assert.ok(stat.isFile(), `完整备份不支持此文件类型：${path}`); rows.push({ ...base, type: 'file', bytes: stat.size, sha256: sha(await readFile(full)) }); }
  }
  await visit(); return rows;
}
async function homePath(homeDirectory) {
  assert.ok(typeof homeDirectory === 'string' && isAbsolute(homeDirectory), '--home 必须显式指定绝对路径');
  const home = await realpath(homeDirectory);
  assert.equal(await realpath(join(home, 'data')), join(home, 'data'), 'data 目录不能通过符号链接指向 home 外');
  return home;
}
async function lockHome(home, operation) {
  const locks = [];
  try {
    for (const name of fileNames) {
      const path = join(home, 'data', name + '.lock'), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1, '锁必须为无硬链接的常规文件'); } finally { await file.close(); }
      const lock = await tryAcquireFlock(path); assert.ok(lock, '数据正被使用，先退出所有 Serika 写入者'); locks.push(lock);
    }
    return await operation();
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
async function prepare(home) {
  const memory = await read(join(home, 'data/memory.json')), projects = await read(join(home, 'data/projects.json'));
  assert.equal(sha(memory.bytes), EXPECTED_MEMORY_SHA, 'memory.json SHA 不等于获批的 0f4aa629…，停止');
  assert.equal(projects.bytes.toString('utf8'), EXPECTED_PROJECTS, 'projects.json 不等于获批现值，停止');
  const plan = planDailyProjectRepair(parse(memory.bytes));
  const files = [{ name: 'memory.json', before: memory, after: plan.afterMemory }, { name: 'projects.json', before: projects, after: plan.afterProjects }].map(row => {
    const afterBytes = encode(row.after); assert.ok(afterBytes.length <= MEMORY_FILE_MAX_BYTES);
    return { ...row, afterBytes, path: join(home, 'data', row.name), beforeSha256: sha(row.before.bytes), afterSha256: sha(afterBytes), originalMode: row.before.mode };
  });
  return { plan, files };
}
export async function repairDailyProject({ homeDirectory, dryRun = false }) {
  const home = await homePath(homeDirectory);
  const initial = await prepare(home);
  if (dryRun) return { operation: 'release3-daily-project-repair', dryRun: true, homeDirectory: home, files: initial.files.map(({ name, beforeSha256, afterSha256 }) => ({ name, beforeSha256, afterSha256 })), diff: initial.plan.diff };
  return lockHome(home, async () => {
    const { plan, files } = await prepare(home), id = randomUUID();
    const outputDirectory = join(dirname(home), `Serika-release3-repair-${id}`), backupDirectory = join(outputDirectory, 'home-backup');
    await mkdir(outputDirectory, { mode: 0o700 });
    const beforeManifest = await manifest(home);
    const copy = spawnSync('/bin/cp', ['-a', home, backupDirectory], { encoding: 'utf8' }); assert.equal(copy.status, 0, copy.stderr);
    assert.deepEqual(await manifest(backupDirectory), beforeManifest, '完整备份清单与源不符，未修复');
    assert.deepEqual(await manifest(home), beforeManifest, '备份期间 home 已变化，未修复');
    const manifestPath = join(outputDirectory, 'home-before-manifest.json'); await writeNew(manifestPath, encode(beforeManifest));
    const receiptPath = join(outputDirectory, 'repair.receipt.json');
    const receipt = { version: 1, operation: 'release3-daily-project-repair', phase: 'prepared', id, homeDirectory: home, backupDirectory, manifestPath, manifestSha256: sha(encode(beforeManifest)), createdAt: new Date().toISOString(),
      files: files.map(({ name, path, beforeSha256, afterSha256, originalMode }) => ({ name, path, backupPath: join(backupDirectory, 'data', name), beforeSha256, afterSha256, originalMode })), diff: plan.diff };
    const receiptBytes = encode(receipt), receiptSha256 = sha(receiptBytes); await writeNew(receiptPath, receiptBytes);
    try {
      for (const row of files) await replace(row.path, row.afterBytes, row.beforeSha256, row.originalMode);
      for (const row of files) assert.equal(sha((await read(row.path)).bytes), row.afterSha256);
      const afterManifest = await manifest(home);
      const authorized = new Set(files.map(row => 'data/' + row.name));
      assert.deepEqual(afterManifest.filter(row => !authorized.has(row.path)), beforeManifest.filter(row => !authorized.has(row.path)), '修复期间其他 home 文件变化，停止启动并核对');
      const result = { ...receipt, phase: 'applied', receiptPath, receiptSha256, completedAt: new Date().toISOString(), files: receipt.files, afterManifestSha256: sha(encode(afterManifest)) };
      const appliedReceiptPath = join(outputDirectory, 'repair.applied.json'); await writeNew(appliedReceiptPath, encode(result));
      return { ...result, appliedReceiptPath, appliedReceiptSha256: sha(encode(result)) };
    } catch (error) { throw new Error(`修复写入结果未确认；勿重试/启动。使用 --rollback '${receiptPath}' --receipt-sha ${receiptSha256} 核对恢复。原因：${error.message}`, { cause: error }); }
  });
}
export async function rollbackDailyProject({ homeDirectory, receiptPath, receiptSha256 }) {
  const home = await homePath(homeDirectory);
  assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath), '--rollback 必须指定回执绝对路径');
  assert.match(receiptSha256 ?? '', /^[a-f0-9]{64}$/, '--receipt-sha 必须指定 apply 输出的回执 SHA');
  return lockHome(home, async () => {
    const bytes = (await read(receiptPath)).bytes; assert.equal(sha(bytes), receiptSha256, '回执 SHA 不符，未回滚');
    const receipt = parse(bytes); assert.ok(receipt.version === 1 && receipt.operation === 'release3-daily-project-repair' && receipt.phase === 'prepared' && receipt.homeDirectory === home, '回执不属于此 home 修复');
    assert.match(receipt.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const output = join(dirname(home), `Serika-release3-repair-${receipt.id}`);
    assert.equal(receiptPath, join(output, 'repair.receipt.json'), '回执路径不符'); assert.equal(receipt.backupDirectory, join(output, 'home-backup'));
    assert.equal(receipt.manifestPath, join(output, 'home-before-manifest.json'));
    const manifestBytes = (await read(receipt.manifestPath)).bytes; assert.equal(sha(manifestBytes), receipt.manifestSha256, '备份清单 SHA 不符');
    assert.ok(isDeepStrictEqual(await manifest(receipt.backupDirectory), parse(manifestBytes)), '完整备份已变化，未回滚');
    assert.ok(Array.isArray(receipt.files) && receipt.files.length === 2 && isDeepStrictEqual(receipt.files.map(row => row.name), fileNames), '回执文件列表无效');
    const checked = [];
    for (const row of receipt.files) {
      assert.equal(row.path, join(home, 'data', row.name)); assert.equal(row.backupPath, join(receipt.backupDirectory, 'data', row.name));
      assert.match(row.beforeSha256, /^[a-f0-9]{64}$/); assert.match(row.afterSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(row.originalMode) && row.originalMode >= 0 && row.originalMode <= 0o777);
      const backup = await read(row.backupPath), current = await read(row.path), currentSha = sha(current.bytes);
      assert.equal(sha(backup.bytes), row.beforeSha256, '备份 SHA 不符'); assert.ok([row.beforeSha256, row.afterSha256].includes(currentSha), '当前文件已变化，未回滚'); assert.equal(current.mode, row.originalMode);
      checked.push({ ...row, backup, currentSha });
    }
    try { for (const row of [...checked].reverse()) if (row.currentSha !== row.beforeSha256) await replace(row.path, row.backup.bytes, row.currentSha, row.originalMode); }
    catch (error) { throw new Error(`回滚写入结果未确认；核对 SHA，勿自动重试：${receiptPath}`, { cause: error }); }
    const files = [];
    for (const row of checked) { const restored = await read(row.path); assert.equal(sha(restored.bytes), row.beforeSha256); assert.equal(restored.mode, row.originalMode); files.push({ name: row.name, restoredSha256: row.beforeSha256 }); }
    const result = { version: 1, operation: 'release3-daily-project-repair-rollback', homeDirectory: home, receiptPath, receiptSha256, files, identical: true, completedAt: new Date().toISOString() };
    const rollbackReceiptPath = join(output, `rollback-${randomUUID()}.json`);
    try { await writeNew(rollbackReceiptPath, encode(result)); }
    catch (error) { throw new Error('文件已恢复但回滚回执未确认；请核对两个文件 SHA，勿自动重试', { cause: error }); }
    return { ...result, rollbackReceiptPath, rollbackReceiptSha256: sha(encode(result)) };
  });
}
async function main() {
  const args = process.argv.slice(2), options = {}; let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = { '--home': 'homeDirectory', '--receipt-sha': 'receiptSha256' }[arg];
    if (key) { assert.equal(options[key], undefined, `${arg} 重复`); options[key] = args[++i]; }
    else if (['--dry-run', '--apply', '--rollback'].includes(arg)) { assert.ok(!mode, '只允许一种操作'); mode = arg; if (arg === '--rollback') options.receiptPath = args[++i]; }
    else throw new Error(`未知参数：${arg}`);
  }
  assert.ok(mode, '用法：node daily-project-repair.mjs --home <绝对路径> --dry-run | --apply | --rollback <回执> --receipt-sha <SHA>');
  assert.ok(mode === '--rollback' || options.receiptSha256 === undefined, '--receipt-sha 仅用于回滚');
  const result = mode === '--rollback' ? await rollbackDailyProject(options) : await repairDailyProject({ ...options, dryRun: mode === '--dry-run' });
  process.stdout.write(encode(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
