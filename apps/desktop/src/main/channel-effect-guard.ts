import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ChannelEffectOwner { threadId: string; runId: string; unknown?: boolean }
/** A resource reservation, not an execution journal or permission grant. Never replays effects. */
export class ChannelEffectGuard {
  #owner: ChannelEffectOwner | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #failed = false;
  #review: { threadId: string; runId: string; note: string } | undefined;
  constructor(readonly path: string, readonly workspace: string) {}
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid() || stat.size > 4096) throw new Error("工作区资源记录不可读");
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.version !== 1 || data.workspace !== this.workspace || data.owner !== null && (!data.owner || typeof data.owner.threadId !== "string" || !data.owner.threadId || typeof data.owner.runId !== "string" || !data.owner.runId)) throw new Error("工作区资源记录归属无效");
      if (data.review && typeof data.review.threadId === "string" && typeof data.review.runId === "string" && typeof data.review.note === "string" && data.review.note.length <= 2000) this.#review = data.review;
      this.#owner = data.owner ? { threadId: data.owner.threadId, runId: data.owner.runId, unknown: true } : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  snapshot() { return this.#owner ? { ...this.#owner } : null; }
  async #save(owner: ChannelEffectOwner | undefined) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, workspace: this.workspace, owner: owner ?? null, ...(this.#review ? { review: this.#review } : {}) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const parent = await open(dirname(this.path), "r"); try { await parent.sync(); } finally { await parent.close(); }
    } catch { this.#failed = true; if (this.#owner) this.#owner.unknown = true; throw new Error("资源保存未确认；副作用已阻止，请重启后核对原执行"); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  #serial<T>(action: () => Promise<T>) {
    const result = this.#tail.then(action); this.#tail = result.catch(() => undefined); return result;
  }
  claim(threadId: string, runId: string) {
    return this.#serial(async () => {
      if (this.#failed) throw new Error("资源保存未确认，禁止派发副作用");
      if (this.#owner) return !this.#owner.unknown && this.#owner.threadId === threadId && this.#owner.runId === runId;
      this.#owner = { threadId, runId };
      await this.#save(this.#owner);
      return true;
    });
  }
  /** Only a terminal receipt without unknown tools, or an explicit human observation, calls this. */
  release(threadId: string, runId: string, note?: string) {
    return this.#serial(async () => {
      if (this.#failed) throw new Error("资源保存未确认，请重启核对");
      if (this.#owner?.threadId !== threadId || this.#owner.runId !== runId) return;
      if (note) this.#review = { threadId, runId, note };
      await this.#save(undefined); this.#owner = undefined;
    });
  }
  markUnknown(threadId: string, runId: string) {
    if (this.#owner?.threadId === threadId && this.#owner.runId === runId) this.#owner.unknown = true;
  }
}
