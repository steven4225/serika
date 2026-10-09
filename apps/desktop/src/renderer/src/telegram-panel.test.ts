import assert from "node:assert/strict";
import { it } from "node:test";
import { telegramConnectionLabel } from "./telegram-panel.js";
import { telegramUnavailable } from "../../shared/telegram.js";

it("does not present missing host, corrupt status or pending connection as a ready Telegram account", () => {
  const base = { ...telegramUnavailable(), available: true, lastError: null };
  assert.match(telegramConnectionLabel(null), /正在读取/);
  assert.match(telegramConnectionLabel(telegramUnavailable()), /常驻助手/);
  assert.equal(telegramConnectionLabel(base), "Telegram 未开启");
  assert.match(telegramConnectionLabel({ ...base, lastError: "bad file", connection: "failed" }), /需核对/);
  assert.equal(telegramConnectionLabel({ ...base, enabled: true, connection: "connecting" }), "正在连接 Telegram");
  assert.equal(telegramConnectionLabel({ ...base, enabled: true, connection: "failed" }), "Telegram 连接失败");
  assert.equal(telegramConnectionLabel({ ...base, enabled: true, connection: "online" }), "Telegram 已连接");
});
