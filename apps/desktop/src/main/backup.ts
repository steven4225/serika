import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { readThreadTranscript } from "@serika/core";
import { restoreTaskDocument, validateTaskDocument } from "@serika/example-cli/dist/task-store.js";
import { MEMORY_FILE_MAX_BYTES, validateMemoryDocument } from "@serika/example-cli/dist/memory-store.js";
import { CHECKPOINT_FILE_MAX_BYTES, validateCheckpointDocument } from "@serika/example-cli/dist/checkpoint-store.js";
import { WORK_TASK_FILE_MAX_BYTES, validateWorkTaskDocument } from "@serika/example-cli/dist/work-task-store.js";
import { validateDreamingDocument } from "@serika/example-cli/dist/dreaming.js";
import { validateRssDocument } from "@serika/example-cli/dist/rss-subscriptions.js";
import { validateExecutionRunRecord } from "@serika/example-cli/dist/execution-record-store.js";
import { tryAcquireFlock, type FlockHandle } from "@serika/example-cli/dist/flock.js";
import type { DesktopThread } from "./desktop-identity.js";
import type { BackupResult, RestoreResult } from "../shared/backup.js";

// Share the runtime's existing schema contracts; a valid hash is not proof
// that these bytes can be opened by the corresponding Store after recovery.
const STORES = {
  "memory.json": { max: MEMORY_FILE_MAX_BYTES, validate: validateMemoryDocument },
  "checkpoint.json": { max: CHECKPOINT_FILE_MAX_BYTES, validate: validateCheckpointDocument },
  "work-tasks.json": { max: WORK_TASK_FILE_MAX_BYTES, validate: validateWorkTaskDocument },
  "dreaming.json": { max: 1024 * 1024, validate: validateDreamingDocument },
  "tasks.json": { max: 16 * 1024 * 1024, validate: validateTaskDocument },
  "rss.json": { max: 1024 * 1024, validate: validateRssDocument },
};
const STORE_NAMES = Object.keys(STORES) as (keyof typeof STORES)[];
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
type Entry = { path: string; text: string; sha256: string };
interface Archive { version: 1; originWorkspace: string; createdAt: string; threads: string[]; entries: Entry[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function validateStore(name: keyof typeof STORES, text: string) {
  const rule = STORES[name];
  if (Buffer.byteLength(text) > rule.max) throw new Error(`备份 ${name} 超过存储读取限额；未导出或恢复`);
  try { rule.validate(JSON.parse(text)); }
  catch { throw new Error(`备份 ${name} 内容无效，无法由原存储读取；未导出或恢复`); }
}
async function readSafe(path: string, max = MAX_BACKUP_BYTES): Promise<string | null> {
  // Do not follow parent symlinks to unrelated private material.
  if (await realpath(dirname(path)).catch(error => { if (error.code === "ENOENT") return dirname(path); throw error; }) !== dirname(path)) throw new Error("备份路径含符号链接；未读取数据");
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > max) throw new Error("备份来源不是普通文件或超过限额");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
async function syncDirectory(path: string) { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
async function writeNew(path: string, data: string | Buffer) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}

type ExportOptions = { workspace: string; threads: DesktopThread[]; destination: string; knownSecrets?: string[] };
export async function exportBackup(options: ExportOptions): Promise<BackupResult> {
  // Take all cooperating writer locks without waiting while holding another.
  // On contention release everything; never deadlock a worker's multi-store flow.
  const workspace = await realpath(options.workspace), locks: FlockHandle[] = [];
  const paths = new Set(STORE_NAMES.map(name => join(workspace, ".runloom", `${name}.lock`)));
  for (const thread of options.threads) {
    const directory = await realpath(thread.transcriptDirectory);
    paths.add(join(directory, "execution-records.json.lock"));
    paths.add(join(directory, hash(thread.threadId) + ".jsonl.append.lock"));
  }
  try {
    for (const path of [...paths].sort()) {
      await mkdir(dirname(path), { recursive: true });
      if (await realpath(dirname(path)) !== dirname(path)) throw new Error("备份锁路径含符号链接；未读取数据");
      try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("备份锁不是普通文件"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const lock = await tryAcquireFlock(path);
      if (!lock) throw new Error("数据正在写入；备份未开始，请稍后重试（未导出部分备份）");
      locks.push(lock);
    }
    return await exportLockedBackup(options);
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}

async function exportLockedBackup(options: ExportOptions): Promise<BackupResult> {
  const workspace = await realpath(options.workspace), destination = options.destination;
  const distance = relative(workspace, destination);
  if (!isAbsolute(destination) || !(distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance))) throw new Error("请将备份保存在工作区之外");
  const parent = await realpath(dirname(destination));
  if (parent !== dirname(destination)) throw new Error("备份目标不能通过符号链接写入");
  try { await lstat(destination); throw new Error("备份文件已存在，请选择新文件名"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const archive: Archive = { version: 1, originWorkspace: workspace, createdAt: new Date().toISOString(), threads: [], entries: [] };
  let bytes = 0;
  const add = (path: string, text: string) => {
    if (options.knownSecrets?.some(secret => secret.length > 0 && text.includes(secret))) throw new Error("备份内容包含当前配置的凭据；未导出，请先移除正文中的敏感信息");
    bytes += Buffer.byteLength(text); if (bytes > MAX_BACKUP_BYTES) throw new Error("备份数据超过 128 MiB；未截断或删除来源");
    archive.entries.push({ path, text, sha256: hash(text) });
  };
  for (const name of STORE_NAMES) {
    const text = await readSafe(join(workspace, ".runloom", name), STORES[name].max);
    if (text !== null) { validateStore(name, text); add(`workspace/.runloom/${name}`, text); }
  }
  const journals = new Map<string, unknown[]>();
  const directories = new Map<string, string[]>();
  for (const thread of options.threads) {
    const directory = await realpath(thread.transcriptDirectory);
    const filename = hash(thread.threadId) + ".jsonl", path = join(directory, filename);
    let latest: string | null = null; const compactions: string[] = [];
    try {
      const transcript = await readThreadTranscript(path, thread.threadId, { companions: true });
      for (const line of transcript.companions) {
        const record = JSON.parse(line);
        if (record.v === 2 && record.type === "thread.context.compacted") {
          if (record.threadId !== thread.threadId) throw new Error("备份摘要归属不符");
          compactions.push(line); continue;
        }
        if (record.v !== 1) continue;
        if (record.threadId !== thread.threadId) throw new Error("备份对话归属不符");
        throw new Error("备份对话记录无效");
      }
      // Portable standalone snapshot; does not require the original delta chain.
      latest = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId, messages: transcript.messages });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (latest) add(`transcripts/${filename}`, [...compactions, latest].join("\n") + "\n");
    archive.threads.push(thread.threadId);
    directories.set(directory, [...(directories.get(directory) ?? []), thread.threadId]);
  }
  for (const [directory, threadIds] of directories) {
    const text = await readSafe(join(directory, "execution-records.json"), 256 * 1024);
    if (text === null) continue;
    const document = JSON.parse(text);
    if (document.version !== 1 || !Array.isArray(document.runs)) throw new Error("备份执行记录无效");
    const matching = document.runs.filter((run: { threadId: string }) => threadIds.includes(run.threadId));
    for (const run of matching) validateExecutionRunRecord(run);
    journals.set(directory, matching);
  }
  // Different registered transcript directories may retain more than 50 Runs.
  // Preserve those journals separately instead of inventing a merged journal.
  for (const [directory, matching] of journals) {
    if (matching.length) add(`receipts/${hash(directory)}.json`, JSON.stringify({ version: 1, runs: matching }));
  }
  validateArchive(archive);
  const encoded = Buffer.from(JSON.stringify(archive));
  if (encoded.length > MAX_BACKUP_BYTES) throw new Error("备份封装超过 128 MiB；未导出部分备份");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeNew(temporary, gzipSync(encoded)); await link(temporary, destination); await syncDirectory(parent);
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path: destination, files: archive.entries.length, threads: archive.threads.length };
}

async function loadArchive(source: string, expectedHash?: string): Promise<{ archive: Archive; fingerprint: string }> {
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let archive: Archive, fingerprint: string;
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) throw new Error("备份文件大小无效");
    const bytes = await file.readFile(); fingerprint = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && fingerprint !== expectedHash) throw new Error("备份自预览后已变化；请重新选择和核对");
    archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_BACKUP_BYTES }).toString("utf8")) as Archive;
  } finally { await file.close(); }
  validateArchive(archive);
  return { archive, fingerprint: fingerprint! };
}

