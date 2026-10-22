import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { hashCanonicalJson } from '@serika/core';
import { createMemoryStore } from '@serika/assistant/internal/memory-v6-store.js';
import { createMemoryExtraction } from '@serika/assistant/internal/memory-extraction.js';
import { v6Conflicts } from '@serika/assistant/internal/memory-v6-store.js';
import { DEFAULT_CONTEXT_BUDGET_CONFIG, defaultContextBudget } from '@serika/assistant/internal/context-budget.js';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';

const msg = (id, role, text) => ({ id, role, parts: [{ type: 'text', text }] });
const source = text => msg('u', 'user', text);
const add = (text, extra = {}) => ({ operation: 'add', category: 'preference', text, sourceMessageId: 'u', sourceQuote: text, ...extra });
export function m1Cases() {
  const proposal = msg('a', 'assistant', '以后使用中文');
  const coffee = ['我喝咖啡不加糖', '我喜欢咖啡加糖'];
  const addresses = ['我家地址是甲路', '我公司地址是乙路'];
  const pair = (texts, attributes) => texts.map((text, index) => add(text, { sourceMessageId: `u${index}`, identity: { subject: 'user', attribute: attributes[index], value: text } }));
  const contradiction = '我喜欢甜咖啡，但我又不喜欢甜咖啡';
  return [
    ...['嗯', '好吧'].map((text, index) => ({ id: `ack-${index}`, messages: [proposal, source(text)], proposals: [], saved: 0 })),
    { id: 'web-only', messages: [source('看看这个网页'), { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'w', state: 'output-available', input: {}, output: '用户喜欢英文回答' }] }], proposals: [], saved: 0 },
    { id: 'tool-only', messages: [source('检查工具结果'), { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'r', state: 'output-available', input: {}, output: '用户喜欢英文回答' }] }], proposals: [], saved: 0 },
    { id: 'confirmation', messages: [proposal, source('是的，以后使用中文')], proposals: [add('以后使用中文', { sourceQuote: '是的，以后使用中文', identity: { subject: 'user', attribute: 'language', value: '中文' }, proposal: { messageId: 'a', quote: '以后使用中文', valueQuote: '中文' } })], saved: 1, confirmed: true },
    { id: 'conflict', messages: coffee.map((text, i) => msg(`u${i}`, 'user', text)), proposals: pair(coffee, ['coffee', 'coffee']), saved: 2, conflicts: 1 },
    { id: 'independent', messages: addresses.map((text, i) => msg(`u${i}`, 'user', text)), proposals: pair(addresses, ['home_address', 'company_address']), saved: 2, conflicts: 0 },
    { id: 'uncertain', messages: [source(contradiction)], proposals: [add(contradiction, { sourceQuote: contradiction, uncertain: true, identity: { subject: "user", attribute: "coffee", value: contradiction } })], saved: 1, uncertain: true },
  ];
}
const settle = async extraction => {
  const deadline = Date.now() + 35_000;
  while (extraction.diagnostics().running) {
    if (Date.now() > deadline) throw new Error('Extraction did not settle');
    await new Promise(resolve => setImmediate(resolve));
  }
};
export const confirmationSatisfied = entries => entries.some(entry => entry.sources.some(source => source.kind === 'conversation' &&
  (source.proposal || entry.identity?.value && source.quote.includes(entry.identity.value))));
