import { it } from "node:test";
import assert from "node:assert/strict";
import { getGlobalDispatcher, ProxyAgent } from "undici";
import { createTelegramApi, TelegramApiError } from "./telegram-api.js";

const token = "123:THIS_IS_A_PRIVATE_TEST_TOKEN";

it("Telegram proxy is channel-scoped, shared by polling and sending, and never retries ambiguous sends", async () => {
  const global = getGlobalDispatcher();
  const seen: unknown[] = [];
  let sends = 0;
  const api = createTelegramApi(token, async (url, init) => {
    seen.push((init as RequestInit & { dispatcher?: unknown }).dispatcher);
    if (String(url).endsWith("sendMessage")) { sends++; throw new Error(`private proxy failure ${url}`); }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }, { proxyUrl: "http://127.0.0.1:7897" });
  try {
    await api.updates(0, new AbortController().signal);
    await assert.rejects(api.send(42, "hello", new AbortController().signal), error =>
      error instanceof TelegramApiError && error.outcome === "unknown" && !error.message.includes(token));
    assert.ok(seen[0] instanceof ProxyAgent);
    assert.equal(seen[0], seen[1]);
    assert.equal(getGlobalDispatcher(), global);
    assert.equal(sends, 1);
  } finally { await api.close?.(); }
});

it("direct mode has no scoped dispatcher; malformed proxy fails without leaking credentials", async () => {
  const api = createTelegramApi(token, async (_url, init) => {
    assert.equal("dispatcher" in init!, false);
    return new Response(JSON.stringify({ ok: true, result: { id: 123, username: "demo" } }));
  });
  assert.equal((await api.identity(new AbortController().signal)).username, "demo");
  await api.close?.();
  for (const proxyUrl of ["socks5://secret@localhost:7897", "http://localhost:7897/path", "http://localhost:7897/?key=private", "not a url"]) {
    assert.throws(() => createTelegramApi(token, fetch, { proxyUrl }), error =>
      error instanceof Error && error.message.includes("TELEGRAM_PROXY_URL") && !error.message.includes(proxyUrl));
  }
});
