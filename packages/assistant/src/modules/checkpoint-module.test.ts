import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { asSchema } from "ai";
import {
  CHECKPOINT_FILE_NAME,
  CHECKPOINT_LIMITS,
  createCheckpointStore,
  type CheckpointDraft,
} from "../checkpoint-store.js";
import { createCheckpointModule } from "./checkpoint-module.js";
import { createModuleHost, type ToolPermissionFacts } from "../module-host.js";

function draft(overrides: Partial<CheckpointDraft> = {}): CheckpointDraft {
  return {
    status: "active",
    goal: "Continue Serika",
    summary: "The feature is in progress.",
    completed: ["Confirm the contract"],
    inProgress: ["Add the checkpoint module"],
    nextActions: ["Add tests"],
    blockers: [],
    artifacts: [],
    ...overrides,
  };
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "runloom-checkpoint-module-"));
}

function setupTools(
  store: ReturnType<typeof createCheckpointStore>,
  options: Parameters<typeof createCheckpointModule>[1],
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  createCheckpointModule(store, options).setup({
    registerTool: (registered) => tools.push(registered),
    addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
    notify: () => {},
  });
  return tools;
}

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const registered = tools.find((value) => value.metadata.name === name);
  assert.ok(registered, `missing ${name}`);
  return registered;
}

const context = { toolCallId: "checkpoint-test", messages: [], context: {} };

