import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { resolveTuiModuleConfig } from "./tui-module-config.js";

describe("memory upgrade trusted configuration", () => {
  it("keeps legacy defaults and explicitly resolves the local endpoint and derived view", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-upgrade-config-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const file = join(root, "config.json");
    const resolve = () => resolveTuiModuleConfig({ configPath: file }, { cwd: root });
    try {
      await writeFile(file, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
      let config = await resolve();
      assert.equal(config.memorySemantic, undefined);
      assert.equal(config.memoryContextViewEnabled, false);
      await writeFile(file, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic: { enabled: true, modelId: "fixture" }, contextView: { enabled: true } } } }));
      config = await resolve();
      assert.deepEqual(config.memorySemantic, { provider: "local", baseURL: "http://127.0.0.1:11434/v1", modelId: "fixture" });
      assert.equal(config.memoryContextViewEnabled, true);
      await writeFile(join(workspace, "config.json"), JSON.stringify({ version: 1, workspace: ".", modules: { memory: { enabled: true, semantic: { enabled: true } } } }));
      await assert.rejects(resolveTuiModuleConfig({ configPath: join(workspace, "config.json") }, { cwd: workspace }), /outside the workspace/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("resolves explicit cloud defaults from trusted config without a literal credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-upgrade-cloud-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const file = join(root, "config.json");
    try {
      await writeFile(file, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic: { enabled: true, provider: "dashscope" } } } }));
      const config = await resolveTuiModuleConfig({ configPath: file }, { cwd: root });
      assert.deepEqual(config.memorySemantic, { provider: "dashscope", modelId: "qwen3.7-text-embedding-flash", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
      for (const semantic of [{ enabled: true, provider: "other" }, { enabled: true, provider: "dashscope", apiKey: "fixture-secret" },
        { enabled: true, provider: "dashscope", baseURL: "https://untrusted.example/v1" }]) {
        await writeFile(file, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic } } }));
        await assert.rejects(resolveTuiModuleConfig({ configPath: file }, { cwd: root }));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects remote/credential endpoints and switches enabled without the memory module", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-upgrade-invalid-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const file = join(root, "config.json");
    try {
      for (const memory of [
        { enabled: true, semantic: { enabled: true, baseURL: "https://provider.example/v1" } },
        { enabled: true, semantic: { enabled: true, baseURL: "http://key:secret@127.0.0.1/v1" } },
        { enabled: false, semantic: { enabled: true } },
        { enabled: false, contextView: { enabled: true } },
        { enabled: true, semantic: { enabled: true, apiKey: "must-not-be-configured" } },
      ]) {
        await writeFile(file, JSON.stringify({ version: 1, workspace, modules: { memory } }));
        await assert.rejects(resolveTuiModuleConfig({ configPath: file }, { cwd: root }));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
