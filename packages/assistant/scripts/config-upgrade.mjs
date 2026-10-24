import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryAcquireFlock } from '../dist/flock.js';
import { parseTuiModuleConfig } from '../dist/tui-module-config.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const own = (value, key) => Object.hasOwn(value, key);

function parse(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('JSON 格式无效，未修改文件'); }
}
function convert(bytes) {
  const before = parse(bytes);
  assert.ok(before && !Array.isArray(before) && before.version === 1, '仅支持显式升级 v1 配置');
  const path = before.authorizedDirectory;
  assert.ok(path == null || (typeof path === 'string' && path.trim().length > 0), 'authorizedDirectory 必须为非空路径或 null');
  const hasNewFields = own(before, 'authorizedDirectories') || own(before, 'projectDirectory');
  assert.ok(path == null || !hasNewFields, 'v1 同时包含旧版授权和新版目录字段，需人工核对');
  const after = hasNewFields ? { ...before, version: 2 } : { ...before, version: 2, authorizedDirectories: path == null ? [] : [{ path, access: 'readwrite' }], projectDirectory: path ?? null };
  delete after.authorizedDirectory;
  try { parseTuiModuleConfig(after); }
  catch (error) { throw new Error('转换后的配置不符合 v2 schema，未修改文件', { cause: error }); }
  return { before, after, bytes: Buffer.from(encoded(after)) };
}

async function read(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.nlink === 1, '配置和回执必须是无硬链接的常规文件');
    return { bytes: await file.readFile(), mode: stat.mode & 0o777 };
  } finally { await file.close(); }
}
async function syncDirectory(path) {
  const file = await open(dirname(path), 'r');
  try { await file.sync(); } finally { await file.close(); }
}
async function writeNew(path, bytes, mode = 0o600) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
  await syncDirectory(path);
}
async function replace(path, bytes, expectedSha, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeNew(temporary, bytes, mode);
    assert.equal(sha((await read(path)).bytes), expectedSha, '配置已变化，未覆盖');
    await rename(temporary, path); renamed = true;
    await syncDirectory(path);
  } catch (error) {
    if (renamed) throw new Error('配置写入结果未确认；请核对配置 SHA 和回执，勿自动重试', { cause: error });
    throw error;
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function canonicalConfig(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), '--config 必须显式指定绝对路径');
  return join(await realpath(dirname(path)), basename(path));
}
async function locked(path, operation) {
  const lockPath = `${path}.lock`;
  const file = await open(lockPath, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { assert.ok((await file.stat()).isFile(), '配置锁必须是常规文件'); } finally { await file.close(); }
  const lock = await tryAcquireFlock(lockPath);
  assert.ok(lock, '配置正被其他进程修改，请关闭相关进程后离线升级');
  try { return await operation(); } finally { await lock.release(); }
}

export async function upgradeConfig({ configPath, dryRun = false }) {
  const path = await canonicalConfig(configPath);
  if (dryRun) {
    const { before, after } = convert((await read(path)).bytes);
    const lines = ['--- v1', '+++ v2', '- "version": 1', '+ "version": 2'];
    if (own(before, 'authorizedDirectory')) lines.push(`- "authorizedDirectory": ${JSON.stringify(before.authorizedDirectory)}`);
    for (const key of ['authorizedDirectories', 'projectDirectory']) if (!own(before, key) && own(after, key)) lines.push(`+ ${JSON.stringify(key)}: ${JSON.stringify(after[key])}`);
    return { dryRun: true, diff: lines.join('\n') + '\n' };
  }
  return locked(path, async () => {
    const original = await read(path), converted = convert(original.bytes);
    const id = randomUUID(), backupPath = `${path}.v1-${id}.backup`, receiptPath = `${path}.v2-${id}.receipt.json`;
    const receipt = { version: 1, operation: 'config-v1-to-v2', id, configPath: path, backupPath, originalSha256: sha(original.bytes), upgradedSha256: sha(converted.bytes), originalMode: original.mode };
    await writeNew(backupPath, original.bytes);
    // The receipt precedes rename so a lost acknowledgement still leaves a rollback route.
    await writeNew(receiptPath, encoded(receipt));
    await replace(path, converted.bytes, receipt.originalSha256, original.mode);
    return { ...receipt, receiptPath };
  });
}

export async function rollbackConfig({ configPath, receiptPath }) {
  const path = await canonicalConfig(configPath);
  assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath), '--rollback 必须显式指定回执绝对路径');
  return locked(path, async () => {
    const receipt = parse((await read(receiptPath)).bytes);
    assert.ok(receipt.version === 1 && receipt.operation === 'config-v1-to-v2' && receipt.configPath === path, '回执不属于此配置升级');
    assert.ok(typeof receipt.id === 'string' && receipt.backupPath === `${path}.v1-${receipt.id}.backup`, '备份路径与升级回执不符');
    assert.ok(/^[a-f0-9]{64}$/.test(receipt.originalSha256) && /^[a-f0-9]{64}$/.test(receipt.upgradedSha256), '回执 SHA 无效');
    assert.ok(Number.isInteger(receipt.originalMode) && receipt.originalMode >= 0 && receipt.originalMode <= 0o777, '回执权限无效');
    const backup = await read(receipt.backupPath), current = await read(path);
    assert.equal(sha(backup.bytes), receipt.originalSha256, '备份 SHA 不符，未回滚');
    assert.equal(sha(current.bytes), receipt.upgradedSha256, '配置已变化，未回滚');
    const rollbackReceiptPath = `${receiptPath}.${randomUUID()}.rollback.json`;
    await replace(path, backup.bytes, receipt.upgradedSha256, receipt.originalMode);
    const restoredSha256 = sha((await read(path)).bytes);
    assert.equal(restoredSha256, receipt.originalSha256, '回滚后 SHA 不符');
    const result = { version: 1, operation: 'config-v2-to-v1-rollback', configPath: path, upgradeReceiptPath: receiptPath, originalSha256: receipt.originalSha256, restoredSha256, identical: true };
    try { await writeNew(rollbackReceiptPath, encoded(result)); }
    catch (error) { throw new Error('配置已恢复但回滚回执未确认；请核对配置 SHA，勿自动重试', { cause: error }); }
    return { ...result, rollbackReceiptPath };
  });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config') { assert.ok(!options.configPath, '--config 重复'); options.configPath = args[++i]; }
    else if (['--dry-run', '--upgrade', '--rollback'].includes(arg)) {
      assert.ok(!mode, '只允许指定一种操作'); mode = arg;
      if (arg === '--rollback') options.receiptPath = args[++i];
    } else throw new Error(`未知参数：${arg}`);
  }
  assert.ok(mode, '用法：node packages/assistant/scripts/config-upgrade.mjs --config <绝对路径> --dry-run | --upgrade | --rollback <回执绝对路径>');
  const result = mode === '--rollback' ? await rollbackConfig(options) : await upgradeConfig({ ...options, dryRun: mode === '--dry-run' });
  process.stdout.write(result.dryRun ? result.diff : encoded(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