describe("createCheckpointModule", () => {

  it("registers only the frozen checkpoint tools and metadata", async () => {
    const root = await createWorkspace();
    const tools = setupTools(createCheckpointStore(root), { threadId: "thread-a" });
    assert.deepEqual(tools.map(({ metadata }) => metadata), [
      { name: "checkpoint_prepare", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
      { name: "checkpoint_get", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
      { name: "checkpoint_save", version: "1", risk: "write", timeoutMs: 5_000, idempotent: false },
    ]);
  });

  it("declares the checkpoint cards and adds its instructions", async () => {
    const root = await createWorkspace();
    const host = createModuleHost([createCheckpointModule(createCheckpointStore(root), { threadId: "thread-a", workspaceRoot: "/ws" })], { notify() {} });
    assert.deepEqual([...host.toolPermissions.keys()], ["checkpoint_prepare", "checkpoint_get", "checkpoint_save"]);
    const card = (toolName: string, input: unknown) => host.toolPermissions.get(toolName)!.confirmation!(
      { toolName, input } as Parameters<NonNullable<ToolPermissionFacts["confirmation"]>>[0]);
    for (const declared of host.toolPermissions.values()) assert.equal(declared.defaults, undefined);
    assert.equal(card("checkpoint_get", { version: 2 }),
      '\nTool: checkpoint_get\nWorkspace: "/ws"\nThis reads the current checkpoint version 2 and does not verify referenced files on disk.\nAllow this call? [y/n] ');
    assert.match(String(card("checkpoint_prepare", {})), /\nThis reads the current checkpoint and injectable Memory into model context/);
    assert.equal(card("checkpoint_save", { expectedVersion: 1, draft: { goal: "g" } }),
      '\nTool: checkpoint_save\nWorkspace: "/ws"\nExpected current version: 1\nComplete draft:\n{\n  "goal": "g"\n}\n' +
      "After confirmation, the program will try to record current Git HEAD/branch/dirty; if Git inspection fails, it saves without a pin.\n" +
      "This will save the next checkpoint version. Allow this call? [y/n] ");
    assert.match(host.instructions("checkpoint"), /^ When project checkpoint tools are available, use checkpoint_get only/);
    host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("prepares only current checkpoint and injectable memory without a model or transcript reader", async () => {
    const root = await createWorkspace();
    const store = createCheckpointStore(root, { generateId: () => "checkpoint-1" });
    const saved = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
    });
    assert.equal(saved.ok, true);
    let memoryReads = 0;
    const tools = setupTools(store, {
      threadId: "thread-b",
      getInjectableMemories: async () => {
        memoryReads += 1;
        return [{ id: "memory-1", text: "Prefer small changes." }];
      },
    });
    const prepared = await toolByName(tools, "checkpoint_prepare").tool.execute!({}, context);
    assert.equal(memoryReads, 1);
    assert.equal((prepared as { ok: boolean }).ok, true);
    assert.deepEqual(prepared, {
      ok: true,
      current: saved.ok ? saved.checkpoint : null,
      memories: [{ id: "memory-1", text: "Prefer small changes." }],
    });
    assert.equal(JSON.stringify(prepared).includes("history"), false);
  });

  it("returns no memories when Memory is disabled and reports preparation errors as data", async () => {
    const root = await createWorkspace();
    const store = createCheckpointStore(root);
    const toolsWithoutMemory = setupTools(store, { threadId: "thread-a" });
    assert.deepEqual(
      await toolByName(toolsWithoutMemory, "checkpoint_prepare").tool.execute!({}, context),
      { ok: true, current: null, memories: [] },
    );

    const toolsWithUnreadableMemory = setupTools(store, {
      threadId: "thread-a",
      getInjectableMemories: async () => { throw new Error("memory read failed"); },
    });
    assert.deepEqual(
      await toolByName(toolsWithUnreadableMemory, "checkpoint_prepare").tool.execute!({}, context),
      { ok: false, error: { code: "CHECKPOINT_READ_FAILED", message: "memory read failed" } },
    );
    assert.deepEqual(await store.getCurrent(), { ok: true, current: null });
  });

  it("returns a corrupt checkpoint error as tool data without replacing the file", async () => {
    const root = await createWorkspace();
    const directory = join(root, ".runloom");
    await mkdir(directory);
    const file = join(root, CHECKPOINT_FILE_NAME);
    await writeFile(file, "{broken", "utf8");
    const tools = setupTools(createCheckpointStore(root), { threadId: "thread-a" });

    assert.deepEqual(
      await toolByName(tools, "checkpoint_prepare").tool.execute!({}, context),
      {
        ok: false,
        error: { code: "CHECKPOINT_FILE_INVALID", message: "Checkpoint file must contain valid JSON" },
      },
    );
    assert.equal(await readFile(file, "utf8"), "{broken");
  });

  it("reads current or retained versions and surfaces missing-version errors", async () => {
    const root = await createWorkspace();
    const store = createCheckpointStore(root);
    const tools = setupTools(store, { threadId: "thread-a" });
    const save = toolByName(tools, "checkpoint_save").tool;
    await save.execute!({ expectedVersion: null, draft: draft() }, context);
    await save.execute!({ expectedVersion: 1, draft: draft({ summary: "version two" }) }, context);
    const get = toolByName(tools, "checkpoint_get").tool;
    const current = await get.execute!({}, context) as { checkpoint?: { version: number } };
    assert.equal(current.checkpoint?.version, 2);
    const old = await get.execute!({ version: 1 }, context) as { checkpoint?: { version: number } };
    assert.equal(old.checkpoint?.version, 1);
    assert.deepEqual(await get.execute!({ version: 99 }, context), {
      ok: false,
      error: { code: "CHECKPOINT_VERSION_NOT_FOUND", message: "Checkpoint version 99 is not available" },
    });
  });

  it("binds the save source to the active thread and rejects stale versions", async () => {
    const root = await createWorkspace();
    const store = createCheckpointStore(root, { generateId: () => "checkpoint-1" });
    const tools = setupTools(store, { threadId: "thread-bound" });
    const save = toolByName(tools, "checkpoint_save").tool;
    const created = await save.execute!({ expectedVersion: null, draft: draft() }, context) as {
      ok: boolean;
      checkpoint?: { source: { threadId: string }; version: number };
    };
    assert.equal(created.ok, true);
    assert.equal(created.checkpoint?.source.threadId, "thread-bound");
    assert.equal(created.checkpoint?.version, 1);
    assert.deepEqual(await save.execute!({ expectedVersion: null, draft: draft() }, context), {
      ok: false,
      error: { code: "CHECKPOINT_VERSION_CONFLICT", message: "Current checkpoint version is 1; expected none" },
    });
    const current = await store.getCurrent();
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.current?.version, 1);
  });

  it("captures a Git pin only for the save, and omits it if the optional inspection fails", async () => {
    const root = await createWorkspace();
    const store = createCheckpointStore(root);
    let captures = 0;
    const gitPin = {
      head: "a".repeat(40),
      branch: "main",
      dirty: false,
      observedAt: "2026-09-23T00:00:00.000Z",
    };
    const tools = setupTools(store, {
      threadId: "thread-a",
      captureGitPin: async () => {
        captures += 1;
        if (captures === 1) return gitPin;
        throw new Error("not a Git repository");
      },
    });
    const save = toolByName(tools, "checkpoint_save").tool;
    const first = await save.execute!({ expectedVersion: null, draft: draft() }, context) as {
      ok: boolean; checkpoint?: { realityPins?: { git: typeof gitPin } };
    };
    assert.equal(first.ok, true);
    assert.deepEqual(first.checkpoint?.realityPins, { git: gitPin });
    const second = await save.execute!({ expectedVersion: 1, draft: draft() }, context) as {
      ok: boolean; checkpoint?: { realityPins?: { git: typeof gitPin } };
    };
    assert.equal(second.ok, true);
    assert.equal(second.checkpoint?.realityPins, undefined);
    assert.equal(captures, 2);
  });

  it("requires exact bounded inputs", async () => {
    const root = await createWorkspace();
    const tools = setupTools(createCheckpointStore(root), { threadId: "thread-a" });
    const prepareInput = toolByName(tools, "checkpoint_prepare").tool.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const getInput = toolByName(tools, "checkpoint_get").tool.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const saveInput = toolByName(tools, "checkpoint_save").tool.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(prepareInput.safeParse({}).success, true);
    assert.equal(prepareInput.safeParse({ turns: 8 }).success, false);
    assert.equal(getInput.safeParse({ version: 1 }).success, true);
    assert.equal(getInput.safeParse({ version: 1, threadId: "other" }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: null, draft: draft() }).success, true);
    assert.equal(saveInput.safeParse({ draft: draft() }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: 0, draft: draft() }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: null, draft: { ...draft(), unsupported: true } }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: null, draft: { ...draft(), realityPins: { git: {} } } }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: null, draft: draft(), realityPins: { git: {} } }).success, false);
    assert.equal(saveInput.safeParse({ expectedVersion: null, draft: { ...draft(), completed: Array(13).fill("item") } }).success, false);
    assert.equal(
      saveInput.safeParse({
        expectedVersion: null,
        draft: draft({ goal: "a".repeat(CHECKPOINT_LIMITS.goalBytes) }),
      }).success,
      true,
    );
    assert.equal(
      saveInput.safeParse({
        expectedVersion: null,
        draft: draft({ goal: "a".repeat(CHECKPOINT_LIMITS.goalBytes + 1) }),
      }).success,
      false,
    );
    const cjkOverLimit = Math.floor(CHECKPOINT_LIMITS.goalBytes / 3) + 1;
    assert.equal(
      saveInput.safeParse({
        expectedVersion: null,
        draft: draft({ goal: "界".repeat(cjkOverLimit) }),
      }).success,
      false,
    );
  });
});
