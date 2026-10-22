import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { meteredModel, safeFailure, chargedUsd, pastReadSucceeded, goalMentioned, oldGoalMentioned, summarizeBatch, uncertainMentioned, runChat } from './cm-step6-live.mjs';
import { configureCliModel } from '@serika/assistant/internal/model-config.js';
import { evaluateM1, m1Cases } from './cm-step4.mjs';

test('combined batch reserves before dispatch, meters each actual request, and freezes unknown usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm6-meter-'));
  try {
    const path = join(root, 'meter.json'); let calls = 0;
    const request = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], maxOutputTokens: 1024 };
    const underlying = new MockLanguageModelV3({ doGenerate: async () => { calls++; return { content: [], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: calls === 1 ? 100 : undefined, cacheRead: undefined, cacheWrite: undefined, noCache: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } }, warnings: [] }; } });
    await writeFile(path, JSON.stringify({ costUsd: 2.4999, calls: [], stopped: false }));
    let model = await meteredModel(underlying, path, () => 'test');
    await assert.rejects(model.doGenerate(request), /reserve exceeded/); assert.equal(calls, 0);
    await writeFile(path, JSON.stringify({ costUsd: 0, calls: [], stopped: false }));
    model = await meteredModel(underlying, path, () => 'test');
    await generateText({ model, prompt: 'SDK boundary fixture', maxOutputTokens: 1024, maxRetries: 0 }); const first = JSON.parse(await readFile(path));
    assert.equal(first.calls[0].status, 'returned'); assert.equal(first.calls[0].usage.cacheRead, null); assert.ok(first.costUsd > 0);
    await assert.rejects(model.doGenerate(request), /batch stopped/); assert.equal(calls, 2);
    await assert.rejects(model.doGenerate(request), /frozen/); assert.equal(calls, 2);
    assert.equal(JSON.parse(await readFile(path)).stopped, true);
    await writeFile(path, JSON.stringify({ costUsd: 0, priorChargedUsd: chargedUsd({ amount: 2.499, unresolvedReservedUsd: 0.0009 }), calls: [], stopped: false }));
    model = await meteredModel(underlying, path, () => 'test');
    await assert.rejects(model.doGenerate(request), /reserve exceeded/); assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure diagnostics retain status, code, finish and schema paths without messages or upstream bodies', () => {
  const failure = Object.assign(new Error('private prompt sk-secret-sentinel'), { name: 'APIError', statusCode: 400,
    responseBody: JSON.stringify({ error: { code: 'invalid_request_error', param: 'response_format', message: 'sk-secret-sentinel' } }),
    cause: { name: 'TypeValidationError', finishReason: 'stop', issues: [{ path: ['proposals', 0, 'category'], message: 'sk-secret-sentinel' }] } });
  const diagnostic = safeFailure(failure);
  assert.equal(diagnostic.chain[0].httpStatus, 400); assert.equal(diagnostic.chain[0].code, 'invalid_request_error');
  assert.equal(diagnostic.chain[0].parameter, 'response_format'); assert.equal(diagnostic.chain[1].finishReason, 'stop');
  assert.deepEqual(diagnostic.chain[1].schemaPaths, ['proposals.0.category']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|sentinel|message|responseBody/);
});

test('pastRead recognizes long receipt clauses without accepting failed, unknown, future or unrelated writes', () => {
  for (const reply of [
    '之前读取 notes/fixture.txt：成功，状态 completed（回执 fidelity-read）。',
    '读取 notes/fixture.txt 的回执为 completed（成功）。',
    '此前读取 notes/fixture.txt 的回执为 completed（成功）。',
    '已成功读取 notes/fixture.txt。',
    '**之前的文件读取是否成功、能否因此再次读取**：此前对 notes/fixture.txt 的读取回执状态为 completed（成功）。',
    '**之前的文件读取是否成功，能否因此再次读取**：notes/fixture.txt 的读取曾返回 completed 回执。',
  ]) assert.equal(pastReadSucceeded(reply), true, reply);
  for (const reply of [
    '读取 notes/fixture.txt 未成功。', '尚未完成读取 notes/fixture.txt。',
    '读取失败，写入成功。', '读取结果未知；写入完成。',
    '如获批准，将读取 notes/fixture.txt，预计成功。', '能否读取成功？', '是否读取成功：结果未知。',
  ]) assert.equal(pastReadSucceeded(reply), false, reply);
});

