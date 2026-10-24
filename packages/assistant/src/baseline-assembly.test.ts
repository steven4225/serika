import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { formatCapabilityStatus } from "./capability-status.js";
import { MEMORY_READ_INSTRUCTIONS } from "./memory-instructions.js";

/**
 * v2 pilot step 1 baseline (docs/architecture-v2.md §4.4). Locks, for three
 * module assemblies, what the primary model actually receives (tool table and
 * every prompt message before the user's text) and what the user can read
 * about capabilities (/modules, /capabilities, capability_status). Product
 * keeps the historical snapshots unchanged; assertStep3Assembly compares the
 * explicitly approved assembly changes against that baseline.
 *
 * Normalized: the temporary root (<ROOT>) and wall-clock timestamps (<NOW>).
 * The process timezone is pinned to UTC so the local-time sentences are stable.
 * Computer is excluded: it only assembles on macOS.
 */

process.env.TZ = "UTC";

import { MEMORY_PRIMARY_WRITE_INSTRUCTIONS } from "./memory-write.js";
import { DIRECTORY_FILE_INSTRUCTIONS } from "./directory-file-tool.js";
import { SEATBELT_INSTRUCTIONS } from "./modules/seatbelt-policy.js";

const FULL = {
  pomodoro: { enabled: true },
  "read-file": { enabled: true },
  memory: { enabled: true },
  checkpoint: { enabled: true },
  task: { enabled: true },
  todoist: { enabled: true },
  shell: { enabled: true },
  web: { enabled: true, search: { enabled: true }, feed: { enabled: true } },
};
const { todoist: _todoist, ...WITHOUT_TODOIST } = FULL;

export const BASELINE_ASSEMBLIES: ReadonlyArray<readonly [name: string, modules: Record<string, unknown>]> = [
  ["minimal", {}],
  ["full", FULL],
  ["full-without-todoist", WITHOUT_TODOIST],
];

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

function normalize(text: string, root: string): string {
  return text.replaceAll(root, "<ROOT>").replace(ISO, "<NOW>");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as ReadonlyArray<{ type: string; text?: string }>)
    .map(part => part.type === "text" ? part.text ?? "" : `[${part.type}] ${JSON.stringify(part)}`).join("\n");
}

/**
 * `desktopAutonomy`: the trusted desktop foreground (docs/v2-pilot/pending.md A.4). The config names this
 * workspace in `desktopAutonomy`, the app is created with `desktopAutonomyHost` (as desktop-runtime.ts does),
 * and the Run is wrapped in begin/endForegroundExecution("desktop") (as the controller does for a desktop
 * primary Run), so the model receives the autonomous instructions.
 */
