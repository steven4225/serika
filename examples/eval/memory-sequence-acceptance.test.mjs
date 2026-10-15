import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreSequenceRound, sequenceCases, summarizeSequence, runMemorySequence, hasSequenceFalsePersistenceClaim } from './memory-sequence-acceptance.mjs';
import { createTransitionFetch, transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

function fixture(index) {
  const testCase = sequenceCases[index], threadId = 'isolated', userMessageId = `u${index}`;
  const source = { kind: 'conversation', threadId, messageId: userMessageId, quote: testCase.input };
  const fact = { id: 'coffee', enabled: true, status: 'active', temporalState: 'applicable', revision: index === 0 ? 1 : 2,
    scope: { kind: 'thread', threadId }, source, text: index === 0 ? '我喝咖啡不加糖。' : '我喝咖啡加糖。',
    assertion: { factIdentity: { attribute: 'coffee', scenario: 'general', value: testCase.value } } };
  const rawEntry = { id: 'coffee', versions: [{ revision: 1 }, ...(index ? [{ revision: 2 }] : [])],
    assertions: [{ factIdentity: { value: 'unsweetened' }, validTime: { to: index ? '2026-10-15T00:00:00Z' : null } }] };
  const after = { formal: [fact], raw: { entries: [rawEntry] }, pending: [], previews: [], readErrors: [] };
  const row = { caseId: testCase.id, threadId, userMessageId, before: { formal: [], pending: [], readErrors: [] }, after,
    modelVerified: true, phases: { primary: 'completed', consolidation: 'completed' },
    phaseResults: [{ phase: 'primary', text: '正在整理，请以程序回执为准。' }],
    requests: ['primary', 'consolidation'].map(phase => ({ phase, dispatched: true, blocked: false, httpStatus: 200, modelId: transitionModel.modelId })),
    receipts: [{ threadId, sourceMessageId: userMessageId, text: index === 0 ? '当时已保存：不加糖' : index === 1 ? '当时已更新：加糖' : '记忆需要你确认：不加糖；原记忆没有被覆盖' }] };
  if (index === 2) {
    const previous = fixture(1);
    row.before = structuredClone(previous.after);
    row.after.formal = structuredClone(previous.after.formal);
    row.after.raw = structuredClone(previous.after.raw);
    const candidate = { id: 'review', originThreadId: threadId, status: 'pending', staleReason: null, source,
      change: { operation: 'change', memoryId: 'coffee', expectedRevision: 2, text: '我喝咖啡不加糖。',
        factIdentity: { attribute: 'coffee', scenario: 'general', value: 'unsweetened' } } };
    after.pending.push(candidate); after.previews.push({ candidate, applicable: true });
  }
  return row;
}
const previous = [fixture(0), fixture(1)];

test('three dependent rounds start without seed and require real persisted progression', () => {
  assert.equal(sequenceCases.length, 3);
  assert.deepEqual(sequenceCases.map(row => row.input), [
    '【升级验收1015A】仅在当前对话里，请记住：我喝咖啡不加糖。',
    '从现在起，仅在当前对话里，我喝咖啡改成加糖。',
    '仅在当前对话里，我喝咖啡不加糖。',
  ]);
  for (let index = 0; index < 3; index++) assert.deepEqual(scoreSequenceRound(index, fixture(index), previous).failures, []);
});

test('oracle rejects fresh-ID update, wrong scope/revision/value, lost history or empty success receipt', () => {
  for (const mutate of [
    row => { row.after.formal[0].id = 'new-id'; },
    row => { row.after.formal[0].scope = { kind: 'workspace' }; },
    row => { row.after.formal[0].revision = 1; },
    row => { row.after.formal[0].assertion.factIdentity.value = 'unsweetened'; },
    row => { row.after.raw.entries[0].assertions = []; },
    row => { row.receipts = []; },
    row => { row.after.formal[0].source.quote = '咖啡'; },
  ]) {
    const row = fixture(1); mutate(row);
    assert.equal(scoreSequenceRound(1, row, previous).passed, false);
  }
});

test('ordinary conflict must remain actionable, source-bound and cannot mutate current or historical truth', () => {
  for (const mutate of [
    row => { row.after.pending = []; },
    row => { row.after.pending[0].change.memoryId = 'missing'; },
    row => { row.after.pending[0].change.expectedRevision = 1; },
    row => { row.after.pending[0].staleReason = 'target_changed'; },
    row => { row.after.previews[0].applicable = false; },
    row => { row.after.pending[0].source.messageId = 'invented'; },
    row => { row.after.formal[0].revision = 3; },
    row => { row.after.raw.entries[0].versions.push({ revision: 3 }); },
    row => { row.receipts[0].text = '当时已更新：不加糖'; },
    row => { row.requests.push({ ...row.requests[0] }); },
    row => { row.modelVerified = false; },
    row => { row.phaseResults[0].text = '明白，当前对话里再改回：你喝咖啡不加糖（「加糖」那版作废）。'; },
  ]) {
    const row = fixture(2); mutate(row);
    assert.equal(scoreSequenceRound(2, row, previous).passed, false);
  }
});

test('narrow primary-copy regression rejects affirmative persistence but preserves denial language', () => {
  for (const text of ['明白，当前对话里再改回：你喝咖啡不加糖。', '你喝咖啡不加糖（「加糖」那版作废）。']) {
    assert.equal(hasSequenceFalsePersistenceClaim(text), true, text);
  }
  for (const text of ['不会改回不加糖。', '尚未改记，等待确认。', '旧记忆不会作废。', '我不会说“已改回”，请以回执为准。']) {
    assert.equal(hasSequenceFalsePersistenceClaim(text), false, text);
  }
});

test('transport blocks repeat dispatch and never records credentials/raw provider messages', async () => {
  let calls = 0;
  const boundary = createTransitionFetch(async () => { calls++; return { status: 200 }; });
  const options = { body: JSON.stringify({ model: transitionModel.modelId, messages: [{ role: 'user', content: 'synthetic' }] }),
    headers: { Authorization: 'Bearer NEVER_SERIALIZE_SECRET' } };
  await boundary.fetch('https://example.test', options);
  await assert.rejects(boundary.fetch('https://example.test', options));
  assert.equal(calls, 1);
  assert.equal(JSON.stringify({ requests: boundary.requests, error: transitionSafeError(Error('NEVER_SERIALIZE_SECRET')) }).includes('NEVER_SERIALIZE_SECRET'), false);
});

test('failed prerequisite keeps unexecuted rounds in denominator; no mock or live calls without explicit opt-in', async () => {
  const row = fixture(0); row.oracle = { passed: false, failures: ['formal_state_invalid'] };
  const summary = summarizeSequence([row]);
  assert.equal(summary.planned, 3); assert.equal(summary.unexecuted, 2); assert.equal(summary.passRateOfPlanned, 0);
  await assert.rejects(runMemorySequence({ live: false, env: {} }));
  await assert.rejects(runMemorySequence({ live: true, env: {} }));
});