test('extraction JSON Schema stays in prompt text; the configured provider sends no structured-output parameter', async () => {
  const requests = [];
  const { model } = configureCliModel(() => { throw new Error('unexpected fallback'); }, {
    RUNLOOM_MODEL: 'command-code', COMMAND_CODE_API_KEY: 'fixture-key', COMMAND_CODE_MODEL_ID: 'deepseek/deepseek-v4.1-flash-fast',
  }, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return new Response(JSON.stringify({ id: 'fixture', model: body.model, created: 0, object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ proposals: [], outcomes: [{ messageId: 'u', status: 'no_memory' }] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const result = await evaluateM1({ cases: [m1Cases()[0]], model });
  assert.equal(result.passed, true); assert.equal(result.results.every(item => item.passed), true); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.response_format, undefined); assert.equal(request.tools, undefined);
    assert.match(JSON.stringify(request.messages), /Exact response JSON Schema/);
  }
  const rejected = await evaluateM1({ cases: [m1Cases()[4]], model });
  assert.equal(rejected.passed, false);
});

test('new-batch goal check accepts qualifiers while rejecting unknown, denied and different goals', () => {
  for (const text of ['目标：完成验收报告。', '目标：完成验收主项目的验收报告。', '完成验收主项目验收报告。', '目标是完成本轮验收报告。',
    '目标：完成本地文件方案的验收报告（暗号 FIDELITY-42），并补充失败样本整理入报告。',
    '目标：完成本项目第一阶段的验收报告。']) assert.equal(goalMentioned(text), true, text);
  for (const text of ['目标：未知。', '目标：完成另一项目的验收报告。', '目标不是完成验收报告。', '不再完成验收报告。', '完成调研后审阅验收报告。', '是否完成验收报告？无法确认。']) assert.equal(goalMentioned(text), false, text);
});

test('M1 live evidence separates literal-value rejection reasons and retains only field positions and lengths', async () => {
  const quote = '我家地址是甲路', conditional = '我喝咖啡不加糖，低血糖时除外';
  const cases = [
    { id: 'quote', quote, text: quote, sourceQuote: quote, value: '乙路', reasonCode: 'QUOTE_VALUE_MISSING', field: 'user.text' },
    { id: 'source', quote, text: quote, sourceQuote: '我家地址是', value: '甲路', reasonCode: 'SOURCE_VALUE_MISSING', field: 'sourceQuote' },
    { id: 'body', quote, text: '我家地址已记录', sourceQuote: quote, value: '甲路', reasonCode: 'BODY_VALUE_MISSING', field: 'text' },
    { id: 'number', quote: '我每周跑5公里', text: '我每周跑6公里', sourceQuote: '我每周跑5公里', value: '跑', reasonCode: 'NUMBER_UNIT_MISMATCH', field: 'text' },
    { id: 'condition', quote: conditional, text: '我喝咖啡不加糖', sourceQuote: conditional, value: '不加糖', reasonCode: 'CONDITION_CLAUSE_MISSING', field: 'text' },
    { id: 'proposal', quote: '是的，以后使用中文', text: '以后使用中文', sourceQuote: '是的，以后使用中文', value: '中文', reasonCode: 'QUOTE_VALUE_MISSING', field: 'proposal.quote',
      proposal: { messageId: 'a', quote: '以后使用', valueQuote: '中文' } },
  ];
  const result = await evaluateM1({ cases: cases.map(item => ({ id: item.id, saved: 1,
    messages: [...(item.proposal ? [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: '以后使用中文' }] }] : []),
      { id: 'u', role: 'user', parts: [{ type: 'text', text: item.quote }] }],
    proposals: [{ operation: 'add', category: 'preference', sourceMessageId: 'u', sourceQuote: item.sourceQuote, text: item.text,
      identity: { subject: 'user', attribute: 'fixture', value: item.value }, ...(item.proposal ? { proposal: item.proposal } : {}) }],
  })) });
  assert.equal(result.calls, 0); assert.equal(result.fixtureCalls, 12);
  for (const row of result.results) {
    const item = cases.find(item => item.id === row.case), failure = row.diagnostics.validationFailure;
    assert.equal(row.checks.completed, false); assert.equal(row.checks.saved, false);
    assert.equal(failure?.reasonCode, item.reasonCode, `${row.case}/${row.window}`);
    assert.equal(failure.field, item.field); assert.equal(failure.valueLength, Array.from(item.value).length);
    assert.equal(failure.proposalIndex, 0); assert.ok(Number.isInteger(failure.fieldLength));
    assert.doesNotMatch(JSON.stringify(failure), /甲路|乙路|咖啡|公里|中文|sourceQuote"\s*:/);
    console.info("CM_STEP6_METRICS " + JSON.stringify({ case: row.case, window: row.window, validationFailure: failure, realModelCalls: result.calls }));
  }
});

