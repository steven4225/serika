import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { TelegramDirectoryAuthorization } from "./telegram-directory-authorization.js";
import type { TelegramInbound } from "./telegram-store.js";
import type { DirectorySettingsInput } from "../shared/ui-contract.js";

type Context = ReturnType<ConstructorParameters<typeof TelegramDirectoryAuthorization>[0]["current"]>;
async function fixture(saveMode: "saved" | "unknown" | "mismatch" = "saved") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-tg-directory-")));
  const context: Context = { idle: true, info: { threadId: "desktop-thread", projectDirectory: root,
    configPath: join(root, "config.json"), authorizedDirectories: [] }, data: { enabled: true, botId: 100,
    owner: { userId: 42, chatId: 42, name: "owner", threadId: "tg-thread" }, deliveries: [] } };
  const sent: string[] = [], saves: DirectorySettingsInput[] = [];
  const helper = new TelegramDirectoryAuthorization({ current: () => structuredClone(context), now: () => 1000,
    save: async input => { saves.push(input); if (saveMode === "unknown") throw new Error("untrusted private error");
      if (saveMode === "saved") context.info.authorizedDirectories = input.directories; },
    send: async (key, chatId, text, keyboard) => { sent.push(text); if (keyboard) context.data.deliveries.push({ key, chatId, text, keyboard,
      state: "submitted", messageId: 7 }); },
  });
  const input = (text: string, callback = false): TelegramInbound => ({ key: `input-${sent.length}`, updateId: sent.length, text,
    state: "received", runId: null, taskId: null, ...(callback ? { callback: { id: "fixture", messageId: 7 } } : {}) });
  const propose = () => helper.handle(input(`授权目录 读写 ${root}`));
  const allow = () => helper.handle(input(`directory_allow ${context.data.deliveries.at(-1)!.key.split(":")[1]}`, true));
  return { root, context, helper, input, propose, allow, sent, saves, cleanup: () => rm(root, { recursive: true, force: true }) };
}

it("directory cards bind selected Thread, owner, bot, project, config and directory list", async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      () => { f.context.info.threadId += "-changed"; },
      () => { f.context.data.owner!.threadId += "-changed"; },
      () => { f.context.data.owner!.userId++; },
      () => { f.context.data.botId!++; },
      () => { f.context.info.projectDirectory += "/changed"; },
      () => { f.context.info.configPath += "-changed"; },
      () => { f.context.info.authorizedDirectories = [{ path: f.root, access: "read" }]; },
      () => { f.context.idle = false; },
      () => { f.context.info.runtimeRecovery = { state: "failed", message: "offline" }; },
    ]) {
      const before = structuredClone(f.context);
      await f.propose(); mutate(); await f.allow();
      assert.equal(f.saves.length, 0); assert.match(f.sent.at(-1)!, /已变化|已过期/);
      Object.assign(f.context, before);
    }
    f.context.idle = false; const cards = f.context.data.deliveries.length;
    await f.propose(); assert.equal(f.context.data.deliveries.length, cards);
    assert.match(f.sent.at(-1)!, /等待当前执行结束/);
  } finally { await f.cleanup(); }
});

for (const mode of ["unknown", "mismatch"] as const) {
  it(`directory ${mode} save consumes the card and never retries or claims saved`, async () => {
    const f = await fixture(mode);
    try {
      await f.propose(); await f.allow();
      assert.equal(f.saves.length, 1); assert.match(f.sent.at(-1)!, /尚未确认|未获确认/);
      assert.doesNotMatch(f.sent.at(-1)!, /已保存|untrusted/);
      await f.allow(); assert.equal(f.saves.length, 1); assert.match(f.sent.at(-1)!, /已处理|已过期/);
    } finally { await f.cleanup(); }
  });
}

it("directory confirmation rejects ancestor replacement before calling save", async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "original"), foreign = join(f.root, "foreign");
    await mkdir(join(parent, "grant"), { recursive: true }); await mkdir(join(foreign, "grant"), { recursive: true });
    await f.helper.handle(f.input(`授权目录 读写 ${join(parent, "grant")}`));
    await rename(parent, join(f.root, "moved")); await symlink(foreign, parent);
    await f.allow(); assert.equal(f.saves.length, 0); assert.match(f.sent.at(-1)!, /目录.*变化|未保存/);
  } finally { await f.cleanup(); }
});
