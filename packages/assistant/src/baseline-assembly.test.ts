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

/**
 * v2 pilot step 1 baseline (docs/architecture-v2.md §4.4). Locks, for three
 * module assemblies, what the primary model actually receives (tool table and
 * every prompt message before the user's text) and what the user can read
 * about capabilities (/modules, /capabilities, capability_status). Product
 * code must keep these files byte-identical unless a change is explicitly
 * confirmed. Regenerate only then:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 node --test packages/assistant/dist/baseline-assembly.test.js
 *
 * Normalized: the temporary root (<ROOT>) and wall-clock timestamps (<NOW>).
 * The process timezone is pinned to UTC so the local-time sentences are stable.
 * Computer is excluded: it only assembles on macOS.
 */

process.env.TZ = "UTC";

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

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

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
 * workspace in `desktopAutonomy`, the app is created with `allowDesktopAutonomy` (as desktop-runtime.ts does),
 * and the Run is wrapped in begin/endForegroundExecution("desktop") (as the controller does for a desktop
 * primary Run), so the model receives the autonomous instructions.
 */
async function capture(modules: Record<string, unknown>, { desktopAutonomy = false }: { desktopAutonomy?: boolean } = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules, ...(desktopAutonomy ? { desktopAutonomy: { workspaceRoot: workspace } } : {}) }));
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
    directory: join(root, "transcripts"), assistant: { threadId: "baseline", configPath },
    modelAlias: "mock", model, output, env: { TODOIST_API_TOKEN: "baseline-token" }, cwd: root,
    ...(desktopAutonomy ? { allowDesktopAutonomy: true as const } : {}),
  });
  try {
    const user = { id: "baseline-user", role: "user" as const, parts: [{ type: "text" as const, text: "baseline" }] };
    if (desktopAutonomy) assert.equal(app.beginForegroundExecution?.("desktop", user), true, "the desktop foreground must be autonomous");
    try {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [user] });
      assert.equal((await handle.result).status, "completed");
    } finally { if (desktopAutonomy) app.endForegroundExecution?.(); }
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
      if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, actual);
      assert.equal(actual, await readFile(file, "utf8"));
    });
  }

  // Added in step 3 (pending.md A.4): the full assembly in the trusted desktop foreground.
  it("full assembly in the autonomous desktop foreground matches __baseline__/assembly-full-desktop-autonomous.txt", async () => {
    const actual = await capture(FULL, { desktopAutonomy: true });
    const file = fileURLToPath(new URL("../src/__baseline__/assembly-full-desktop-autonomous.txt", import.meta.url));
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, actual);
    assert.equal(actual, await readFile(file, "utf8"));
  });

  it("the two full assemblies differ only by Todoist-owned content", async () => {
    const read = (name: string) => readFile(fileURLToPath(new URL(`../src/__baseline__/assembly-${name}.txt`, import.meta.url)), "utf8");
    const [full, without] = await Promise.all([read("full"), read("full-without-todoist")]);
    assert.match(full, /## tool todoist_list_tasks/);
    assert.doesNotMatch(without, /todoist_list_tasks/);
  });
});
