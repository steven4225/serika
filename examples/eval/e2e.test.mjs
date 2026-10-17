import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTuiArgs } from '@serika/assistant/internal/cli-options.js';
import { resolveTuiModuleConfig } from '@serika/assistant/internal/tui-module-config.js';
import { fixtureConfig, fixtureRuntimeEnvironment, collectEvidence, collectMemorySnapshot, createFixtureApprover, safeError, currentRestoreFixtureFact } from './e2e.mjs';
import { resolveModelContextWindow } from '@serika/assistant/internal/model-config.js';
import { reliabilityCases, reliabilitySpec } from './reliability-cases.mjs';
import { contextBudgetForMode, estimateMessageTokens, partitionMessagesForCompaction, keepRecentCompactionUnits } from '@serika/assistant/internal/context-budget.js';
import { summarySourceChunks } from '@serika/assistant/internal/context-compactor.js';
import { dailyCompactionCases, dailyCompactionSpec, fixtureHistory } from './daily-compaction.mjs';
import { compactionFidelityCases, compactionFidelitySpec, effectiveCompactionFidelityCases, effectiveCompactionFidelitySpec } from './compaction-fidelity.mjs';
import { createMemoryStore } from '@serika/assistant/internal/memory-store.js';
import { createMemoryConsolidation } from '@serika/assistant/internal/memory-consolidation.js';
import { AUTO_CONSOLIDATION_AGENT_ID } from '@serika/assistant/internal/consolidation.js';

test('restore fixture explicitly approves only the matching real pending coffee source before exercising restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-eval-restore-test-'));
  try {
    const store = createMemoryStore(root);
    const text = '我喝咖啡加糖。';
    const service = createMemoryConsolidation({ store, threadId: 'eval', writePolicy: 'automatic',
      getMessages: async () => [{ id: 'u2', role: 'user', parts: [{ type: 'text', text }] }] });
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: 'incremental' }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: 'add', kind: 'preference', text,
      factIdentity: { attribute: 'coffee', scenario: 'general', value: 'sweetened' }, reason: '待审核偏好', eligibility: 'needs_review',
      sourceMessageId: 'u2', sourceQuote: text }], outcomes: [{ messageId: 'u2', status: 'extracted' }] }); assert.ok(staged.ok);
    const finalized = await service.finalize({ status: 'completed' }); assert.ok(finalized.ok);
    const app = { memoryStore: store }, actions = [];
    await assert.rejects(currentRestoreFixtureFact(root, app, 'eval', { userMessageId: 'unrelated', input: text }, actions), /EXPECTED_MEMORY_MISSING/);
    assert.equal(actions.length, 0, 'unrelated pending must not receive broad fixture approval');
    const current = await currentRestoreFixtureFact(root, app, 'eval', { userMessageId: 'u2', input: text }, actions);
    assert.equal(current.assertion.factIdentity.value, 'sweetened');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'approve_fixture_current');
    const candidates = await store.listCandidates({ status: 'pending' }, undefined, { boundThreadId: 'eval' }); assert.ok(candidates.ok);
    assert.equal(candidates.value.candidates.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daily-level fixture uses production mode budgets and enough history to trigger actual compression', () => {
  for (const mode of ['daily', 'long-task']) {
    const spec = dailyCompactionSpec(mode === 'daily' ? 'RD04' : 'RL04');
    const expected = contextBudgetForMode(mode);
    assert.deepEqual(fixtureConfig(spec, '/isolated/workspace').contextCompaction, expected);
    const seed = fixtureHistory(spec);
    assert.ok(estimateMessageTokens(seed.messages) >= expected.inputBudgetTokens * .85,
      '12K-scale filler must not be labelled as a daily-level pressure test');
    assert.equal(seed.metadata.messageCount, seed.messages.length);
    assert.equal(seed.metadata.utf8Bytes, Buffer.byteLength(JSON.stringify(seed.messages)));
    assert.deepEqual(seed.metadata.contextBudget, expected);
  }
});

