import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface QqBinding { workspace: string; botId: number; groupId: number; ownerId: number; threadId: string }
export interface QqInput {
  key: string; userId: number; runId: string | null;
  state: "received" | "bound" | "finished" | "rejected" | "unknown";
  reviewReport?: string;
}
export interface QqDelivery { key: string; state: "sending" | "submitted" | "failed" | "unknown"; messageId: number | null }
interface Data { version: 1; binding: QqBinding; inputs: QqInput[]; deliveries: QqDelivery[] }
export const QQ_RECORD_LIMIT = 4096;
const bindingKey = (b: QqBinding) => JSON.stringify([b.workspace, b.botId, b.groupId, b.ownerId, b.threadId]);
function valid(value: Data, binding: QqBinding): boolean {
  return value?.version === 1 && !!value.binding && bindingKey(value.binding) === bindingKey(binding) &&
    Array.isArray(value.inputs) && value.inputs.length <= QQ_RECORD_LIMIT && new Set(value.inputs.map(x => x.key)).size === value.inputs.length && value.inputs.every(x =>
      /^-?\d+$/.test(x.key) && Number.isSafeInteger(x.userId) && x.userId > 0 && (x.runId === null || typeof x.runId === "string" && !!x.runId) &&
      ["received", "bound", "finished", "rejected", "unknown"].includes(x.state) && (x.state !== "bound" || !!x.runId) &&
      (x.reviewReport === undefined || typeof x.reviewReport === "string" && x.reviewReport.trim().length > 0 && x.reviewReport.length <= 2000)) &&
    Array.isArray(value.deliveries) && value.deliveries.length <= QQ_RECORD_LIMIT && new Set(value.deliveries.map(x => x.key)).size === value.deliveries.length && value.deliveries.every(x =>
      typeof x.key === "string" && x.key.length > 0 && x.key.length <= 256 && ["sending", "submitted", "failed", "unknown"].includes(x.state) &&
      (x.state === "submitted" ? Number.isSafeInteger(x.messageId) : x.messageId === null));
}

/** Held under the QQ host's lifetime flock. No automatic replay or evidence eviction. */
export class QqStore {
  #data: Data;
  #tail: Promise<unknown> = Promise.resolve();
  #failed = false;
  constructor(readonly path: string, readonly binding: QqBinding) { this.#data = { version: 1, binding, inputs: [], deliveries: [] }; }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(this.path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error("QQ 状态目录权限不安全。");
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 8 * 1024 * 1024 || process.getuid && info.uid !== process.getuid()) throw new Error("QQ 状态文件权限或大小无效。");
      const value = JSON.parse(await readFile(this.path, "utf8")) as Data;
      if (!valid(value, this.binding)) throw new Error("QQ 状态或绑定不匹配，不会重新绑定或重做执行。");
      this.#data = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  snapshot() { return structuredClone(this.#data); }
  update(change: (data: Data) => void): Promise<void> {
    const operation = this.#tail.then(async () => {
      if (this.#failed) throw new Error("QQ 保存未确认，已冻结接收；请重启并核对记录。");
      const next = this.snapshot(); change(next);
      if (!valid(next, this.binding)) throw new Error("QQ 记录无效或容量已满；既有证据未被删除。");
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("QQ 状态容量已满。");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.#data = next;
      } catch { this.#failed = true; throw new Error("QQ 保存未确认，可能已写入；不会自动重做，请重启后读取实际记录。"); }
      finally { await unlink(temporary).catch(() => undefined); }
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