async function capture(modules: Record<string, unknown>, { desktopAutonomy = false }: { desktopAutonomy?: boolean } = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules, ...(desktopAutonomy ? { desktopAutonomy: { authorizedDirectory: workspace } } : {}) }));
  let request: Parameters<MockLanguageModelV3["doStream"]>[0] | undefined;
  const model = new MockLanguageModelV3({ doStream: async options => {
    request ??= options;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      } },
    ] }) };
  } });
  const output = new PassThrough();
  let written = "";
  output.on("data", chunk => { written += String(chunk); });
  const app = await createRuntimeApp({
    directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "baseline", configPath },
    modelAlias: "mock", model, output, env: { TODOIST_API_TOKEN: "baseline-token" }, cwd: root,
    ...(desktopAutonomy ? { desktopAutonomyHost: { home: join(root, "H") } } : {}),
  });
  try {
    const user = { id: "baseline-user", role: "user" as const, parts: [{ type: "text" as const, text: "baseline" }] };
    if (desktopAutonomy) assert.equal(app.beginForegroundExecution?.("desktop", user), true, "the desktop foreground must be autonomous");
    try {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [user] });
      assert.equal((await handle.result).status, "completed");
    } finally { if (desktopAutonomy) await app.endForegroundExecution?.(); }
    assert.ok(request, "the primary model must be called once");
    written = "";
    await app.commands?.get("modules")?.execute("");
    const modulesText = written;
    written = "";
    await app.commands?.get("capabilities")?.execute("");
    const capabilitiesText = written;
    const sections: string[] = [];
    const tools = (request.tools ?? []).flatMap(tool => tool.type === "function" ? [tool] : []);
    sections.push(`# tools (${tools.length})`, tools.map(tool => tool.name).join("\n"));
    for (const tool of tools) {
      sections.push(`## tool ${tool.name}`, tool.description ?? "", JSON.stringify(tool.inputSchema, null, 2));
    }
    const prompt = request.prompt;
    const userIndex = prompt.findIndex(message => message.role === "user");
    const instructions = userIndex === -1 ? prompt : prompt.slice(0, userIndex);
    sections.push(`# instructions (${instructions.length} messages before the user's text)`);
    instructions.forEach((message, index) => sections.push(`## message ${index} ${message.role}`, contentText(message.content)));
    sections.push("# /modules", modulesText.trimEnd());
    sections.push("# /capabilities", capabilitiesText.trimEnd());
    const status = app.getCapabilities?.();
    sections.push("# capability_status", status ? JSON.stringify(status, null, 2) : "(not registered)");
    if (status) assert.equal(capabilitiesText, `${formatCapabilityStatus(status)}\n`);
    return normalize(sections.join("\n\n") + "\n", root);
  } finally {
    app.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe("v2 pilot baseline: assembled tools, instructions and capability report", () => {
  for (const [name, modules] of BASELINE_ASSEMBLIES) {
    it(`${name} assembly matches __baseline__/assembly-${name}.txt`, async () => {
      const actual = await capture(modules);
      const file = fileURLToPath(new URL(`../src/__baseline__/assembly-${name}.txt`, import.meta.url));
      assertStep3Assembly(actual, await readFile(file, "utf8"));
    });
  }

  // Added in step 3 (pending.md A.4): the full assembly in the trusted desktop foreground.
  it("full assembly in the autonomous desktop foreground matches __baseline__/assembly-full-desktop-autonomous.txt", async () => {
    const actual = await capture(FULL, { desktopAutonomy: true });
    const file = fileURLToPath(new URL("../src/__baseline__/assembly-full-desktop-autonomous.txt", import.meta.url));
    assertStep3Assembly(actual, await readFile(file, "utf8"), true);
  });

  it("the two full assemblies differ only by Todoist-owned content", async () => {
    const read = (name: string) => readFile(fileURLToPath(new URL(`../src/__baseline__/assembly-${name}.txt`, import.meta.url)), "utf8");
    const [full, without] = await Promise.all([read("full"), read("full-without-todoist")]);
    assert.match(full, /## tool todoist_list_tasks/);
    assert.doesNotMatch(without, /todoist_list_tasks/);
  });
});

// Keep the historical files intact; compare every unaffected schema and rule.
function assertStep3Assembly(actual: string, baseline: string, autonomous = false) {
  baseline = baseline.replaceAll(
    "批准 computer_check 可单独检查连接（不读取窗口内容），批准 computer_observe 才观察指定的允许应用；不会启动驱动或授予系统权限。",
    "computer_check 检查连接、computer_observe 观察明确授权的应用均免逐条确认；未授权应用直接拒绝，computer_action 每次确认且不可记住。不会启动驱动或授予系统权限。");
  const schemas = (text: string) => new Map([...text.matchAll(/## tool (\S+)\n\n([\s\S]*?)(?=\n\n## tool |\n\n# instructions)/g)].map(match => [match[1]!, match[2]!]));
  const before = schemas(baseline), after = schemas(actual), hadMemory = before.has("memory_add");
  for (const name of ["history_search", "history_read"]) { assert.ok(after.has(name)); after.delete(name); }
  assert.ok(after.has("memory_read")); after.delete("memory_read");
  for (const name of before.keys()) if (name.startsWith("memory_")) { assert.ok(!after.has(name)); before.delete(name); }
  if (!autonomous && hadMemory) { assert.ok(after.get("memory_write")?.includes("replace")); after.delete("memory_write"); } else assert.ok(!after.has("memory_write"));
  if (autonomous) before.set("shell_exec", before.get("shell_exec")!.replace("Run one non-interactive local shell command from a workspace-relative directory. The command may inspect or modify the machine; it is bounded by a timeout and output limit.", SEATBELT_INSTRUCTIONS));
  for (const name of ["read_file", "list_directory", "search_files", "write_file", "edit_file", "shell_exec"]) {
    if (!before.has(name)) continue;
    const value = before.get(name)!; const split = value.indexOf("\n\n{");
    let description = value.slice(0, split); const schema = JSON.parse(value.slice(split + 2));
    schema.properties.directory = { type: "string", ...(name === "shell_exec" ? { minLength: 1 } : {}) };
    if (name !== "shell_exec") description = description.replace(" The path must be relative to the workspace.", "")
      .replace("; the path must be relative to the workspace.", ".")
      .replace("The path must be relative to the workspace and defaults to the workspace root;", "The path defaults to the selected root;") + DIRECTORY_FILE_INSTRUCTIONS;
    before.set(name, description + "\n\n" + JSON.stringify(schema, null, 2));
  }
  assert.deepEqual(after, before);
  const system = (text: string) => text.split("## message 0 system\n\n")[1]!.split(/\n\n(?:## message|# \/modules)/)[0]!;
  let oldSystem = system(baseline).replace(/In automatic memory mode,[\s\S]*?Active injected Memory overrides conflicting older transcript\/compaction, while the latest user request remains authoritative\./, "");
  if (autonomous) oldSystem = oldSystem
    .replace(/When shell_exec is available,[\s\S]*?Do not use shell_exec when it is not enabled\. /, SEATBELT_INSTRUCTIONS + " ")
    .replace("Local shell_exec is not pre-authorized: each command is still shown to the user for confirmation, so run only the commands the task needs.", "Desktop and bound Telegram autonomous shell_exec use the same module Seatbelt policy without per-command confirmation. Explicitly selected host Shell still requires confirmation for every command. Run only commands the task needs.")
    .replace("Other tools retain their own permissions. Local Shell has the process's host permissions; the workspace is not an OS sandbox.", "Other tools retain their own permissions. Host Shell has the process's host permissions; its workspace is not an OS sandbox. Network commands require an explicitly selected host Run and per-command confirmation.");
  oldSystem = oldSystem.replace("with a workspace-relative path to find and read files", "with an authorized absolute path or an explicit project/directory-relative path to find and read files")
    .replace("All file paths are relative to the configured workspace, not the application's source repository or previous test fixtures.", "Relative file paths use the explicit project or selected directory. Without an explicit base and with several authorized directories, ask the user to choose a directory.");
  const newSystem = system(actual).replace(autonomous ? MEMORY_READ_INSTRUCTIONS : MEMORY_READ_INSTRUCTIONS + MEMORY_PRIMARY_WRITE_INSTRUCTIONS, "");
  assert.equal(newSystem, oldSystem);
  const section = (text: string, title: string) => text.split(`# ${title}\n\n`)[1]!.split(/\n\n# /)[0]!;
  const modules = (text: string) => section(text, "/modules").replace(/\d+\/8192 bytes/g, "<BYTES>/8192 bytes");
  const expectedModules = modules(baseline)
    .replace("pinned preview 0 · <BYTES>/8192 bytes · truncated false · excluded otherThread 0, disabled 0, expired 0", "snapshot 0 · <BYTES>/8192 bytes · overflow false · excluded thread 0, documents 0, disabled 0, expired 0")
    .replace("无查询 pinned 预览不是下一轮实际命中数；未选中不表示已删除。记忆详情: 使用 memory_list / memory_get 查询（沿用工具确认）", "当前可生成快照的预览；已运行请求使用其保存的固定版本。超额及文档正文可通过 memory_read 按需读取。");
  assert.equal(modules(actual), expectedModules);
  assert.match(section(actual, "/capabilities"), /^terminal：未启用$/m);
  const capabilities = (text: string) => section(text, "/capabilities").replace(/^memory：.*\n/m, "").replace(/^terminal：未启用\n/m, "");
  assert.equal(capabilities(actual), capabilities(baseline));
  const status = (text: string) => { const value = JSON.parse(section(text, "capability_status"));
    value.tools = value.tools.filter((name: string) => !name.startsWith("memory_") && !name.startsWith("history_"));
    value.modules = value.modules.map((module: { id: string; registeredTools: string[] }) => module.id === "memory" ? { ...module, registeredTools: [] } : module);
    if (autonomous) value.modules = value.modules.filter((module: { id: string }) => module.id !== "memory");
    return value; };
  const currentStatus = status(actual);
  assert.deepEqual(currentStatus.modules.find((module: { id: string }) => module.id === "terminal"), { id: "terminal", enabled: false, registeredTools: [], state: "disabled" });
  currentStatus.modules = currentStatus.modules.filter((module: { id: string }) => module.id !== "terminal");
  assert.deepEqual(currentStatus, status(baseline));
}
