import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { acquireFlock } from "./flock.js";

const projectSchema = z.object({ id: z.string(), directory: z.string(), name: z.string(), kind: z.enum(["git", "folder"]) }).strict();
export const projectRegistrySchema = z.object({ version: z.literal(1), projects: z.array(projectSchema), selected: z.string().nullable() }).strict();
export type Project = z.infer<typeof projectSchema>;

export async function identifyProject(directory: string | null): Promise<Project | null> {
  if (directory === null) return null;
  if (!isAbsolute(directory)) throw new Error("项目目录必须是绝对路径");
  const folder = await realpath(directory);
  if (!(await lstat(folder)).isDirectory()) throw new Error("项目路径必须是文件夹");
  let root = folder;
  let kind: Project["kind"] = "folder";
  for (let current = folder; ; current = dirname(current)) {
    try {
      const git = await lstat(join(current, ".git"));
      if (git.isDirectory() || git.isFile()) { root = current; kind = "git"; break; }
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (dirname(current) === current) break;
  }
  return { id: createHash("sha256").update(root).digest("hex"), directory: root, name: basename(root), kind };
}

export async function selectProject(options: { dataDirectory: string; directory?: string | null; cwd: string }): Promise<Project | null> {
  const file = join(options.dataDirectory, "projects.json");
  const read = async () => {
    try { return projectRegistrySchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  };
  const saved = await read();
  const selected = saved?.projects.find(project => project.id === saved.selected) ?? null;
  if (selected) {
    let current: Project | null = null;
    try { current = await identifyProject(selected.directory); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (current?.id !== selected.id) {
      const node = process.versions.electron ? z.object({ nodeExecutable: z.string() }).parse(JSON.parse(readFileSync(new URL("./node-runtime.json", import.meta.url), "utf8"))).nodeExecutable : process.execPath;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = [node, fileURLToPath(new URL("../scripts/project-rebind.mjs", import.meta.url)), "--data", options.dataDirectory, "--from", selected.id, "--to", "/新项目的绝对路径", "--dry-run"].map(quote).join(" ");
      throw new Error(`项目 ${selected.name} 在 ${selected.directory} 找不到了；如已移动，运行 ${command} 重绑。将 --to 改为实际新路径，预览后将 --dry-run 改为 --upgrade 执行；先停止全部 Serika 写入者。`);
    }
    if (options.directory === undefined) return current;
  } else if (options.directory === undefined && saved) return null;
  const project = await identifyProject(options.directory === undefined ? options.cwd : options.directory);
  await mkdir(options.dataDirectory, { recursive: true });
  const lock = await acquireFlock(`${file}.lock`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const registry = await read() ?? { version: 1, projects: [], selected: null };
    if (project && !registry.projects.some(item => item.id === project.id)) registry.projects.push(project);
    registry.selected = project?.id ?? null;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(registry)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(options.dataDirectory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); await lock.release(); }
  return project;
}
