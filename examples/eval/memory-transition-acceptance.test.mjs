import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransitionFetch, runMemoryTransitions, scoreTransition, summarizeTransitions,
  transitionCases, transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

const source = { kind: 'conversation', threadId: 'fixture', messageId: 'user', quote: transitionCases[0].input };
const fact = (value = 'unsweetened', extra = {}) => ({ id: 'old', text: value === 'unsweetened' ? '我喝咖啡不加糖。' : '我喝咖啡加糖。',
  revision: value === 'unsweetened' ? 1 : 2, enabled: true, status: 'active', temporalState: 'applicable', scope: { kind: 'workspace' },
  assertion: { factIdentity: { attribute: 'coffee', scenario: 'general', value } }, ...extra });
function evidence() {
  return { before: { formal: [fact()], pending: [], readErrors: [] },
    after: { formal: [fact('sweetened', { source })], pending: [], readErrors: [] },
    seedId: 'old', threadId: 'fixture', userMessageId: 'user', modelVerified: true,
    phases: { primary: 'completed', consolidation: 'completed' },
    requests: ['primary', 'consolidation'].map(phase => ({ phase, dispatched: true, blocked: false })) };
}

test('freeze twelve sequences across six categories, with both D05 scope forms', () => {
  assert.equal(transitionCases.length, 12);
  assert.equal(new Set(transitionCases.map(row => row.id)).size, 12);
  for (const category of new Set(transitionCases.map(row => row.category))) assert.equal(transitionCases.filter(row => row.category === category).length, 2);
  assert.equal(transitionCases[2].input, '从现在起，仅在当前对话里，我的咖啡改成加糖。');
});

test('positive oracle checks actual same-ID revision, full source, scope and pending state, not reply claims', () => {
  assert.equal(scoreTransition(transitionCases[0], evidence()).passed, true);
  for (const mutation of [
    row => { row.after.formal[0].revision = 1; },
    row => { row.after.formal[0].scope = { kind: 'thread', threadId: 'wrong' }; },
    row => { row.after.formal[0].source = { ...source, quote: '咖啡' }; },
    row => { row.after.pending.push({ status: 'pending', source, change: {} }); },
    row => { row.phases.consolidation = 'failed'; },
    row => { row.requests[0].blocked = true; },
    row => { row.modelVerified = false; },
  ]) {
    const row = evidence(); mutation(row); row.reply = '已记住，已更新';
    assert.equal(scoreTransition(transitionCases[0], row).passed, false);
  }
});

test('ordinary contradiction needs a persisted actionable candidate with valid origin', () => {
  const testCase = transitionCases[4], row = evidence();
  row.after.formal = [fact()];
  assert.equal(scoreTransition(testCase, row).passed, false);
  row.after.pending = [{ status: 'pending', source: { ...source, quote: testCase.input },
    change: { operation: 'correct', memoryId: 'old', expectedRevision: 1, text: '我喝咖啡加糖。',
      factIdentity: { attribute: 'coffee', scenario: 'general', value: 'sweetened' } } }];
  assert.equal(scoreTransition(testCase, row).passed, true);
  row.after.pending[0].source.messageId = 'invented';
  assert.equal(scoreTransition(testCase, row).passed, false);
});

test('conflict oracle rejects stale or unresolvable reviews and untyped active duplicates', () => {
  const testCase = transitionCases[4], row = evidence();
  row.after.formal = [fact()];
  row.after.pending = [{ status: 'pending', staleReason: null, source: { ...source, quote: testCase.input },
    change: { operation: 'correct', memoryId: 'old', expectedRevision: 1, text: '我喝咖啡加糖。',
      factIdentity: { attribute: 'coffee', scenario: 'general', value: 'sweetened' } } }];
  assert.equal(scoreTransition(testCase, row).passed, true);
  for (const change of [
    value => { value.after.pending[0].change.memoryId = 'missing'; },
    value => { value.after.pending[0].change.expectedRevision = 999; },
    value => { value.after.pending[0].staleReason = 'target_changed'; },
    value => { value.after.pending[0].change.operation = 'disable'; },
    value => { value.after.formal.push(fact('sweetened', { id: 'new', assertion: {}, source: { ...source, quote: testCase.input } })); },
  ]) {
    const invalid = structuredClone(row); change(invalid);
    assert.equal(scoreTransition(testCase, invalid).passed, false);
  }
});

test('different scenes require a current formal fact or usable pending candidate without changing work', () => {
  const testCase = transitionCases[7], row = evidence();
  row.before.formal = [fact('unsweetened', { text: '工作时我喝咖啡不加糖。', assertion: { factIdentity: { attribute: 'coffee', scenario: 'work', value: 'unsweetened' } } })];
  row.after.formal = structuredClone(row.before.formal);
  row.after.pending = [{ status: 'pending', staleReason: null, source: { ...source, quote: testCase.input },
    change: { operation: 'add', scope: { kind: 'workspace' }, factIdentity: { attribute: 'coffee', scenario: 'personal', value: 'sweetened' } } }];
  assert.equal(scoreTransition(testCase, row).passed, true);
  row.after.pending[0].status = 'stale'; row.after.pending[0].staleReason = 'target_changed';
  assert.equal(scoreTransition(testCase, row).passed, false);
});

