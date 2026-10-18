import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "undici";
import { createOneBotApi, OneBotError } from "./onebot-api.js";

class Socket extends EventTarget {
  readyState = 1;
  sent: { action: string; params: unknown; echo: string }[] = [];
  stall = false;
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(text: string) {
    const value = JSON.parse(text) as typeof this.sent[number]; this.sent.push(value);
    if (this.stall && value.action !== "get_login_info") return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ status: "ok", retcode: 0,
      data: value.action === "get_login_info" ? { user_id: 100 } : { message_id: -123 }, echo: value.echo }) })));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
it("OneBot uses a header token, validates login, correlates echo and accepts signed message IDs", async () => {
  let socket!: Socket, endpoint = "", credential = "";
  const api = createOneBotApi("ws://127.0.0.1:3001/", "secret", (url, token) => { endpoint = url; credential = token; return (socket = new Socket()) as unknown as WebSocket; });
  const events: unknown[] = [];
  try {
    assert.equal(await api.connect(value => events.push(value), () => {}), 100);
    assert.equal(endpoint, "ws://127.0.0.1:3001/"); assert.equal(credential, "secret");
    assert.equal(await api.send(200, [{ type: "text", data: { text: "[CQ:at,qq=all]" } }]), -123);
    assert.deepEqual(socket.sent[1]!.params, { group_id: 200, message: [{ type: "text", data: { text: "[CQ:at,qq=all]" } }] });
    assert.equal(socket.sent.length, 2);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ post_type: "message", message_type: "group" }) }));
    assert.equal(events.length, 1);
  } finally { api.close(); }
});
it("OneBot timeouts and disconnection are unknown without a send retry", async () => {
  let socket!: Socket, disconnected = 0;
  const api = createOneBotApi("ws://127.0.0.1:3001/", "secret", () => (socket = new Socket()) as unknown as WebSocket, 25);
  try {
    await api.connect(() => {}, () => { disconnected++; }); socket.stall = true;
    await assert.rejects(api.send(200, []), error => error instanceof OneBotError && error.outcome === "unknown");
    const pending = api.send(200, []);
    socket.close();
    await assert.rejects(pending, error => error instanceof OneBotError && error.outcome === "unknown");
    assert.equal(socket.sent.filter(x => x.action === "send_group_msg").length, 2); assert.equal(disconnected, 1);
    await assert.rejects(api.send(200, []), error => error instanceof OneBotError && error.outcome === "not_sent");
  } finally { api.close(); }
});
it("OneBot rejects credential-bearing URLs, cleartext remote endpoints and missing tokens", () => {
  for (const endpoint of ["ws://example.com/", "wss://example.com/?access_token=secret", "wss://user:secret@example.com/", "ws://localhost/api"]) {
    assert.throws(() => createOneBotApi(endpoint, "secret"));
  }
  assert.throws(() => createOneBotApi("ws://localhost/", ""));
});
it("OneBot performs a real loopback WebSocket handshake with header authentication and API frames", async () => {
  let peer: Duplex | undefined, authorization: string | undefined, requests = 0;
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    peer = socket; authorization = request.headers.authorization;
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered: Buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        if ((buffered[0]! & 0x0f) === 8) { socket.end(); return; }
        let length = buffered[1]! & 0x7f, start = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); start = 4; }
        if (buffered.length < start + 4 + length) return;
        const mask = buffered.subarray(start, start + 4), payload = Buffer.from(buffered.subarray(start + 4, start + 4 + length));
        for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
        buffered = buffered.subarray(start + 4 + length);
        const value = JSON.parse(payload.toString()) as { action: string; echo: string }; requests++;
        const body = Buffer.from(JSON.stringify({ status: "ok", retcode: 0, echo: value.echo, data: value.action === "get_login_info" ? { user_id: 100 } : { message_id: 123 } }));
        const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = createOneBotApi(`ws://127.0.0.1:${address.port}/`, "private-test-token");
  try {
    assert.equal(await api.connect(() => {}, () => {}), 100);
    assert.equal(await api.send(200, [{ type: "text", data: { text: "local test only" } }]), 123);
    assert.equal(authorization, "Bearer private-test-token"); assert.equal(requests, 2);
  } finally {
    api.close(); peer?.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
