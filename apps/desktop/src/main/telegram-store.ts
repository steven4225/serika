import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TelegramStatus } from "../shared/telegram.js";
import type { TelegramKeyboard } from "./telegram-api.js";
import { EXECUTION_RECORD_MAX_TOOLS } from "@serika/example-cli";

export const TELEGRAM_INPUT_LIMIT = 1024;
export const TELEGRAM_DELIVERY_LIMIT = 2048;

export interface TelegramInbound {
  key: string; updateId: number; text: string;
  /** Host receipt clock. Legacy records may omit it; never invent it on read. */
  receivedAt?: string;
  /** Button identity, persisted before control dispatch. Never restored as authorization. */
  callback?: { id: string; messageId: number };
  /** Program-generated reminder receipts, not model success claims. */
  reminderReceipts?: { toolCallId: string; text: string }[];
  state: "received" | "reserved" | "bound" | "finished" | "rejected" | "unknown" | "reviewed";
  runId: string | null; taskId: string | null;
  reviewReport?: string;
}
export interface TelegramDelivery {
  key: string; chatId: number; text: string; state: "pending" | "sending" | "submitted" | "failed" | "unknown" | "cancelled";
  messageId: number | null;
  routeKey?: string;
  error?: string;
  retryAt?: string;
  reviewReport?: string;
  keyboard?: TelegramKeyboard;
  /** Optional for old journals. Each formatted part has its own persisted dispatch/ack boundary. */
  parts?: { text: string; state: "pending" | "sending" | "submitted" | "failed" | "unknown"; messageId: number | null }[];
}
export interface TelegramTaskRoute {
  key: string; id: string; kind: "once" | "recurring"; chatId: number; userId: number;
  /** Existing recurring history before opt-in is never externalized. */
  fromRunAt: string;
  sourceKey?: string; sourceRunId?: string;
  scanBefore?: { createdAt: string; id: string };
}
export interface TelegramData {
  version: 1 | 2; workspace: string; enabled: boolean; botId: number | null; offset: number;
  owner: TelegramStatus["owner"]; inputs: TelegramInbound[]; deliveries: TelegramDelivery[];
  routes: TelegramTaskRoute[];
}
const archivalInput = (input: TelegramInbound, offset: number) => ["finished", "rejected", "reviewed"].includes(input.state) && input.updateId < offset;
const archivalDelivery = (delivery: TelegramDelivery) => delivery.state === "submitted" || delivery.state === "cancelled" || delivery.state === "unknown" && !!delivery.reviewReport;
export function telegramCapacity(data: TelegramData): NonNullable<TelegramStatus["capacity"]> {
  return { inputs: data.inputs.length, inputLimit: TELEGRAM_INPUT_LIMIT,
    deliveries: data.deliveries.length, deliveryLimit: TELEGRAM_DELIVERY_LIMIT,
    blocked: data.inputs.length >= TELEGRAM_INPUT_LIMIT && !data.inputs.some(x => archivalInput(x, data.offset)) ||
      data.deliveries.length >= TELEGRAM_DELIVERY_LIMIT && !data.deliveries.some(archivalDelivery) };
}
function valid(data: TelegramData, workspace: string) {
  const positive = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  return [1, 2].includes(data?.version) && data.workspace === workspace && typeof data.enabled === "boolean" &&
    (data.botId === null || positive(data.botId)) && Number.isSafeInteger(data.offset) && data.offset >= 0 &&
    (data.owner === null || (positive(data.owner.userId) && positive(data.owner.chatId) && typeof data.owner.name === "string" && typeof data.owner.threadId === "string" && !!data.owner.threadId)) &&
    Array.isArray(data.inputs) && data.inputs.length <= TELEGRAM_INPUT_LIMIT && new Set(data.inputs.map(x => x.key)).size === data.inputs.length && data.inputs.every(x =>
      typeof x.key === "string" && typeof x.text === "string" && x.text.length <= 16_384 && positive(x.updateId + 1) &&
      (x.receivedAt === undefined || typeof x.receivedAt === "string" && /\+08:00$/.test(x.receivedAt) && Number.isFinite(Date.parse(x.receivedAt))) &&
      (x.callback === undefined || typeof x.callback.id === "string" && x.callback.id.length > 0 && x.callback.id.length <= 256 && positive(x.callback.messageId)) &&
      (x.reminderReceipts === undefined || Array.isArray(x.reminderReceipts) && x.reminderReceipts.length <= EXECUTION_RECORD_MAX_TOOLS &&
        new Set(x.reminderReceipts.map(receipt => receipt.toolCallId)).size === x.reminderReceipts.length &&
        x.reminderReceipts.every(receipt => typeof receipt.toolCallId === "string" && receipt.toolCallId.length > 0 && receipt.toolCallId.length <= 256 &&
          typeof receipt.text === "string" && receipt.text.length > 0 && receipt.text.length <= 12_000)) &&
      ["received", "reserved", "bound", "finished", "rejected", "unknown", "reviewed"].includes(x.state) && (x.runId === null || typeof x.runId === "string") && (x.taskId === null || typeof x.taskId === "string") &&
      (x.reviewReport === undefined || (typeof x.reviewReport === "string" && x.reviewReport.length > 0 && x.reviewReport.length <= 2000))) &&
    Array.isArray(data.deliveries) && data.deliveries.length <= TELEGRAM_DELIVERY_LIMIT && new Set(data.deliveries.map(x => x.key)).size === data.deliveries.length && data.deliveries.every(x =>
      typeof x.key === "string" && positive(x.chatId) && typeof x.text === "string" && x.text.length <= 32_768 &&
      ["pending", "sending", "submitted", "failed", "unknown", "cancelled"].includes(x.state) && (x.messageId === null || positive(x.messageId)) &&
      (x.keyboard === undefined || x.key.startsWith("approval:") && Array.isArray(x.keyboard.inline_keyboard) && x.keyboard.inline_keyboard.length === 1 &&
        x.keyboard.inline_keyboard.every(row => Array.isArray(row) && row.length === 2 && row.every(button => typeof button.text === "string" && button.text.length > 0 && button.text.length <= 32 &&
          typeof button.callback_data === "string" && /^(allow|deny):[A-F0-9]{10}$/.test(button.callback_data)))) &&
      (x.parts === undefined || data.version === 2 && Array.isArray(x.parts) && x.parts.length > 0 && x.parts.length <= 128 &&
        x.parts.every((part, i) => typeof part.text === "string" && part.text.length > 0 && part.text.length <= 4096 &&
          ["pending", "sending", "submitted", "failed", "unknown"].includes(part.state) &&
          (part.state === "submitted" ? positive(part.messageId) : part.messageId === null) &&
          (i === 0 || part.state !== "submitted" || x.parts![i - 1]!.state === "submitted") &&
          (["pending", "submitted"].includes(part.state) ||
            (i === 0 || x.parts![i - 1]!.state === "submitted") && x.parts!.slice(i + 1).every(part => part.state === "pending"))) &&
        (!["pending", "sending", "failed"].includes(x.state) || x.parts.every(part => part.state !== "unknown" &&
          (part.state !== "sending" || x.state === "sending") && (part.state !== "failed" || x.state === "failed"))) &&
        (x.state !== "submitted" || x.parts.every(part => part.state === "submitted"))) &&
      (x.routeKey === undefined || typeof x.routeKey === "string") && (x.reviewReport === undefined || typeof x.reviewReport === "string" && x.reviewReport.trim().length > 0 && x.reviewReport.length <= 2000) && (x.error === undefined || typeof x.error === "string" && x.error.length <= 512) &&
      (x.retryAt === undefined || typeof x.retryAt === "string" && Number.isFinite(Date.parse(x.retryAt)))) &&
    Array.isArray(data.routes) && data.routes.length <= 128 && new Set(data.routes.map(x => x.key)).size === data.routes.length && data.routes.every(x =>
      typeof x.id === "string" && !!x.id && ["once", "recurring"].includes(x.kind) && x.key === `${x.kind}:${x.id}` &&
      positive(x.chatId) && positive(x.userId) && x.chatId === data.owner?.chatId && x.userId === data.owner?.userId &&
      typeof x.fromRunAt === "string" && Number.isFinite(Date.parse(x.fromRunAt)) &&
      (x.scanBefore === undefined || (typeof x.scanBefore.id === "string" && !!x.scanBefore.id && typeof x.scanBefore.createdAt === "string" && Number.isFinite(Date.parse(x.scanBefore.createdAt)))) &&
      (x.sourceKey === undefined || typeof x.sourceKey === "string" && typeof x.sourceRunId === "string" && !!x.sourceRunId));
}
/** Single resident owner, serial writes. A failed/uncertain write freezes further admission. */
export class TelegramStore {
  #data!: TelegramData;
  #tail: Promise<unknown> = Promise.resolve();
  #failed = false;
  constructor(readonly path: string, readonly workspace: string) {}
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(this.path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error("Telegram 状态目录权限不安全");
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16 * 1024 * 1024) throw new Error("Telegram 状态权限或大小无效");
      this.#data = JSON.parse(await readFile(this.path, "utf8")) as TelegramData;
      // Older channel journals have no destinations: this does not opt anything in.
      if (this.#data.routes === undefined) this.#data.routes = [];
      if (!valid(this.#data, this.workspace)) throw new Error("Telegram 状态无效，不会重新绑定或猜测执行结果");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#data = { version: 1, workspace: this.workspace, enabled: false, botId: null, offset: 0, owner: null, inputs: [], deliveries: [], routes: [] };
    }
  }
  snapshot() { return structuredClone(this.#data); }
  #archivePath(kind: "inputs" | "deliveries", key: string) {
    return join(dirname(this.path), "telegram-archive", kind, createHash("sha256").update(key).digest("hex") + ".json");
  }
  async #archive(kind: "inputs" | "deliveries", record: TelegramInbound | TelegramDelivery) {
    const path = this.#archivePath(kind, record.key), directory = dirname(path);
    for (const parent of [dirname(directory), directory]) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Telegram 归档目录权限不安全");
    }
    // The original task/Run remains the result source. Long-term channel
    // archives retain deduplication/association, not a second copy of its body.
    const { text: _body, ...metadata } = record;
    if ("reminderReceipts" in metadata) delete metadata.reminderReceipts;
    if ("keyboard" in metadata) delete metadata.keyboard;
    const text = JSON.stringify({ ...metadata, ...("parts" in record && record.parts
      ? { parts: record.parts.map(({ text: _partBody, ...part }) => part) } : {}) });
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) || (process.getuid && existing.uid !== process.getuid()) || existing.size > 128 * 1024) throw new Error("Telegram 归档冲突；未丢弃活动记录");
      const stored = JSON.parse(await readFile(path, "utf8")); delete stored.text;
      if (JSON.stringify(stored) !== text) throw new Error("Telegram 归档冲突；未丢弃活动记录");
      // A previous archive replacement may have been visible but unacknowledged.
      // Confirm its directory again before forgetting the active copy.
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  /** Persist terminal channel history before removing it from the active journal. */
  async #retain(next: TelegramData) {
    let archivedAny = false;
    if (next.inputs.length > TELEGRAM_INPUT_LIMIT / 2) {
      const terminal = next.inputs.filter(x => archivalInput(x, next.offset));
      const archived = new Set(terminal.slice(0, Math.max(0, terminal.length - 128, next.inputs.length - TELEGRAM_INPUT_LIMIT)).map(x => x.key));
      for (const record of terminal) if (archived.has(record.key)) { await this.#archive("inputs", record); archivedAny = true; }
      next.inputs = next.inputs.filter(x => !archived.has(x.key));
    }
    if (next.deliveries.length > TELEGRAM_DELIVERY_LIMIT / 2) {
      const terminal = next.deliveries.filter(archivalDelivery);
      const archived = new Set(terminal.slice(0, Math.max(0, terminal.length - 256, next.deliveries.length - TELEGRAM_DELIVERY_LIMIT)).map(x => x.key));
      for (const record of terminal) if (archived.has(record.key)) { await this.#archive("deliveries", record); archivedAny = true; }
      next.deliveries = next.deliveries.filter(x => !archived.has(x.key));
    }
    // Newly created archive directories must be durable before the active
    // journal forgets their terminal records.
    if (archivedAny) {
      const archive = await open(join(dirname(this.path), "telegram-archive"), "r");
      try { await archive.sync(); } finally { await archive.close(); }
      const parent = await open(dirname(this.path), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async #hasArchived(kind: "inputs" | "deliveries", key: string): Promise<boolean> {
    const path = this.#archivePath(kind, key);
    try {
      for (const parent of [dirname(dirname(path)), dirname(path)]) {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Telegram 归档目录权限不安全");
      }
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 128 * 1024) throw new Error("Telegram 归档无效");
      const record = JSON.parse(await readFile(path, "utf8")) as TelegramInbound | TelegramDelivery;
      const terminal = kind === "inputs" ? ["finished", "rejected", "reviewed"] : ["submitted", "cancelled"];
      if (record.key !== key || !(terminal.includes(record.state) || kind === "deliveries" && record.state === "unknown" && "reviewReport" in record && !!record.reviewReport)) throw new Error("Telegram 归档归属无效");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async hasDelivery(key: string): Promise<boolean> {
    return this.#data.deliveries.some(x => x.key === key) || await this.#hasArchived("deliveries", key);
  }
  async hasInput(key: string): Promise<boolean> {
    return this.#data.inputs.some(x => x.key === key) || await this.#hasArchived("inputs", key);
  }
  update(change: (data: TelegramData) => void): Promise<void> {
    const operation = this.#tail.then(async () => {
      if (this.#failed) throw new Error("Telegram 保存未确认，已停止接收；请重启后核对，不会自动重做任务。");
      const next = this.snapshot(); change(next);
      // Old binaries must reject multipart journals, not resend a partly delivered body as one message.
      if (next.deliveries.some(x => x.parts)) next.version = 2;
      try { await this.#retain(next); }
      catch { this.#failed = true; throw new Error("Telegram 归档保存未确认，已停止接收；既有活动记录与接收位置未改变，请重启后核对。"); }
      if (!valid(next, this.workspace)) throw new Error("Telegram 记录无效或已满；未丢弃既有记录。");
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Telegram 记录容量已满，未确认新的消息；未丢弃既有记录。");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.#data = next;
      } catch { this.#failed = true; throw new Error("Telegram 保存未确认，已停止接收；不会自动重做任务。"); }
      finally { await unlink(temporary).catch(() => undefined); }
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