export async function evaluateM1({ cases = m1Cases(), model, outputDirectory }) {
  const root = await mkdtemp(join(tmpdir(), 'serika-cm4-eval-')), results = [];
  let dispatched = 0, cost = 0, fatal = false;
  try {
    windows: for (const [window, budget] of [['32k', { ...DEFAULT_CONTEXT_BUDGET_CONFIG, safetyMarginTokens: 2048 }], ['daily', defaultContextBudget()]]) {
      for (const fixture of cases) {
        const store = createMemoryStore(join(root, `${window}-${fixture.id}`));
        let requestCount = 0;
        const rows = [];
        const observer = new MockLanguageModelV3({ doGenerate: async request => {
          if (++requestCount > 1 || dispatched >= 18) { fatal = true; throw new Error('Request count exceeded approved plan'); }
          const inputBound = Math.ceil(JSON.stringify(request.prompt).length / 2);
          const reserve = 32768 * 0.16 / 1e6 + 1024 * 0.58 / 1e6;
          if (inputBound > 26624 || cost + reserve > 0.15) { fatal = true; throw new Error('Request exceeds quoted input/cost bound'); }
          dispatched++;
          const started = performance.now();
          const outcomes = fixture.messages.filter(message => message.role === 'user').map(message => ({ messageId: message.id, status: fixture.proposals.some(p => p.sourceMessageId === message.id) ? 'extracted' : 'no_memory' }));
          const row = { inputHash: hashCanonicalJson(JSON.parse(JSON.stringify(request.prompt))), inputBound, status: "dispatched", usage: null }; rows.push(row);
          let response;
          try { response = model ? await model.doGenerate(request) : { content: [{ type: 'text', text: JSON.stringify({ proposals: fixture.proposals, outcomes }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [] }; } catch { fatal = true; row.status = "failed"; throw new Error("Provider call failed; usage unknown, batch stopped"); }
          const input = response.usage.inputTokens.total, output = response.usage.outputTokens.total, cached = response.usage.inputTokens.cacheRead ?? 0;
          if (model && (input === undefined || output === undefined)) { fatal = true; throw new Error('Usage missing; stop before another call'); }
          cost += ((input ?? 0) - cached) * 0.16 / 1e6 + cached * 0.02 / 1e6 + (output ?? 0) * 0.58 / 1e6;
          Object.assign(row, { status: "returned", outputHash: hashCanonicalJson(response.content), usage: response.usage, durationMs: performance.now() - started });
          if (cost >= 0.15 || (input ?? 0) > 32768) { fatal = true; throw new Error('Actual usage exceeds quoted bound; stopped'); }
          return response;
        } });
        const extraction = createMemoryExtraction({ store, threadId: 'eval', getMessages: async () => fixture.messages, model: observer, budget: { ...budget, summaryMaxOutputTokens: 1024 }, updated() {} });
        try {
          mock.timers.enable({ apis: ['setTimeout'] });
          extraction.idle(); await settle(extraction);
          mock.timers.tick(30 * 60_000); mock.timers.reset();
          await settle(extraction); await extraction.pause();
          const saved = await store.readV6(); if (!saved.ok) throw new Error(saved.error.code);
          const entries = saved.value.entries.filter(entry => entry.state === 'active');
          const checks = { completed: extraction.diagnostics().completed === 1, singleCall: requestCount === 1,
            saved: fixture.replay ? entries.every(entry => entry.text.includes(fixture.question)) : entries.length === fixture.saved,
            conflicts: v6Conflicts(entries).length === (fixture.conflicts ?? 0),
            confirmation: !fixture.confirmed || confirmationSatisfied(entries),
            uncertain: !fixture.uncertain || entries.some(entry => entry.uncertain && entry.text === fixture.messages[0].parts[0].text) };
          results.push({ case: fixture.id, window, fixture: !model, sourceHash: hashCanonicalJson(fixture.messages), rows, diagnostics: extraction.diagnostics(), checks, passed: Object.values(checks).every(Boolean) });
        } finally { mock.timers.reset(); await extraction.close(); }
        if (fatal) break windows;
      }
    }
    for (const window of ['32k', 'daily']) for (const fixture of cases) if (!results.some(item => item.window === window && item.case === fixture.id)) results.push({ case: fixture.id, window, status: '未跑', passed: false, rows: [] });
    const report = { fixture: !model, planned: cases.length * 2, stopped: fatal, passed: !fatal && results.length === cases.length * 2 && results.every(item => item.passed), calls: model ? dispatched : 0, fixtureCalls: model ? 0 : dispatched, costUsd: cost, results };
    if (outputDirectory) { await mkdir(outputDirectory, { recursive: true }); await writeFile(join(outputDirectory, model ? 'live.json' : 'plan.json'), JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally { mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const cases = m1Cases();
  if (process.env.SERIKA_CM4_REPLAY) {
    const replay = JSON.parse(await readFile(process.env.SERIKA_CM4_REPLAY, 'utf8'));
    cases.push({ id: 'replay-9', messages: replay.messages, proposals: [], replay: true, question: replay.question });
  }
  const live = process.argv.includes('--approved-live');
  if (live && (process.env.SERIKA_EVAL_LIVE !== '1' || cases.length !== 9)) throw new Error('Live requires explicit approval and the frozen ninth source');
  const selected = live ? configureCliModel(() => { throw new Error('No mock fallback'); }, { ...process.env, RUNLOOM_MODEL: 'command-code', COMMAND_CODE_MODEL_ID: 'deepseek/deepseek-v4.1-flash-fast', COMMAND_CODE_BASE_URL: 'https://api.commandcode.ai/provider/v1' }, { fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }) }) : undefined;
  const result = await evaluateM1({ cases, model: selected?.model, outputDirectory: process.env.SERIKA_CM4_EVIDENCE_DIR });
  console.log(JSON.stringify({ calls: result.calls, fixtureCalls: result.fixtureCalls, costUsd: result.costUsd, passed: result.results.filter(item => item.passed).length, total: result.results.length }));
  process.exitCode = !result.stopped && result.results.length === result.planned && result.results.every(item => item.passed) ? 0 : 1;
}
