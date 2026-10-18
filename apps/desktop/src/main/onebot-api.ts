import { randomUUID } from "node:crypto";
import { WebSocket } from "undici";

export type OneBotSegment = { type: string; data: Record<string, unknown> };
export interface OneBotApi {
  connect(receive: (event: unknown) => void, disconnected: () => void): Promise<number>;
  send(groupId: number, message: OneBotSegment[]): Promise<number>;
  close(): void;
}
export class OneBotError extends Error {
  constructor(readonly outcome: "not_sent" | "unknown") {
    super(outcome === "unknown" ? "QQ 请求结果未知，不会自动重发。" : "QQ 请求未提交或已被拒绝。");
  }
}
type Socket = Pick<WebSocket, "addEventListener" | "close" | "send" | "readyState">;

/** Forward OneBot v11 WebSocket, one request per invocation; never retry sends. */
export function createOneBotApi(endpoint: string, token: string,
  socketFactory: (url: string, token: string) => Socket = (url, credential) => new WebSocket(url, { headers: { Authorization: `Bearer ${credential}` } }),
  timeoutMs = 15_000): OneBotApi {
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("QQ OneBot 地址须为本机 ws:// 或可信 wss:// 的根路径，不能携带凭据。");
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error("请在外部环境文件配置 QQ_ACCESS_TOKEN。");
  let socket: Socket | undefined, stopped = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: OneBotError): void }>();
  const fail = () => { for (const item of pending.values()) item.reject(new OneBotError("unknown")); pending.clear(); };
  async function call(action: string, params: unknown): Promise<unknown> {
    if (stopped || socket?.readyState !== WebSocket.OPEN) throw new OneBotError("not_sent");
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(new OneBotError("unknown")); }, timeoutMs);
      const finish = () => { clearTimeout(timer); pending.delete(echo); };
      pending.set(echo, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
      try { socket!.send(JSON.stringify({ action, params, echo })); }
      catch { finish(); reject(new OneBotError("unknown")); }
    });
  }
  return {
    async connect(receive, disconnected) {
      if (socket || stopped) throw new OneBotError("not_sent");
      try { socket = socketFactory(url.href, token); } catch { throw new OneBotError("not_sent"); }
      socket.addEventListener("message", event => {
        if (stopped || typeof event.data !== "string" || Buffer.byteLength(event.data) > 128 * 1024) return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        if (typeof value.echo === "string" && pending.has(value.echo)) {
          const item = pending.get(value.echo)!;
          if (value.status === "ok" && value.retcode === 0) item.resolve(value.data);
          // Internal/upstream failures may follow dispatch. Only argument/auth/route
          // rejection codes establish non-dispatch; async/malformed results stay unknown.
          else item.reject(new OneBotError(value.status === "failed" && [100, 1400, 1401, 1403, 1404].includes(value.retcode as number) ? "not_sent" : "unknown"));
        } else if (typeof value.post_type === "string") receive(value);
      });
      const lost = () => { if (stopped) return; stopped = true; fail(); disconnected(); try { socket?.close(); } catch { /* already lost */ } };
      socket.addEventListener("close", lost);
      socket.addEventListener("error", lost);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new OneBotError("not_sent")); lost(); }, timeoutMs);
        socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        const rejectOpen = () => { clearTimeout(timer); reject(new OneBotError("not_sent")); };
        socket!.addEventListener("error", rejectOpen, { once: true });
        socket!.addEventListener("close", rejectOpen, { once: true });
      });
      const login = await call("get_login_info", {}) as { user_id?: unknown } | null;
      if (!Number.isSafeInteger(login?.user_id) || (login!.user_id as number) <= 0) throw new OneBotError("unknown");
      return login!.user_id as number;
    },
    async send(groupId, message) {
      const result = await call("send_group_msg", { group_id: groupId, message }) as { message_id?: unknown } | null;
      if (!Number.isSafeInteger(result?.message_id)) throw new OneBotError("unknown");
      return result!.message_id as number;
    },
    close() { stopped = true; fail(); try { socket?.close(); } catch { /* already closed */ } },
  };
}