function validateArchive(archive: Archive) {
  if (!archive || archive.version !== 1 || typeof archive.originWorkspace !== "string" || !isAbsolute(archive.originWorkspace) ||
      typeof archive.createdAt !== "string" || !Number.isFinite(Date.parse(archive.createdAt)) || new Date(archive.createdAt).toISOString() !== archive.createdAt ||
      !Array.isArray(archive.threads) || archive.threads.length > 100 || archive.threads.some(id => typeof id !== "string" || !id || id.length > 256) ||
      new Set(archive.threads).size !== archive.threads.length || !Array.isArray(archive.entries) || archive.entries.length > 207 ||
      archive.entries.some(entry => !entry || typeof entry !== "object") ||
      new Set(archive.entries.map(entry => entry.path)).size !== archive.entries.length) throw new Error("备份清单无效");
  const paths = new Set([...STORE_NAMES.map(name => `workspace/.runloom/${name}`), ...archive.threads.map(id => `transcripts/${hash(id)}.jsonl`)]);
  for (const entry of archive.entries) {
    if (!entry || typeof entry.path !== "string" || (!paths.has(entry.path) && !/^receipts\/[a-f0-9]{64}\.json$/.test(entry.path)) ||
      typeof entry.text !== "string" || entry.sha256 !== hash(entry.text)) throw new Error("备份内容或哈希校验失败；未恢复");
    if (entry.path.startsWith("workspace/.runloom/")) validateStore(entry.path.slice("workspace/.runloom/".length) as keyof typeof STORES, entry.text);
    else if (!entry.path.endsWith(".jsonl")) JSON.parse(entry.text);
    else {
      const threadId = archive.threads.find(id => entry.path === `transcripts/${hash(id)}.jsonl`)!;
      if (!entry.text.endsWith("\n")) throw new Error("备份对话不是完整记录");
      for (const line of entry.text.split("\n").filter(line => line.trim())) {
        const record = JSON.parse(line);
        if (record.threadId !== threadId ||
          !(record.v === 2 && record.type === "thread.context.compacted" || record.v === 1 && record.type === "thread.messages.committed" && Array.isArray(record.messages) &&
            record.messages.every((message: { id?: unknown; role?: unknown; parts?: unknown } | null) => message && typeof message.id === "string" &&
              ["user", "assistant", "system"].includes(String(message.role)) && Array.isArray(message.parts)))) throw new Error("备份对话归属或类型无效");
      }
    }
  }
  archiveReceipts(archive); // Validate before even exposing a restore preview.
}

