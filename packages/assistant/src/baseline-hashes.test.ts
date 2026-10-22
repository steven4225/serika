import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { encodeTranscriptUpdate, hashCanonicalJson, JsonlAgentStore } from "@serika/core";
import { dreamingThreadIdFor } from "./assistant-controller.js";
import { compactPrefixHash } from "./context-compaction.js";
import { creationReceipt } from "./creation-idempotency.js";
import { createHash } from "node:crypto";
import { recipeHash } from "./recipe-store.js";
import { rssItemKey } from "./rss-subscriptions.js";
import { createBuiltinSkill } from "./skill-catalog.js";
import { createDreamingService } from "./dreaming.js";
import { createMemoryStore } from "./memory-v6-store.js";
import type { WorkTask, WorkTaskStore } from "./work-task-store.js";
import type { ExecutionRecordStore, ExecutionRunRecord } from "./execution-record-store.js";
import { taskResultLink, taskResultWorkspaceKey } from "./task-result-link.js";
import { createTaskWorkerService } from "./task-worker-service.js";
import { createExecutionRecordStore, createWorkTaskStore, createWriteFileTool } from "./testing.js";

/**
 * v2 pilot step 1 baseline (docs/architecture-v2.md §4.4, docs/v2-pilot/hashes.md):
 * one golden sample for each persisted hash reachable through an existing
 * export, without touching product code. Every value below is written to
 * disk or used as a durable name today; changing any of them breaks data
 * that already exists. Never regenerate for a refactor:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 is only for an explicitly confirmed format change.
 */

const messages = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "我喝咖啡不加糖。" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "记下了。" }] },
  { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
] as UIMessage[];

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "serika-baseline-hash-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Two human-accepted, completed tasks with fixed fields: what `dreaming.prepare()` selects into one batch. */
function dreamingSources(root: string) {
  const stamp = "2026-10-01T00:00:00.000Z", tasks: WorkTask[] = [], runs = new Map<string, ExecutionRunRecord>();
  for (const id of ["task-a", "task-b"]) {
    const runId = `run-${id}`;
    tasks.push({ id, revision: 5, threadId: `thread-${id}`, goal: "整理项目复盘，先结论再列可执行步骤", constraints: [], status: "completed", runIds: [runId], reconciliations: [], createdAt: stamp, updatedAt: stamp,
      acceptance: [{ id: "quality", description: "复盘简明且步骤能执行", method: "human", verification: { kind: "human" }, required: true, status: "passed", evidenceRefs: [`human-${id}`], note: "已核对结论与两条步骤，符合要求" }],
      delivery: { summary: "先写一行结论，再写两条可执行步骤", artifactRefs: [], unresolved: [], evidence: [{ id: `human-${id}`, kind: "human", criterionId: "quality", acceptedAt: stamp }] } } as WorkTask);
    runs.set(runId, { runId, threadId: `thread-${id}`, workTaskId: id, phase: "primary", status: "completed", startedAt: stamp, finishedAt: stamp,
      resultTextPreview: "done", resultTextTruncated: false, errorPreview: null, tools: [] } as ExecutionRunRecord);
  }
  const workTasks = { list: async () => ({ ok: true, value: structuredClone(tasks) }) } as unknown as WorkTaskStore;
  const executionRecords: Pick<ExecutionRecordStore, "getRun"> = { getRun: async (_threadId, id) => structuredClone(runs.get(id) ?? null) };
  return createDreamingService({ filePath: join(root, ".runloom/dreaming.json"), workTasks, executionRecords });
}

