import assert from 'node:assert/strict';
import { readFile, mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { tryAcquireFlock } from '@serika/assistant';

export const defaultTelegramTestEnv = join(homedir(), '.config/serika/chat-run-target-telegram-test.env');
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const positive = value => { const n = Number(value); assert.ok(Number.isSafeInteger(n) && n > 0, 'Test Bot and owner IDs must be positive integers'); return n; };
async function unaliased(path) {
  let existing = path;
  while (true) {
    try { assert.equal((await lstat(existing)).isSymbolicLink(), false, 'Test paths must not use symlinks'); assert.equal(await realpath(existing), existing, 'Test paths must not use parent aliases'); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = dirname(existing); }
  }
}

export function telegramTestSettings({ source, envFile, forbiddenBotId }) {
  const required = ['SERIKA_TG_TEST_ONLY', 'SERIKA_TG_TEST_BOT_ID', 'SERIKA_TG_TEST_OWNER_USER_ID', 'SERIKA_TG_TEST_OWNER_CHAT_ID', 'TELEGRAM_BOT_TOKEN', 'COMMAND_CODE_BASE_URL', 'COMMAND_CODE_MODEL_ID', 'COMMAND_CODE_API_KEY'];
  const missing = required.filter(key => !source[key]);
  assert.ok(!missing.length, `Missing test env fields: ${missing.join(', ')}`);
  assert.equal(source.SERIKA_TG_TEST_ONLY, '1', 'Explicit SERIKA_TG_TEST_ONLY=1 is required');
  const botId = positive(source.SERIKA_TG_TEST_BOT_ID), userId = positive(source.SERIKA_TG_TEST_OWNER_USER_ID), chatId = positive(source.SERIKA_TG_TEST_OWNER_CHAT_ID);
  assert.notEqual(botId, forbiddenBotId, 'The historical day-use Bot is forbidden for this test');
  assert.equal(Number(source.TELEGRAM_BOT_TOKEN?.split(':')[0]), botId, 'Token identity must match SERIKA_TG_TEST_BOT_ID');
  assert.ok(source.COMMAND_CODE_BASE_URL === 'https://api.commandcode.ai/provider/v1', 'Unsupported test model endpoint');
  assert.ok(source.COMMAND_CODE_MODEL_ID === 'deepseek/deepseek-v4.1-flash-fast', 'Unsupported test model');
  assert.ok(source.COMMAND_CODE_API_KEY && source.TELEGRAM_BOT_TOKEN, 'Test model and Bot credentials are required');
  const profileRoot = resolve(source.SERIKA_TG_TEST_PROFILE_ROOT || join(homedir(), '.serika-test/chat-run-target-telegram'));
  const runtimeRoot = resolve(source.SERIKA_TG_TEST_RUNTIME_ROOT || '/private/tmp/s197-tg');
  assert.ok(inside(join(homedir(), '.serika-test'), profileRoot) || inside('/private/tmp', profileRoot), 'Profile must be an isolated test path');
  assert.ok(inside('/private/tmp', runtimeRoot), 'Runtime must be isolated under /private/tmp');
  assert.ok(profileRoot !== runtimeRoot && !inside(runtimeRoot, profileRoot) && !inside(profileRoot, runtimeRoot), 'Persistent profile and disposable runtime must be separate');
  return { envFile, botId, owner: { userId, chatId }, profileRoot, runtimeRoot,
    applicationHome: join(profileRoot, 'profile'), configPath: join(profileRoot, 'config.json'), workspace: join(runtimeRoot, 'herdr-fixture/workspace'),
    credentials: { key: source.COMMAND_CODE_API_KEY, base: source.COMMAND_CODE_BASE_URL, telegram: source.TELEGRAM_BOT_TOKEN, proxy: source.TELEGRAM_PROXY_URL } };
}

export async function loadTelegramTestSettings({ envFile, forbiddenBotId }) {
  envFile = resolve(envFile);
  assert.ok(!envFile.includes('/.config/serika/v2-daily.env'), 'The day-use env is forbidden');
  const stat = await lstat(envFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'Test env must be a private regular file');
  assert.equal(await realpath(envFile), envFile, 'Test env must not use symlink aliases');
  return telegramTestSettings({ source: parseEnv(await readFile(envFile, 'utf8')), envFile, forbiddenBotId });
}

export async function prepareTelegramTestProfile(settings) {
  for (const path of [settings.profileRoot, settings.runtimeRoot, settings.applicationHome, settings.configPath, join(settings.profileRoot, 'harness.lock')]) await unaliased(path);
  await mkdir(settings.profileRoot, { recursive: true, mode: 0o700 });
  const stat = await lstat(settings.profileRoot);
  assert.ok(!(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid()), 'Test profile must be private and owned by this user');
  const lease = await tryAcquireFlock(join(settings.profileRoot, 'harness.lock'));
  assert.ok(lease, 'Another test host owns this profile');
  try {
    await mkdir(settings.runtimeRoot, { mode: 0o700 });
    return lease;
  } catch (error) { await lease.release(); throw error; }
}

export async function writeTelegramTestConfig({ settings, model }) {
  const value = { version: 2, projectDirectory: settings.workspace, authorizedDirectories: [{ path: settings.workspace, access: 'readwrite' }],
    modules: { 'read-file': { enabled: true }, shell: { enabled: false }, terminal: { enabled: true }, memory: { enabled: false } },
    run: { maxSteps: 16, totalTimeoutMs: 600000 }, contextCompaction: { enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096, safetyMarginTokens: 2048, keepRecentTokens: 8192, summaryMaxOutputTokens: 2048 },
    modelContextWindows: [{ provider: 'openai-compatible.chat', modelId: model, contextWindowTokens: 32768 }] };
  await unaliased(settings.configPath);
  try {
    const stat = await lstat(settings.configPath);
    assert.ok(stat.isFile() && !(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid()), 'Existing test config must be a private owned regular file');
    assert.deepEqual(JSON.parse(await readFile(settings.configPath, 'utf8')), value, 'Existing test config changed; stop instead of replacing it');
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(settings.configPath, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); }
}

export function inspectTelegramTestStore({ data, settings }) {
  assert.equal(data.enabled, false, 'Previous test channel was not disabled; reconcile before restart');
  assert.ok(data.inputs.every(row => ['finished', 'rejected', 'reviewed'].includes(row.state)), 'Unsettled test inputs require review');
  assert.ok(data.deliveries.every(row => ['submitted', 'cancelled'].includes(row.state)), 'Unsettled test deliveries require review');
  assert.ok(!data.routes.length, 'Test profile must not contain scheduled routes');
  if (data.owner) {
    assert.equal(data.botId, settings.botId); assert.equal(data.owner.userId, settings.owner.userId); assert.equal(data.owner.chatId, settings.owner.chatId);
  } else assert.ok(data.botId === null || data.botId === settings.botId);
  return { owner: data.owner, offset: data.offset, inputKeys: data.inputs.map(row => row.key), deliveryKeys: data.deliveries.map(row => row.key) };
}