test('daily-scale keys enter safe compressed prefixes, separate facts span 32K blocks, and incremental IDs do not collide', () => {
  assert.equal(dailyCompactionCases.length, 16);
  for (const definition of dailyCompactionCases) {
    const spec = dailyCompactionSpec(definition.id), seed = fixtureHistory(spec), budget = spec.contextBudget;
    const messages = [...seed.messages, { id: 'live-question', role: 'user', parts: [{ type: 'text', text: spec.turns[0] }] }];
    const partition = partitionMessagesForCompaction(messages);
    const { kept, omitted } = keepRecentCompactionUnits([...partition.history, ...partition.current], budget.keepRecentTokens);
    assert.ok(omitted.every(u => u.completeToolCalls), spec.id);
    assert.ok(seed.metadata.keyMessages.every(k => k.index < kept[0].startIndex), `${spec.id}: answering from raw key text is not a compression pass`);
    assert.equal(new Set(seed.messages.map(m => m.id)).size, seed.messages.length);
    assert.ok(seed.metadata.estimatedHistoryTokens >= budget.inputBudgetTokens * budget.triggerRatio);
    const chunks = summarySourceChunks(omitted, budget.summaryInputChunkTokens, 16);
    assert.ok(chunks.length > 1);
    if (spec.kind === 'compact_chunks') {
      const blocks = seed.metadata.keyMessages.map(k => chunks.findIndex(chunk => chunk.some(m => m.id === k.id)));
      assert.ok(blocks.every(b => b >= 0));
      assert.equal(new Set(blocks).size, 3, 'three facts actually start in three separate summary chunks');
    }
    if (spec.kind === 'compact_tool') {
      assert.ok(chunks.some(chunk => ['seed-call', 'seed-result'].every(id => chunk.some(m => m.id === id))), 'tool pair cannot be split');
    }
    if (spec.kind === 'compact_incremental') {
      const next = fixtureHistory(spec, 1);
      assert.ok(next.metadata.estimatedHistoryTokens >= budget.inputBudgetTokens * budget.triggerRatio);
      assert.equal(new Set([...seed.messages, ...next.messages].map(m => m.id)).size, seed.messages.length + next.messages.length);
    }
  }
});

test('each memory turn retains independent before/after raw store, pending list and actual source clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-eval-snapshot-test-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(join(workspace, '.runloom'), { recursive: true });
    let pending = [];
    const app = { memoryStore: { list: async () => ({ ok: true, entries: [] }),
      listCandidates: async () => ({ ok: true, value: { candidates: pending } }) } };
    const before = await collectMemorySnapshot(workspace, app, 'eval');
    await writeFile(join(workspace, '.runloom/memory.json'), '{"version":4,"entries":[]}');
    pending = [{ id: 'actual-pending' }];
    const after = await collectMemorySnapshot(workspace, app, 'eval');
    assert.equal(before.raw.present, false); assert.equal(before.raw.text, null);
    assert.equal(before.pending.length, 0);
    assert.equal(after.raw.text, '{"version":4,"entries":[]}');
    assert.equal(after.pending[0].id, 'actual-pending');
    pending[0].id = 'later';
    assert.equal(after.pending[0].id, 'actual-pending', 'later turns cannot mutate an earlier snapshot');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('eval error evidence redacts provider key formats without reading credentials', () => {
  const result = safeError(new Error('user_fakeEvaluationSecret123 sk-fakeEvaluationSecret456 Bearer fakeEvaluationSecret789 api_key=anotherFakeSecret'));
  assert.equal(result.message, '[REDACTED] [REDACTED] [REDACTED] api_key=[REDACTED]');
});
test('restart fixture requests an actual edit rather than impossible write_file overwrite', async () => {
  const cases = JSON.parse(await readFile(new URL('./e2e-cases.json', import.meta.url), 'utf8'));
  const spec = cases.find(c => c.id === 'R02');
  assert.match(spec.afterRestart, /edit_file/);
  assert.doesNotMatch(spec.afterRestart, /write_file/);
  assert.match(spec.afterRestart, /BEFORE_RESTART/);
  assert.match(spec.afterRestart, /AFTER_RESTART/);
});

test('eval approval waits for preview and records only actual acknowledgement, without losing the later ready event', () => {
  const approvals = [], decisions = [];
  let accepting = false;
  const approve = createFixtureApprover({ kind: 'create' }, false, input => { decisions.push(input); return accepting; }, approvals);
  const event = { type: 'approval', approval: { approvalId: 'a1', toolName: 'write_file', input: { path: 'notes/report.md' }, preview: '' } };
  approve(event);
  assert.equal(decisions.length, 0);
  event.approval.preview = 'Create notes/report.md?';
  approve(event);
  assert.equal(approvals.length, 0);
  accepting = true; approve(event); approve(event);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].allowed, true);
  assert.equal(decisions.length, 2);
});

