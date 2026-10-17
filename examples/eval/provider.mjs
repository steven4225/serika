import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { JsonlAgentStore } from '@serika/core';
import { createRuntimeApp } from '@serika/assistant/internal/app.js';
import { createAssistantController } from '@serika/assistant/internal/assistant-controller.js';
import { createDemoModel } from '@serika/assistant/internal/demo-model.js';
import { configureCliModel, inspectCliModelConfig } from '@serika/assistant/internal/model-config.js';
import { ContextCompactor } from '@serika/assistant/internal/context-compactor.js';
import { runE2E } from './e2e.mjs';
import { consolidationPrefixHash } from '@serika/assistant/internal/memory-consolidation.js';

/** Only an explicit offline deferred-fault case may inspect an unfinished receipt. */
export function expectedDeferredCoverage(vars, mode, consolidation, receipt, cursor, messages) {
  return Boolean(mode === 'offline' && vars.offlineOnly === true && vars.expected?.coverage === 'deferred' && vars.expected?.cursorAdvanced === false &&
    consolidation.error === 'MEMORY_EXTRACTION_DEFERRED' && receipt?.threadId === 'eval' && receipt.processedCount === 0 &&
    receipt.outcomes?.some(outcome => outcome.status === 'deferred' && outcome.attempts >= 1 && outcome.attempts < 3) &&
    cursor === null && receipt.sourcePrefix && consolidationPrefixHash(messages, receipt.sourcePrefix.throughMessageId) === receipt.sourcePrefix.prefixHash);
}

export function requireLive(env) {
  if (env.SERIKA_EVAL_LIVE !== '1') throw new Error('真实模型评测需显式设置 SERIKA_EVAL_LIVE=1，可能产生费用');
  const config = inspectCliModelConfig(env);
  if (config.alias === 'mock/default' || config.error) throw new Error(config.error ?? 'live 评测禁止回退 mock；请设置 RUNLOOM_MODEL');
}

function textStream(text) {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: text }, { type: 'text-end', id: 'answer' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    } },
  ] }) };
}

function scriptedModel(vars) {
  if (vars.scenario === 'deny') return createDemoModel();
  let extraction = 0;
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const latest = [...prompt].reverse().find(message => message.role === 'user');
    const text = latest?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
    if (!text.startsWith('Extract only from this host-prepared material.')) return textStream('收到。');
    const material = JSON.parse(text.slice(text.indexOf('\n') + 1));
    const source = material.turns.at(-1).user;
    const proposals = (vars.extractions[extraction++] ?? []).map(proposal => ({
      action: 'add', ...proposal, sourceMessageId: source.messageId, sourceQuote: proposal.sourceQuote ?? source.text, reason: '离线脚本化提案，不是模型效果证明',
    }));
    return textStream(JSON.stringify({ batchId: material.batchId, proposals,
      outcomes: material.turns.map(turn => ({ messageId: turn.user.messageId, status: proposals.length ? 'extracted' : 'no_memory' })) }));
  } });
}

async function settle(controller) {
  const deadline = Date.now() + 150_000;
  while (controller.getSnapshot().state.kind !== 'idle') {
    if (Date.now() >= deadline) {
      await controller.cancel();
      throw new Error('评测超时；不作为空结果或成功');
    }
    await delay(10);
  }
}

async function budgetCase(root) {
  const store = new JsonlAgentStore({ directory: join(root, 'budget') });
  let summaryCalls = 0;
  const compactor = new ContextCompactor({ store, threadId: 'eval', modelId: 'fixture',
    budget: { enabled: true, contextWindowTokens: 1000, maxOutputTokens: 100, safetyMarginTokens: 100,
      keepRecentTokens: 100, summaryMaxOutputTokens: 100 },
    fixedContext: () => ({ instructions: '固定材料'.repeat(1500), tools: [] }),
    summarizer: { complete: async () => { summaryCalls++; throw new Error('不应调用摘要模型'); } },
  });
  try {
    await compactor.prepare([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }] }], new AbortController().signal);
    return { budgetRejected: false, summaryCalls };
  } catch (error) {
    if (error.data?.code !== 'CONTEXT_PREPARE_FAILED') throw error;
    return { budgetRejected: true, summaryCalls, failureReason: error.message };
  }
}

