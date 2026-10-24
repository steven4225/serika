import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tryAcquireFlock } from '../dist/flock.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./config-upgrade.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'serika-config-upgrade-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const original = Buffer.from(JSON.stringify({ version: 1, modules: {}, authorizedDirectory: join(directory, 'project'), desktopAutonomy: { authorizedDirectory: 'desktop-binding' }, telegramAutonomy: { authorizedDirectory: 'telegram-binding', botId: 1, userId: 2, chatId: 3, threadId: 'test' }, modelContextWindows: [{ provider: 'TEST_SECRET_NOT_FOR_DIFF', modelId: 'test-model', contextWindowTokens: 32768 }] }, null, 4) + '\n\n');
  await writeFile(configPath, original, { mode: 0o640 });
  await chmod(configPath, 0o640);
  const cli = async (...args) => exec(process.execPath, [script, '--config', configPath, ...args]);
  return { directory, configPath, original, cli };
}

test('offline CLI dry-run, exact-byte backup, upgrade and SHA-proven rollback preserve other settings', async t => {
  const f = await fixture(t);
  const preview = await f.cli('--dry-run');
  assert.match(preview.stdout, /- "authorizedDirectory"/);
  assert.match(preview.stdout, /\+ "authorizedDirectories"/);
  assert.doesNotMatch(preview.stdout, /TEST_SECRET|desktop-binding|telegram-binding/);
  assert.deepEqual(await readFile(f.configPath), f.original);
  assert.deepEqual(await readdir(f.directory), ['config.json']);
  const receipt = JSON.parse((await f.cli('--upgrade')).stdout);
  assert.deepEqual(await readFile(receipt.backupPath), f.original);
  const upgraded = JSON.parse(await readFile(f.configPath, 'utf8'));
  const before = JSON.parse(f.original);
  assert.equal(upgraded.version, 2);
  assert.equal(Object.hasOwn(upgraded, 'authorizedDirectory'), false);
  assert.deepEqual(upgraded.authorizedDirectories, [{ path: before.authorizedDirectory, access: 'readwrite' }]);
  assert.equal(upgraded.projectDirectory, before.authorizedDirectory);
  for (const key of ['desktopAutonomy', 'telegramAutonomy', 'modelContextWindows']) assert.deepEqual(upgraded[key], before[key]);
  assert.equal(receipt.originalSha256, sha(f.original));
  assert.equal(receipt.upgradedSha256, sha(await readFile(f.configPath)));
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o640);
  assert.equal((await stat(receipt.backupPath)).mode & 0o777, 0o600);
  const rollback = JSON.parse((await f.cli('--rollback', receipt.receiptPath)).stdout);
  assert.deepEqual(await readFile(f.configPath), f.original);
  assert.equal(rollback.originalSha256, rollback.restoredSha256);
  assert.equal(rollback.restoredSha256, sha(f.original));
  assert.equal(JSON.parse(await readFile(rollback.rollbackReceiptPath, 'utf8')).identical, true);
  await assert.rejects(f.cli('--rollback', receipt.receiptPath), /配置已变化/);
});

test('rollback refuses changed configuration and corrupted backup without overwriting', async t => {
  const f = await fixture(t);
  const receipt = JSON.parse((await f.cli('--upgrade')).stdout);
  const upgraded = await readFile(f.configPath);
  await writeFile(f.configPath, Buffer.concat([upgraded, Buffer.from(' ')]));
  await assert.rejects(f.cli('--rollback', receipt.receiptPath), /配置已变化/);
  assert.equal(sha(await readFile(f.configPath)), sha(Buffer.concat([upgraded, Buffer.from(' ')])));
  await writeFile(f.configPath, upgraded);
  await writeFile(receipt.backupPath, 'corrupted-test-backup');
  await assert.rejects(f.cli('--rollback', receipt.receiptPath), /备份 SHA 不符/);
  assert.deepEqual(await readFile(f.configPath), upgraded);
});

test('upgrade refuses ambiguous format and a held cooperating config lock', async t => {
  const f = await fixture(t);
  const lock = await tryAcquireFlock(`${f.configPath}.lock`);
  assert.ok(lock);
  try { await assert.rejects(f.cli('--upgrade'), /配置正被其他进程修改/); }
  finally { await lock.release(); }
  assert.deepEqual(await readFile(f.configPath), f.original);
  await writeFile(f.configPath, JSON.stringify({ version: 1, authorizedDirectory: '/test', authorizedDirectories: [] }));
  await assert.rejects(f.cli('--upgrade'), /同时包含旧版授权和新版目录字段/);
  await writeFile(f.configPath, '{"version":2}');
  await assert.rejects(f.cli('--upgrade'), /仅支持显式升级 v1/);
  await assert.rejects(exec(process.execPath, [script, '--dry-run']), /--config 必须显式指定绝对路径/);
});


test('null grants stay empty and existing b2 declarations preserve permissions and base exactly', async t => {
  const f = await fixture(t);
  for (const config of [{ version: 1, modules: {}, authorizedDirectory: null }, { version: 1, modules: {}, authorizedDirectories: [{ path: '/fixture/read', access: 'read' }, { path: '/fixture/write', access: 'readwrite' }], projectDirectory: null }]) {
    await writeFile(f.configPath, JSON.stringify(config));
    const receipt = JSON.parse((await f.cli('--upgrade')).stdout);
    const next = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.deepEqual(next, Object.hasOwn(config, 'authorizedDirectories') ? { ...config, version: 2 } : { version: 2, modules: {}, authorizedDirectories: [], projectDirectory: null });
    const rollback = JSON.parse((await f.cli('--rollback', receipt.receiptPath)).stdout);
    assert.equal(rollback.originalSha256, rollback.restoredSha256);
  }
});
