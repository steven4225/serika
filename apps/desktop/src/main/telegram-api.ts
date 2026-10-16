import { ProxyAgent, type Dispatcher } from "undici";

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; date: number; chat: { id: number; type: string };
    from?: { id: number; is_bot: boolean; first_name: string; username?: string }; text?: string; forward_origin?: unknown; via_bot?: unknown };
  callback_query?: { id: string; from: { id: number; is_bot: boolean; first_name: string }; data?: string;
    message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number; is_bot: boolean; first_name: string } } };
}
export interface TelegramKeyboard { inline_keyboard: { text: string; callback_data: string }[][] }
export class TelegramApiError extends Error {
  constructor(readonly code: string, readonly outcome: "not_sent" | "unknown", readonly retryAfter = 0) {
    super(code === "NETWORK" ? "Telegram 网络请求未确认；不会重发可能已提交的消息。" : `Telegram 请求失败（${code}）。`);
  }
}
export interface TelegramApi {
  identity(signal: AbortSignal): Promise<{ id: number; username: string }>;
  webhook(signal: AbortSignal): Promise<{ url: string }>;
  updates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  send(chatId: number, text: string, signal: AbortSignal, format?: "HTML", keyboard?: TelegramKeyboard): Promise<number>;
  answerCallback(id: string, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}
/** One request per call, no hidden retry. Never surface fetch errors containing token URLs. */
export function createTelegramApi(token: string, request: typeof fetch = fetch, options: { proxyUrl?: string } = {}): TelegramApi {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN 格式无效，请在可信环境文件中配置。");
  let dispatcher: Dispatcher | undefined;
  if (options.proxyUrl?.trim()) {
    try {
      const proxy = new URL(options.proxyUrl.trim());
      if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error("invalid proxy");
      dispatcher = new ProxyAgent(proxy.href);
    } catch { throw new Error("TELEGRAM_PROXY_URL 格式无效，请配置 HTTP/HTTPS 代理地址；不会回退直连。"); }
  }
  async function call<T>(method: string, body: unknown, signal: AbortSignal, timeout = 15_000): Promise<T> {
    let response: Response;
    try {
      // Scoped to this channel: never change the global dispatcher/model transport.
      const init: RequestInit & { dispatcher?: Dispatcher } = { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), ...(dispatcher ? { dispatcher } : {}) };
      response = await request(`https://api.telegram.org/bot${token}/${method}`, init);
    } catch { throw new TelegramApiError("NETWORK", "unknown"); }
    let value: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
    try { value = await response.json() as typeof value; }
    catch { throw new TelegramApiError("INVALID_RESPONSE", "unknown"); }
    if (!response.ok || value.ok !== true) {
      // A well-formed Bot API rejection proves non-submission. Proxy/5xx errors do not.
      const code = value.error_code;
      throw new TelegramApiError(String(code ?? response.status), value.ok === false && code !== undefined && code < 500 ? "not_sent" : "unknown",
        Math.min(300, Math.max(0, value.parameters?.retry_after ?? 0)));
    }
    return value.result as T;
  }
  return {
    close: async () => { await dispatcher?.close(); },
    identity: signal => call("getMe", {}, signal),
    webhook: signal => call("getWebhookInfo", {}, signal),
    updates: (offset, signal) => call("getUpdates", { offset, timeout: 30, limit: 50, allowed_updates: ["message", "callback_query"] }, signal, 40_000),
    answerCallback: async (id, signal) => { await call("answerCallbackQuery", { callback_query_id: id }, signal); },
    send: async (chatId, text, signal, format, keyboard) => {
      // New formatted parts are bounded before durable admission. Legacy plain sends retain their policy.
      if (format && (!text || text.length > 4096)) throw new TelegramApiError("INVALID_PART", "not_sent");
      const result = await call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: format ? text : text.length > 4000 ? `${text.slice(0, 3900)}\n[已截断；完整内容见桌面执行记录]` : text,
        ...(format ? { parse_mode: format } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true } }, signal);
      if (!Number.isSafeInteger(result?.message_id)) throw new TelegramApiError("INVALID_RESPONSE", "unknown");
      return result.message_id;
    },
  };
}
