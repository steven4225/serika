import assert from 'node:assert/strict';
import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOpenFault } from './cm-step6-open-fault.mjs';
const repo = process.cwd();
const root = await realpath(await mkdtemp(join(tmpdir(), 'cm6-open-probe-')));
await mkdir(join(root, 'workspace')); await mkdir(join(root, 'home'));
await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, workspace: join(root, 'workspace'), modules: { 'read-file': { enabled: true } } }));
const env = Object.fromEntries(['PATH', 'USER', 'TMPDIR', 'DISPLAY', 'XAUTHORITY'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
Object.assign(env, { HOME: join(root, 'home'), RUNLOOM_USER_DATA: join(root, 'profile'), RUNLOOM_MODEL: 'mock', RUNLOOM_DESKTOP_TEST: '1', RUNLOOM_CONFIG: join(root, 'config.json'), RUNLOOM_TRANSCRIPTS: join(root, 'transcripts') });
let app;
try {
  app = await electron.launch({ args: [join(repo, 'apps/desktop/out/main/index.js')], env, cwd: root });
  const page = await app.firstWindow();
  await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  const fault = await app.evaluate(installOpenFault, join(root, 'workspace/probe.txt'));
  const result = await app.evaluate(async (_e, { workspace, repo }) => {
    const { pathToFileURL } = process.getBuiltinModule('url');
    const vm = process.getBuiltinModule('vm');
    // Inspector evaluation has no import callback; Node's main loader owns these ESM imports.
    const importESM = vm.compileFunction('return import(url)', ['url'], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const { createWriteFileTool } = await importESM(pathToFileURL(repo + '/packages/assistant/dist/write-file.js').href);
    const { AiSdkAgentLoop, ToolRegistry, InMemoryModelRegistry } = await importESM(pathToFileURL(repo + '/packages/ai-sdk-adapter/dist/index.js').href);
    const { MockLanguageModelV3 } = await importESM(pathToFileURL(repo + '/packages/assistant/node_modules/ai/dist/test/index.js').href);
    let mockModelCalls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      mockModelCalls++;
      return { stream: new ReadableStream({ start(controller) {
        for (const chunk of [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'probe-write', toolName: 'write_file', input: JSON.stringify({ path: 'probe.txt', content: 'must never reach disk' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } } }]) controller.enqueue(chunk);
        controller.close();
      } }) };
    } });
    const events = []; let outcome;
    try {
      await new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools: new ToolRegistry([{ metadata: { name: 'write_file', version: '1', risk: 'write', timeoutMs: 1000, idempotent: false }, tool: createWriteFileTool(workspace) }]) }).execute({
        definition: { id: 'test', version: '1', instructions: 'Write once', model: 'test', tools: ['write_file'], limits: { maxSteps: 2, totalTimeoutMs: 5000, stepTimeoutMs: 2000 } },
        messages: [{ id: 'probe-user', role: 'user', parts: [{ type: 'text', text: 'Write probe.txt once' }] }], signal: new AbortController().signal, generateId: () => 'probe-assistant',
        emit: async (type, data) => events.push({ type, data }),
      });
      outcome = 'unexpected-success';
    } catch (error) { outcome = error.data?.code ?? error.name; }
    await new Promise(resolve => setTimeout(resolve, 1900));
    return { electron: process.versions.electron, mockModelCalls, outcome, fault: globalThis.__cm6WriteFault, exists: process.getBuiltinModule('fs').existsSync(workspace + '/probe.txt'), events };
  }, { workspace: join(root, 'workspace'), repo });
  assert.equal(result.outcome, 'TOOL_OUTCOME_UNKNOWN');
  assert.equal(result.mockModelCalls, 1); assert.equal(result.fault.matched, 1);
  assert.equal(result.fault.delegatedTargetOpens, 0); assert.equal(result.fault.released, 1); assert.equal(result.exists, false);
  assert.ok(result.events.some(event => event.type === 'tool.call.failed' && event.data.error.code === 'TOOL_OUTCOME_UNKNOWN'));
  console.log(JSON.stringify({ runId: randomUUID(), generatedAt: new Date().toISOString(), kind: 'zero-model-native-open-fault-probe', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), faultScriptSha256: createHash('sha256').update(await readFile(new URL('./cm-step6-open-fault.mjs', import.meta.url))).digest('hex'), fault, result, realModelCalls: 0, costUsd: 0 }));
} finally {
  if (app) {
    const cleanupDeadline = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } finally { clearTimeout(cleanupDeadline); }
  }
  await rm(root, { recursive: true, force: true });
}