test('new live evidence reports both goal rules, safe key-value counts and every C5 preparation', () => {
  const reply = '完成验收主项目的验收报告';
  assert.equal(oldGoalMentioned(reply), false); assert.equal(goalMentioned(reply), true);
  const diagnostic = { lastPreparation: { outcome: 'reused', summaryLayer: { borrowedTokens: 384, borrowLimitTokens: 2496 },
    degradation: { reasons: ['summary_overflow', 'checklist_overflow'], maskedFromMessageId: '1', maskedThroughMessageId: '9' } } };
  const summary = summarizeBatch([{ suite: 'M1', planned: 18, passed: false, results: [{ passed: false, diagnostics: { validationFailure: { reasonCode: 'SOURCE_VALUE_MISSING' } } }] },
    { suite: 'CF03', passed: false, rounds: [{ generation: 0, passed: true, passedOldRule: false, preparations: [{ stage: 'mask', diagnostics: diagnostic.lastPreparation }],
      chat: { reply, passedByRule: { old: false, new: true }, diagnostics: diagnostic } }] },
    { suite: 'CF05', passed: false, rounds: [] }, { suite: 'CE03', passed: false, rounds: [] }, { suite: 'CE05', passed: false, rounds: [] }]);
  assert.equal(summary.keyValueFailures.SOURCE_VALUE_MISSING, 1); assert.equal(summary.keyValueFailures.QUOTE_VALUE_MISSING, 0);
  assert.deepEqual(summary.scores.map(score => [score.suite, score.newRule?.total ?? score.total]), [['M1', 18], ['CF03', 3], ['CF05', 5], ['CE03', 3], ['CE05', 5]]);
  assert.equal(summary.scores[1].newRule.passed, 1); assert.equal(summary.scores[1].oldRule.passed, 0);
  assert.equal(summary.qualifiedAnswers[0].reply, reply); assert.equal(summary.c5.count, 2);
  assert.equal(summary.c5.providerPreparationCount, 1); assert.equal(summary.c5.totalBorrowedTokensAcrossPreparations, 768);
});

test('approved goal rule scopes negation to the goal and accepts quoted titles', () => {
  for (const text of ['按已确认方案完成验收主项目的验收报告，并补齐尚未完成的验收材料。', '完成「验收主项目验收报告」。', '不更换本地文件方案并完成验收报告。']) assert.equal(goalMentioned(text), true, text);
  for (const text of ['不再需要完成验收报告。', '目标尚未确定，不能确认是否需要完成验收报告。', '不需要再继续完成验收报告。']) assert.equal(goalMentioned(text), false, text);
});

test('complete user confirmation value does not require an assistant proposal', async () => {
  const fixture = m1Cases().find(item => item.id === 'confirmation');
  const result = await evaluateM1({ cases: [{ ...fixture, proposals: fixture.proposals.map(({ proposal, ...rest }) => rest) }] });
  assert.equal(result.calls, 0); assert.equal(result.results.every(row => row.checks.confirmation && row.passed), true);
});


test('approved uncertain rule accepts actual unknown effects and rejects affirmative write success', () => {
  for (const reply of ['写入结果是 TOOL_OUTCOME_UNKNOWN，即不确定、效果未知，不能视为成功。',
    'write_file 对 notes/uncertain.txt 的结果为 unknown，不能视为已写入。', '读取成功；写入效果未知。',
    '写入结果 unknown（既不确认成功也不确认失败）。']) assert.equal(uncertainMentioned(reply), true, reply);
  for (const reply of ['写入成功。', '写入已完成。', '之前读取 unknown；写入已完成。',
    '写入结果未知，但写入已完成。', '读取状态 unknown。写入状态未说明。', '写入状态 unknown，已完成。', '写入结果未说明。天气 unknown。']) assert.equal(uncertainMentioned(reply), false, reply);
});