test('all frozen fixture configs are accepted by the real runtime resolver without calling a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-eval-config-test-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const cases = [...JSON.parse(await readFile(new URL('./e2e-cases.json', import.meta.url), 'utf8')),
      ...reliabilityCases.flatMap(c => [0, 1, 2].map(v => reliabilitySpec(c.id, v))),
      ...dailyCompactionCases.map(c => dailyCompactionSpec(c.id)),
      ...compactionFidelityCases.map(c => compactionFidelitySpec(c.id)),
      ...effectiveCompactionFidelityCases.map(c => effectiveCompactionFidelitySpec(c.id))];
    for (const spec of cases) {
      const config = join(root, 'config.json');
      await writeFile(config, JSON.stringify(fixtureConfig(spec, workspace)));
      const resolved = await resolveTuiModuleConfig(parseTuiArgs([join(root, 'transcripts'), '--config', config]), { cwd: root });
      assert.equal(resolved.enabled.memory, spec.category === 'memory', spec.id);
      assert.equal(resolved.enabled.shell, false);
      assert.equal(resolved.enabled.web, false);
      assert.equal(resolved.contextCompaction.enabled, spec.category === 'compaction');
      if (spec.suite === 'compaction-fidelity-effective') {
        assert.deepEqual(resolved.contextCompaction, spec.requestedContextBudget);
        assert.deepEqual(resolved.modelContextWindows, spec.modelContextWindows);
        const callerEnv = { RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: 'deepseek/deepseek-v4.1-flash-fast',
          COMMAND_CODE_CONTEXT_WINDOW_TOKENS: '1000000' };
        const actual = resolveModelContextWindow({ provider: 'openai-compatible.chat', modelId: callerEnv.COMMAND_CODE_MODEL_ID },
          fixtureRuntimeEnvironment(spec, callerEnv), resolved.modelContextWindows);
        assert.equal(actual.contextWindowTokens, 32768);
        assert.equal(actual.source, 'configuration');
        assert.equal(callerEnv.COMMAND_CODE_CONTEXT_WINDOW_TOKENS, '1000000', 'caller environment is not mutated');
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure evidence keeps available artifact and marks unreadable stores instead of inventing empty state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-eval-evidence-test-'));
  try {
    await mkdir(join(root, 'workspace/notes'), { recursive: true });
    await writeFile(join(root, 'workspace/notes/report.md'), 'actual partial artifact');
    const failure = async () => { throw new Error('store is unreadable'); };
    const result = await collectEvidence(root, {}, {
      store: { getContextCompactions: failure }, executionRecords: { listModelUsage: failure },
      memoryStore: { list: failure, listConsolidationMaterial: failure, listCandidates: failure,
        getConsolidationReceipt: failure, getConsolidationCursor: failure },
    }, { getHistory: failure, listRuns: failure, getMemoryReferences: () => null, getContextDiagnostics: failure },
    { threadId: 'eval', phases: [], error: { code: 'RUN_FAILED', message: 'actual run failure' } });
    assert.equal(result.artifact, 'actual partial artifact');
    assert.equal(result.memories, undefined);
    assert.equal(result.coverage, undefined);
    assert.ok(result.readErrors.some(e => e.field === 'memories'));
    assert.equal(result.error.code, 'RUN_FAILED');
  } finally { await rm(root, { recursive: true, force: true }); }
});