async function samples(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out["core hashCanonicalJson"] = hashCanonicalJson({ b: [1, "é", null, true], a: { z: 1.5, y: "x" } });
  out["core transcript file name"] = await withRoot(async root => {
    const store = new JsonlAgentStore({ directory: root });
    await store.save("thread-a", [messages[0]!]);
    return (await readdir(root)).filter(name => name.endsWith(".jsonl")).join(",");
  });
  out["context compaction prefix"] = compactPrefixHash(messages, 2);
  out["creation receipt requestHash"] = creationReceipt("op-1", { b: 2, a: { d: undefined, c: [1, { y: 1, x: 2 }] } })!.requestHash;
  out["memory semantic text hash"] = createHash("sha256").update("咖啡偏好", "utf8").digest("hex");
  out["recipe hash"] = recipeHash({ id: "test", description: "Run tests", command: "pnpm test", cwd: "." } as Parameters<typeof recipeHash>[0]);
  out["rss item key (id)"] = rssItemKey({ id: "guid-1", url: "https://example.com/a", title: "T" } as Parameters<typeof rssItemKey>[0]);
  out["rss item key (url)"] = rssItemKey({ url: "https://example.com/a", title: "T" } as Parameters<typeof rssItemKey>[0]);
  out["rss item key (fallback)"] = rssItemKey({ title: "T", publishedAt: "2026-01-01T00:00:00Z" } as Parameters<typeof rssItemKey>[0]);
  out["skill hash"] = createBuiltinSkill({ id: "memory-consolidate", description: "Host memory consolidation",
    kind: "memory-consolidate", instructions: "Use committed sources; host owns finalization.", agentId: "memory-consolidator" }).hash;
  out["task result workspace key"] = taskResultWorkspaceKey("/tmp/work");
  out["task result link"] = taskResultLink("/tmp/work", "task-1");
  out["task worker launchd label"] = basename(createTaskWorkerService({ applicationHome: "/tmp/work", workspace: "/tmp/work", nodePath: "/usr/bin/node",
    workerEntryPath: "/opt/worker.js", workingDirectory: "/opt", launchAgentsDirectory: "/tmp/LaunchAgents", uid: 501,
    platform: "darwin", runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as Parameters<typeof createTaskWorkerService>[0]).plistPath);
  out["write_file receipt sha256"] = await withRoot(async root => {
    const write = createWriteFileTool(root);
    const result = await write.execute!({ path: "a.md", content: "你好\n" }, { toolCallId: "c1", messages: [], context: {} }) as { sha256?: string };
    return String(result.sha256);
  });
  out["execution owner lock name"] = await withRoot(async root => {
    const lease = await createExecutionRecordStore(root).claimThread("thread-a");
    try { return (await readdir(root)).filter(name => name.startsWith(".execution-owner-")).join(","); } finally { await lease.release(); }
  });
  out["work task owner lock name"] = await withRoot(async root => {
    const lease = await createWorkTaskStore(root, { filePath: join(root, ".runloom/work-tasks.json") }).claimThread("thread-a");
    try { return (await readdir(join(root, ".runloom"))).filter(name => name.startsWith(".work-task-owner-")).join(","); } finally { await lease.release(); }
  });
  // Added in step 3 (docs/v2-pilot/pending.md A.1–A.2): reached through the stores' public API and the
  // files they write, so the product code is unchanged.
  const committed = JSON.parse(encodeTranscriptUpdate("thread-a", [messages[0]!], [messages[0]!, messages[1]!]).at(-1)!) as { baseHash: string; payloadHash: string };
  out["core transcript committed baseHash"] = committed.baseHash;
  out["core transcript committed payloadHash"] = committed.payloadHash;
  out["dreaming batch fingerprint"] = await withRoot(async root => {
    const prepared = await dreamingSources(root).prepare();
    assert.ok(prepared.ok && prepared.value, "two accepted tasks make one batch");
    return prepared.value.fingerprint;
  });
  out["dreaming thread id (workspace)"] = dreamingThreadIdFor("/tmp/work", "thread-a");
  out["dreaming thread id (no workspace)"] = dreamingThreadIdFor(undefined, "thread-a");
  return out;
}

describe("v2 pilot baseline: persisted hash golden samples", () => {
  it("every reachable persisted hash matches __baseline__/hashes.json", async () => {
    const actual = JSON.stringify(await samples(), null, 2) + "\n";
    const file = fileURLToPath(new URL("../src/__baseline__/hashes.json", import.meta.url));
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, actual);
    const retired = ["memory candidate fingerprint v1", "memory candidate fingerprint v2", "memory candidate fingerprint v3", "memory consolidation prefix", "memory import snapshot (empty memory)", "memory import receipt requestHash", "memory consolidation receipt payloadHash"];
    const expected = JSON.parse(await readFile(file, "utf8"));
    for (const key of retired) delete expected[key];
    assert.deepEqual(JSON.parse(actual), expected);
  });
});
