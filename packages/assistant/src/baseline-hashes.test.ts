import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { hashCanonicalJson, JsonlAgentStore } from "@serika/core";
import { compactPrefixHash } from "./context-compaction.js";
import { creationReceipt } from "./creation-idempotency.js";
import { candidateFingerprint, type CandidateDraft } from "./memory-candidates.js";
import { consolidationPrefixHash } from "./memory-consolidation.js";
import { memorySemanticTextHash } from "./memory-retrieval.js";
import { recipeHash } from "./recipe-store.js";
import { rssItemKey } from "./rss-subscriptions.js";
import { createBuiltinSkill } from "./skill-catalog.js";
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

const source = { kind: "conversation" as const, threadId: "thread-a", messageId: "u1", quote: "我喝咖啡不加糖。" };
const v1Draft = { reason: "r", source,
  change: { operation: "add", text: "用户喝咖啡不加糖。", scope: { kind: "workspace" }, expiresAt: null } } as unknown as CandidateDraft;
const v2Draft = { reason: "r", source, sources: [source],
  change: { operation: "add", text: "用户喝咖啡不加糖。", scope: { kind: "thread", threadId: "thread-a" }, expiresAt: null, kind: "preference" } } as unknown as CandidateDraft;
const v3Draft = { reason: "r", source,
  change: { operation: "add", text: "用户喝咖啡不加糖。", scope: { kind: "workspace" }, expiresAt: null,
    factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } } } as unknown as CandidateDraft;

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "serika-baseline-hash-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
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
  out["memory candidate fingerprint v1"] = candidateFingerprint("thread-a", v1Draft);
  out["memory candidate fingerprint v2"] = candidateFingerprint("thread-a", v2Draft);
  out["memory candidate fingerprint v3"] = candidateFingerprint("thread-a", v3Draft);
  out["memory consolidation prefix"] = consolidationPrefixHash(messages, "u2") ?? "undefined";
  out["memory semantic text hash"] = memorySemanticTextHash("咖啡偏好");
  out["recipe hash"] = recipeHash({ id: "test", description: "Run tests", command: "pnpm test", cwd: "." } as Parameters<typeof recipeHash>[0]);
  out["rss item key (id)"] = rssItemKey({ id: "guid-1", url: "https://example.com/a", title: "T" } as Parameters<typeof rssItemKey>[0]);
  out["rss item key (url)"] = rssItemKey({ url: "https://example.com/a", title: "T" } as Parameters<typeof rssItemKey>[0]);
  out["rss item key (fallback)"] = rssItemKey({ title: "T", publishedAt: "2026-01-01T00:00:00Z" } as Parameters<typeof rssItemKey>[0]);
  out["skill hash"] = createBuiltinSkill({ id: "memory-consolidate", description: "Host memory consolidation",
    kind: "memory-consolidate", instructions: "Use committed sources; host owns finalization.", agentId: "memory-consolidator" }).hash;
  out["task result workspace key"] = taskResultWorkspaceKey("/tmp/work");
  out["task result link"] = taskResultLink("/tmp/work", "task-1");
  out["task worker launchd label"] = basename(createTaskWorkerService({ workspace: "/tmp/work", nodePath: "/usr/bin/node",
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
    const lease = await createWorkTaskStore(root).claimThread("thread-a");
    try { return (await readdir(join(root, ".runloom"))).filter(name => name.startsWith(".work-task-owner-")).join(","); } finally { await lease.release(); }
  });
  return out;
}

describe("v2 pilot baseline: persisted hash golden samples", () => {
  it("every reachable persisted hash matches __baseline__/hashes.json", async () => {
    const actual = JSON.stringify(await samples(), null, 2) + "\n";
    const file = fileURLToPath(new URL("../src/__baseline__/hashes.json", import.meta.url));
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, actual);
    assert.equal(actual, await readFile(file, "utf8"));
  });
});
