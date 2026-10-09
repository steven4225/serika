import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { TelegramStatus } from "../shared/telegram.js";

export interface TelegramInbound {
  key: string; updateId: number; text: string;
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
}
export interface TelegramTaskRoute {
  key: string; id: string; kind: "once" | "recurring"; chatId: number; userId: number;
  /** Existing recurring history before opt-in is never externalized. */
  fromRunAt: string;
  sourceKey?: string; sourceRunId?: string;
}
export interface TelegramData {
  version: 1; workspace: string; enabled: boolean; botId: number | null; offset: number;
  owner: TelegramStatus["owner"]; inputs: TelegramInbound[]; deliveries: TelegramDelivery[];
  routes: TelegramTaskRoute[];
}
function valid(data: TelegramData, workspace: string) {
  const positive = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  return data?.version === 1 && data.workspace === workspace && typeof data.enabled === "boolean" &&
    (data.botId === null || positive(data.botId)) && Number.isSafeInteger(data.offset) && data.offset >= 0 &&
    (data.owner === null || (positive(data.owner.userId) && positive(data.owner.chatId) && typeof data.owner.name === "string" && typeof data.owner.threadId === "string" && !!data.owner.threadId)) &&
    Array.isArray(data.inputs) && data.inputs.length <= 1024 && new Set(data.inputs.map(x => x.key)).size === data.inputs.length && data.inputs.every(x =>
      typeof x.key === "string" && typeof x.text === "string" && x.text.length <= 16_384 && positive(x.updateId + 1) &&
      ["received", "reserved", "bound", "finished", "rejected", "unknown", "reviewed"].includes(x.state) && (x.runId === null || typeof x.runId === "string") && (x.taskId === null || typeof x.taskId === "string") &&
      (x.reviewReport === undefined || (typeof x.reviewReport === "string" && x.reviewReport.length > 0 && x.reviewReport.length <= 2000))) &&
    Array.isArray(data.deliveries) && data.deliveries.length <= 2048 && new Set(data.deliveries.map(x => x.key)).size === data.deliveries.length && data.deliveries.every(x =>
      typeof x.key === "string" && positive(x.chatId) && typeof x.text === "string" && x.text.length <= 32_768 &&
      ["pending", "sending", "submitted", "failed", "unknown", "cancelled"].includes(x.state) && (x.messageId === null || positive(x.messageId)) &&
      (x.routeKey === undefined || typeof x.routeKey === "string") && (x.error === undefined || typeof x.error === "string" && x.error.length <= 512) &&
      (x.retryAt === undefined || typeof x.retryAt === "string" && Number.isFinite(Date.parse(x.retryAt)))) &&
    Array.isArray(data.routes) && data.routes.length <= 128 && new Set(data.routes.map(x => x.key)).size === data.routes.length && data.routes.every(x =>
      typeof x.id === "string" && !!x.id && ["once", "recurring"].includes(x.kind) && x.key === `${x.kind}:${x.id}` &&
      positive(x.chatId) && positive(x.userId) && x.chatId === data.owner?.chatId && x.userId === data.owner?.userId &&
      typeof x.fromRunAt === "string" && Number.isFinite(Date.parse(x.fromRunAt)) &&
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
  update(change: (data: TelegramData) => void): Promise<void> {
    const operation = this.#tail.then(async () => {
      if (this.#failed) throw new Error("Telegram 保存未确认，已停止接收；请重启后核对，不会自动重做任务。");
      const next = this.snapshot(); change(next);
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