export async function previewBackup(source: string) {
  const { archive, fingerprint } = await loadArchive(source);
  return { fingerprint, originWorkspace: archive.originWorkspace, createdAt: archive.createdAt, threads: archive.threads.length,
    files: archive.entries.length, stores: STORE_NAMES.filter(name => archive.entries.some(entry => entry.path === `workspace/.runloom/${name}`)) };
}

function archiveReceipts(archive: Archive) {
  const receipts = new Map<string, ReturnType<typeof validateExecutionRunRecord>>();
  for (const entry of archive.entries.filter(entry => entry.path.startsWith("receipts/"))) {
    const journal = JSON.parse(entry.text);
    if (Buffer.byteLength(entry.text) > 256 * 1024 || journal.version !== 1 || !Array.isArray(journal.runs) || journal.runs.length > 50) throw new Error("备份回执无效");
    for (const run of journal.runs) {
      const checked = validateExecutionRunRecord(run);
      if (!archive.threads.includes(checked.threadId)) throw new Error("备份回执不属于登记的对话");
      const previous = receipts.get(checked.runId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(checked)) throw new Error("备份回执冲突");
      receipts.set(checked.runId, checked);
    }
  }
  return receipts;
}

export async function restoreBackup(source: string, parent: string, expectedHash?: string): Promise<RestoreResult> {
  const { archive } = await loadArchive(source, expectedHash);
  const receipts = archiveReceipts(archive);
  const base = await realpath(parent), target = join(base, `Serika-recovery-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(target, { mode: 0o700 });
  const restoredAt = new Date().toISOString();
  try {
    await mkdir(join(target, "workspace"), { mode: 0o700 });
    await mkdir(join(target, "transcripts"), { mode: 0o700 });
    for (const entry of archive.entries) {
      let text = entry.text;
      if (entry.path === "workspace/.runloom/tasks.json") text = JSON.stringify(restoreTaskDocument(JSON.parse(text), restoredAt));
      if (entry.path === "workspace/.runloom/rss.json") { const rss = JSON.parse(text); rss.enabled = false; text = JSON.stringify(rss); }
      const path = join(target, entry.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeNew(path, text);
    }
    // Restore the current journal under its existing bounds. All original
    // per-directory journals also remain in receipts/ for explicit inspection.
    const retained = [...receipts.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
    while (Buffer.byteLength(JSON.stringify({ version: 1, runs: retained })) > 256 * 1024) retained.pop();
    if (retained.length) {
      await mkdir(join(target, "transcripts"), { recursive: true, mode: 0o700 });
      await writeNew(join(target, "transcripts", "execution-records.json"), JSON.stringify({ version: 1, runs: retained }));
    }
    await writeNew(join(target, "recovery.json"), JSON.stringify({ version: 1, originWorkspace: archive.originWorkspace,
      restoredAt, threads: archive.threads, futureExecutionDisabled: true }));
    // No configuration, tokens, binding, launchd definitions or approvals are installed.
    for (const directory of ["workspace/.runloom", "workspace", "transcripts", "receipts"]) {
      try { await syncDirectory(join(target, directory)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await syncDirectory(target); await syncDirectory(base);
  } catch (error) {
    // This exact newly-created directory contains no pre-existing user data.
    await rm(target, { recursive: true, force: true }); throw error;
  }
  return { path: target, files: archive.entries.length, threads: archive.threads.length,
    transcriptDirectory: join(target, "transcripts"), originWorkspace: archive.originWorkspace };
}
