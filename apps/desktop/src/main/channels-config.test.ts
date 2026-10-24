import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readChannelsConfig } from "./channels-config.js";

it("channel configuration preserves the legacy default and rejects duplicate credentials, writable/workspace files and unknown fields", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-channel-config-")));
  const workspace = join(root, "workspace"), config = join(root, "channels.json"); await mkdir(workspace);
  const account = { platform: "telegram", id: "default", name: "Private", tokenEnv: "TELEGRAM_BOT_TOKEN" };
  const save = async (accounts: unknown[]) => writeFile(config, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
  try {
    assert.equal((await readChannelsConfig({}, workspace))[0]!.id, "default");
    await save([account, { ...account, id: "work", tokenEnv: "WORK_TOKEN" }]);
    const env = { CHANNELS_CONFIG: config, TELEGRAM_BOT_TOKEN: "secret", WORK_TOKEN: "other" };
    assert.equal((await readChannelsConfig(env, workspace)).length, 2);
    await assert.rejects(readChannelsConfig({ ...env, WORK_TOKEN: "secret" }, workspace), /poller/);
    await chmod(config, 0o644); await assert.rejects(readChannelsConfig(env, workspace), /私有/); await chmod(config, 0o600);
    await save([{ ...account, token: "do-not-save" }]); await assert.rejects(readChannelsConfig(env, workspace), /字段/);
    await save([account, account]); await assert.rejects(readChannelsConfig(env, workspace), /重复/);
    const inside = join(workspace, "channels.json"); await writeFile(inside, JSON.stringify({ version: 1, accounts: [account] }), { mode: 0o600 });
    await assert.rejects(readChannelsConfig({ CHANNELS_CONFIG: inside }, workspace), /工作区外/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