test('scene oracle accepts source-bound independent add review when safety removed its identity', () => {
  const testCase = transitionCases[7], row = evidence();
  row.before.formal = [fact('unsweetened', { text: '工作时我喝咖啡不加糖。', assertion: { factIdentity: { attribute: 'coffee', scenario: 'work', value: 'unsweetened' } } })];
  row.after.formal = structuredClone(row.before.formal);
  row.after.pending = [{ status: 'pending', staleReason: null, source: { ...source, quote: testCase.input },
    change: { operation: 'add', scope: { kind: 'workspace' }, kind: 'preference', text: '私人场景我喝咖啡加糖。' } }];
  assert.equal(scoreTransition(testCase, row).passed, true);
  for (const patch of [
    { operation: 'correct', memoryId: 'old' }, { text: '工作时我喝咖啡加糖。' }, { text: '私人场景我喝咖啡不加糖。' },
    { text: '我喝咖啡加糖。' }, { scope: { kind: 'thread', threadId: 'wrong' } },
  ]) {
    const invalid = structuredClone(row); Object.assign(invalid.after.pending[0].change, patch);
    assert.equal(scoreTransition(testCase, invalid).passed, false, JSON.stringify(patch));
  }
});

test('non-authorizing and uncertain cases forbid newly active untyped facts too', () => {
  for (const testCase of transitionCases.filter(item => ['non_authorizing', 'future'].includes(item.category))) {
    const row = evidence(); row.after.formal = [fact(), fact('sweetened', { id: 'new', kind: 'note',
      assertion: { factIdentity: undefined }, source: { ...source, quote: testCase.input } })];
    assert.equal(scoreTransition(testCase, row).passed, false, testCase.id);
  }
});

test('negative oracle rejects a same-scene opposite active fact even if the original survived', () => {
  const row = evidence(); row.after.formal = [fact(), fact('sweetened', { id: 'duplicate', source: { ...source, quote: transitionCases[8].input } })];
  assert.equal(scoreTransition(transitionCases[8], row).passed, false);
});

test('controlled fetch never dispatches a second primary request and recognizes host-prepared extraction', async () => {
  const dispatched = [];
  const boundary = createTransitionFetch(async (_url, options) => { dispatched.push(JSON.parse(options.body)); return { status: 200 }; });
  const request = content => ({ body: JSON.stringify({ model: transitionModel.modelId, messages: [{ role: 'user', content }] }), headers: { Authorization: 'Bearer secret-value-must-never-be-recorded' } });
  await boundary.fetch('https://example.test', request('普通用户消息'));
  await assert.rejects(boundary.fetch('https://example.test', request('普通用户消息')), /refused/);
  await boundary.fetch('https://example.test', request([{ type: 'text', text: 'Extract only from this host-prepared material.\n{}' }]));
  assert.equal(dispatched.length, 2);
  assert.deepEqual(boundary.requests.map(row => row.phase), ['primary', 'primary', 'consolidation']);
  assert.equal(boundary.requests[1].dispatched, false);
  assert.equal(boundary.requests[1].blocked, true);
  assert.equal(JSON.stringify(boundary.requests).includes('secret-value'), false);
});

test('changed model is blocked before HTTP dispatch', async () => {
  let calls = 0;
  const boundary = createTransitionFetch(async () => { calls += 1; });
  await assert.rejects(boundary.fetch('https://example.test', { body: JSON.stringify({ model: 'wrong', messages: [] }) }));
  assert.equal(calls, 0);
});

test('partial and environment failures stay in planned denominator; no exception credential retention', async () => {
  const summary = summarizeTransitions([{ caseId: 'MT01', category: 'explicit', oracle: { passed: true } },
    { caseId: 'MT02', category: 'explicit', environmentFailure: transitionSafeError(new Error('Bearer abc123secret header secret')) }]);
  assert.equal(summary.status, 'environment_failed'); assert.equal(summary.executed, 2); assert.equal(summary.unexecuted, 10);
  assert.equal(summary.passRateOfPlanned, 1 / 12);
  assert.equal(JSON.stringify(summary).includes('abc123secret'), false);
  await assert.rejects(runMemoryTransitions(), /--live/);
  await assert.rejects(runMemoryTransitions({ live: true, env: {} }), /COMMAND_CODE_API_KEY/);
  await assert.rejects(runMemoryTransitions({ live: true, env: { COMMAND_CODE_API_KEY: "unused-retired-runner" } }), /v5 候选评测入口已停用/);
});