export default class SerikaProvider {
  // Do not let promptfoo silently retry an entire multi-turn agent scenario.
  config = { maxRetries: 0 };
  id() { return `serika:${process.env.SERIKA_EVAL_MODE ?? 'offline'}`; }
  async callApi(_prompt, context) {
    const mode = process.env.SERIKA_EVAL_MODE ?? 'offline';
    if (!['offline', 'live'].includes(mode)) throw new Error('未知评测模式');
    if (mode === 'live') requireLive(process.env);
    const vars = context.vars;
    if (vars.caseId) {
      if (mode !== 'live') throw new Error('E2E task scores require real model mode, not scripted outputs');
      return runE2E(vars.caseId, vars.variant ?? 0);
    }
    if (vars.turns !== undefined && !Array.isArray(vars.turns)) throw new Error('turns 必须是完整消息数组；请禁用 promptfoo 变量展开');
    if (!['chat', 'deny', 'memory', 'budget'].includes(vars.scenario)) throw new Error('未知评测场景');
    if (mode === 'live' && vars.offlineOnly) throw new Error('故障注入案例只能离线运行');
    // No user-controlled workspace/config path; every case owns its temporary data.
    const root = await mkdtemp(join(tmpdir(), 'serika-promptfoo-'));
    let controller;
    try {
      if (vars.scenario === 'budget') return { output: await budgetCase(root), metadata: { mode, layer: 'context-budget', modelCalled: false } };
      const workspace = join(root, 'workspace'); await mkdir(workspace);
      const config = join(root, 'config.json');
      const memory = vars.scenario === 'memory';
      await writeFile(config, JSON.stringify({ version: 1, workspace,
        modules: { memory: { enabled: memory, autoConsolidate: memory, writePolicy: memory ? 'automatic' : 'review' } } }));
      const selected = mode === 'live' ? configureCliModel(createDemoModel) : { modelAlias: 'eval/scripted', model: scriptedModel(vars) };
      const output = new PassThrough(); output.resume();
      const app = await createRuntimeApp({ directory: join(root, 'transcripts'), assistant: { threadId: 'eval', configPath: config },
        ...selected, output, cwd: root, env: mode === 'live' ? process.env : {} });
      controller = createAssistantController(app);
      let approvals = 0;
      controller.subscribe(event => {
        if (event.type === 'approval') { approvals++; controller.confirm({ approvalId: event.approval.approvalId, decision: 'deny' }); }
      });
      await controller.runs.list();
      for (const text of vars.turns ?? [vars.input]) {
        const started = await controller.run(text);
        if (!started.ok) throw new Error(started.error.message);
        await settle(controller);
        const snapshot = controller.getSnapshot();
        if (snapshot.lastPrimaryResult?.status !== 'completed') throw new Error(snapshot.lastPrimaryResult?.error?.message ?? '主执行未完成');
        if (snapshot.lastConsolidationResult && snapshot.lastConsolidationResult.status !== 'completed') throw new Error('记忆整理执行未完成');
        if (memory) {
          const maintenance = await controller.memory.getMaintenance();
          if (!maintenance.ok) throw new Error('读取记忆整理状态失败');
          const attempt = maintenance.value.consolidation.lastAttempt;
          if (attempt && ['failed', 'uncertain', 'cancelled'].includes(attempt.status)) {
            const receipt = await app.memoryStore.getConsolidationReceipt('eval');
            const cursor = await app.memoryStore.getConsolidationCursor('eval');
            if (!receipt.ok || !cursor.ok || !expectedDeferredCoverage(vars, mode, maintenance.value.consolidation,
              receipt.value, cursor.value, await app.store.getMessages('eval'))) {
              throw new Error(`记忆整理未完成落盘：${maintenance.value.consolidation.error ?? attempt.message ?? attempt.status}`);
            }
          }
        }
      }
      const memories = memory ? await app.memoryStore.list() : { ok: true, entries: [] };
      const pending = memory ? await app.memoryStore.listCandidates({ status: 'pending' }, undefined, { boundThreadId: 'eval' }) : { ok: true, value: { candidates: [] } };
      const receipt = memory ? await app.memoryStore.getConsolidationReceipt('eval') : { ok: true, value: null };
      const cursor = memory ? await app.memoryStore.getConsolidationCursor('eval') : { ok: true, value: null };
      const material = memory ? await app.memoryStore.listConsolidationMaterial(undefined, { boundThreadId: 'eval' }) : { ok: true, value: [] };
      if (![memories, pending, receipt, cursor, material].every(result => result.ok)) throw new Error('读取保存状态失败');
      const history = await controller.getHistory();
      const users = new Map(history.filter(message => message.role === 'user').map(message => [message.id,
        message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')]));
      const sourceValid = memories.entries.every(entry => {
        const assertion = material.value.find(item => item.id === entry.id)?.relatedAssertions.find(item => item.assertionId === entry.assertion?.assertionId);
        return assertion?.sources.length > 0 && assertion.sources.every(source =>
          source.kind === 'conversation' && source.threadId === 'eval' && source.quote.length > 0 && users.get(source.messageId)?.includes(source.quote));
      });
      const runs = await app.executionRecords.listRuns('eval');
      const snapshot = controller.getSnapshot();
      const maintenance = memory ? await controller.memory.getMaintenance() : null;
      return { output: { status: snapshot.lastPrimaryResult.status, reply: snapshot.lastPrimaryResult.text,
        saved: memories.entries.filter(entry => entry.enabled !== false && entry.status === 'active').length,
        pending: pending.value.candidates.length, approvals, sourceValid,
        toolStarts: runs.flatMap(run => run.tools).filter(tool => tool.startedAt != null).length,
        coverage: receipt.value?.outcomes.at(-1)?.status ?? null, cursorAdvanced: cursor.value !== null,
        memories: memories.entries.map(entry => ({ text: entry.text, identity: entry.assertion?.factIdentity })),
      }, metadata: { mode, model: selected.modelAlias, layer: 'controller-runtime', nativeElectron: 'not_run', usageAccounting: 'not_reported', maintenance } };
    } finally {
      try { await controller?.shutdown(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}
