import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireFlock } from "./flock.js";
import { readFileFromWorkspace } from "./read-file.js";
import { rejectSymlinkComponents, validateWorkspacePath } from "./workspace-path.js";

const text = (max: number) => z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= max);
export const recipeDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), description: text(512),
  command: text(1024), cwd: text(512),
}).strict();
export const recipeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const recipeChangeSchema = z.object({ id: recipeDefinitionSchema.shape.id, expectedRevision: z.number().int().positive(), action: z.enum(["enable", "disable", "rollback"]), hash: recipeHashSchema.optional() }).strict();
export type RecipeChange = z.infer<typeof recipeChangeSchema>;
const versionSchema = recipeDefinitionSchema.extend({
  hash: recipeHashSchema, tested: z.object({ threadId: text(256), runId: text(256), toolCallId: text(256) }).strict(),
}).strict();
const entrySchema = z.object({
  id: recipeDefinitionSchema.shape.id, revision: z.number().int().positive(), enabled: z.boolean(),
  versions: z.array(versionSchema).min(1).max(8), activeHash: recipeHashSchema,
}).strict();
const documentSchema = z.object({ version: z.literal(1), recipes: z.array(entrySchema).max(32) }).strict();
export type RecipeDefinition = z.infer<typeof recipeDefinitionSchema>;
export type RecipeVersion = z.infer<typeof versionSchema>;
export type RecipeEntry = z.infer<typeof entrySchema>;
type Document = z.infer<typeof documentSchema>;
export const recipeHash = (value: RecipeDefinition) => createHash("sha256")
  .update(JSON.stringify({ version: 1, id: value.id, description: value.description, command: value.command, cwd: value.cwd })).digest("hex");
export class RecipeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new RecipeError(code, message); }

/** A bounded workspace-local command catalog, not an installer, permission store or replay queue. */
export class RecipeStore {
  #uncertain = false;
  constructor(readonly workspace: string) {}
  async #inspect(path: string, directory = false) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail("RECIPE_FILE_INVALID", "Recipe storage must use regular files and directories, not symlinks");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async list(signal: AbortSignal): Promise<RecipeEntry[]> {
    signal.throwIfAborted();
    const result = await readFileFromWorkspace(this.workspace, ".runloom/recipes.json", signal);
    if (!result.ok) {
      if (result.error.code === "FILE_NOT_FOUND") return [];
      fail("RECIPE_FILE_INVALID", "Cannot read recipe catalog; nothing was overwritten");
    }
    try {
      const doc = documentSchema.parse(JSON.parse(result.content));
      const ids = new Set<string>();
      for (const entry of doc.recipes) {
        if (ids.has(entry.id) || !entry.versions.some(v => v.hash === entry.activeHash)) throw new Error();
        ids.add(entry.id);
        const hashes = new Set<string>();
        for (const v of entry.versions) {
          if (v.id !== entry.id || v.hash !== recipeHash(v) || hashes.has(v.hash) || !validateWorkspacePath(this.workspace, v.cwd).ok) throw new Error();
          hashes.add(v.hash);
        }
      }
      return doc.recipes;
    } catch { return fail("RECIPE_FILE_INVALID", "Invalid recipe catalog; nothing was overwritten"); }
  }
  async get(id: string, hash: string, signal: AbortSignal) {
    const entry = (await this.list(signal)).find(item => item.id === id);
    if (!entry || !entry.enabled) fail("RECIPE_UNAVAILABLE", "Recipe is missing or disabled");
    if (entry.activeHash !== hash) fail("RECIPE_CHANGED", "Recipe changed; read and approve the current version");
    return entry.versions.find(item => item.hash === hash)!;
  }
  async save(value: RecipeDefinition, tested: RecipeVersion["tested"], expectedRevision: number, signal: AbortSignal) {
    const definition = recipeDefinitionSchema.parse(value);
    if (!validateWorkspacePath(this.workspace, definition.cwd).ok) fail("RECIPE_INVALID_INPUT", "Recipe cwd must remain workspace-relative");
    if (await rejectSymlinkComponents(this.workspace, definition.cwd === "." ? "" : definition.cwd, signal)) fail("RECIPE_INVALID_INPUT", "Recipe cwd cannot be a symlink");
    return this.#mutate(signal, doc => {
      let entry = doc.recipes.find(item => item.id === definition.id);
      if ((entry?.revision ?? 0) !== expectedRevision) fail("RECIPE_CHANGED", "Recipe revision changed");
      const hash = recipeHash(definition);
      if (!entry) {
        if (doc.recipes.length >= 32) fail("RECIPE_CAPACITY", "Recipe catalog is full");
        entry = { id: definition.id, revision: 1, enabled: true, activeHash: hash, versions: [] };
        doc.recipes.push(entry);
      } else entry.revision++;
      if (!entry.versions.some(v => v.hash === hash)) {
        if (entry.versions.length >= 8) fail("RECIPE_CAPACITY", "Recipe version history is full; no history was discarded");
        entry.versions.push({ ...definition, hash, tested });
      }
      entry.activeHash = hash; entry.enabled = true;
      return entry;
    });
  }
  async change(id: string, expectedRevision: number, action: "enable" | "disable" | "rollback", hash: string | undefined, signal: AbortSignal) {
    return this.#mutate(signal, doc => {
      const entry = doc.recipes.find(item => item.id === id);
      if (!entry || entry.revision !== expectedRevision) fail("RECIPE_CHANGED", "Recipe missing or revision changed");
      if (action === "rollback") {
        if (!hash || !entry.versions.some(v => v.hash === hash)) fail("RECIPE_INVALID_INPUT", "Rollback must select a previously tested version");
        entry.activeHash = hash;
      } else entry.enabled = action === "enable";
      entry.revision++;
      return entry;
    });
  }
  async #mutate<T>(signal: AbortSignal, update: (doc: Document) => T): Promise<T> {
    if (this.#uncertain) fail("RECIPE_COMMIT_UNCERTAIN", "Previous catalog acknowledgement is uncertain; reopen and inspect, do not retry automatically");
    const directory = join(this.workspace, ".runloom"), file = join(directory, "recipes.json");
    await this.#inspect(this.workspace, true); await this.#inspect(directory, true);
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, "recipes.lock");
    await this.#inspect(lockPath);
    const lock = await acquireFlock(lockPath, signal);
    try {
      if (this.#uncertain) fail("RECIPE_COMMIT_UNCERTAIN", "Reopen and inspect before further changes");
      await this.#inspect(file);
      const doc: Document = { version: 1, recipes: await this.list(signal) };
      const result = update(doc), serialized = JSON.stringify(documentSchema.parse(doc));
      if (Buffer.byteLength(serialized) > 64 * 1024) fail("RECIPE_CAPACITY", "Recipe catalog exceeds 64 KiB");
      const temporary = join(directory, `.recipes-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { signal.throwIfAborted(); await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        signal.throwIfAborted(); await rename(temporary, file); renamed = true;
        const dir = await open(directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) {
        if (renamed) { this.#uncertain = true; fail("RECIPE_COMMIT_UNCERTAIN", "Catalog replaced but acknowledgement uncertain; inspect before retrying"); }
        await rm(temporary, { force: true }); throw error;
      }
      return structuredClone(result);
    } finally { await lock.release(); }
  }
}