test('short acknowledgments cannot use a proposed value absent from the user quote', async () => {
  const fixture = m1Cases().find(item => item.id === 'confirmation');
  const result = await evaluateM1({ cases: [{ ...fixture, messages: [fixture.messages[0], { id: 'u', role: 'user', parts: [{ type: 'text', text: '嗯' }] }],
    proposals: fixture.proposals.map(proposal => ({ ...proposal, sourceQuote: '嗯' })) }] });
  assert.equal(result.calls, 0); assert.equal(result.results.every(row => !row.checks.completed && !row.checks.saved && !row.checks.confirmation), true);
});

test('recorded reference keeps the source bytes and formal scores frozen', async () => {
  const { writeReference } = await import('./cm-step6-regrade.mjs');
  const source = new URL('../../docs/v2-pilot/evidence/cm-step6/live-d67682ad-0722-43d9-af5c-8c7aef1308fa.json', import.meta.url);
  const before = await readFile(source), result = await writeReference({});
  assert.equal(result.formalScoresChanged, false); assert.equal(result.realModelCalls, 0); assert.equal(result.costUsd, 0);
  assert.deepEqual(await readFile(source), before); assert.equal(result.sourceSha256, 'b7264a5a558f9d08ff8aec2f7e55c8e640cf9d88f912a7d0557f6a64372a5226');
  assert.deepEqual(result.scores.map(score => [score.suite, score.recordedPassed, score.referencePassed]),
    [['M1', 12, 14], ['CF03', 1, 2], ['CF05', 1, 2], ['CE03', 0, 1], ['CE05', 1, 1]]);
  assert.equal(result.validationReasonCounts.UNCERTAIN_QUOTE_MISMATCH, 2);
  assert.equal(result.flips.length, 10); assert.equal(result.flips.filter(flip => flip.sourceKind === 'recorded_model_reply').length, 8);
  assert.equal(result.rows.find(row => row.suite === 'CE05' && row.generation === 'cold').missing, true);
});


test('actual Controller archives the primary reply before a background summary failure', async () => {
  const { JsonlAgentStore } = await import('@serika/core');
  const { effectiveCompactionFidelitySpec, compactionFidelityHistory } = await import('./compaction-fidelity.mjs');
  const root = await mkdtemp(join(tmpdir(), 'cm6-cold-archive-')), answerArchive = join(root, 'primary.json');
  const reply = '完成验收报告。采用本地文件方案，补充失败样本。部署未获批准。写入结果 unknown，不能自动重试。读取已完成，但需新的批准。';
  let backgroundCalls = 0, observedArchive = null;
  const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };
  const response = text => ({ stream: simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: text },
      { type: 'text-end', id: 'answer' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ] }) });
  let streamedCalls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    if (++streamedCalls === 1) return response(reply);
    backgroundCalls++;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { observedArchive = JSON.parse(await readFile(answerArchive, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(observedArchive?.reply, reply); assert.equal(observedArchive?.stage, 'primary-returned');
    return response('invalid summary output after primary archive');
  } });
  try {
    const spec = effectiveCompactionFidelitySpec('CE03');
    const store = new JsonlAgentStore({ directory: join(root, 'transcripts') });
    await store.save('eval', compactionFidelityHistory(spec, 0).messages);
    const result = await runChat({ model, modelAlias: 'archive-fixture', root, spec, question: spec.turns[0], label: 'cold-process', answerArchive });
    assert.equal(backgroundCalls, 1); assert.equal(result.usageCalls, 2); assert.equal(result.reply, reply); assert.equal(observedArchive.backgroundSettled, false);
    assert.equal(result.checks.completed, true); assert.equal(result.checks.backgroundSettled, false); assert.equal(result.passed, false);
    assert.equal(JSON.parse(await readFile(answerArchive, 'utf8')).reply, reply);
  } finally { await rm(root, { recursive: true, force: true }); }
});
