import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { everydayCases, everydayOracleVersion, scoreEveryday, summarizeEveryday, runMemoryEveryday } from './memory-everyday-acceptance.mjs';
import { transitionModel } from './memory-transition-acceptance.mjs';

function fixture(spec) {
  const source = { kind: 'conversation', threadId: 'owner', messageId: 'user', quote: spec.input };
  const identity = (value, scenario = 'general') => ({ version: 2, subject: 'user', attribute: spec.attribute, scenario, value });
  const fact = (value, extra = {}) => ({ id: 'old', revision: 1, text: `我的${spec.label}是${spec.oldWord}。`, enabled: true,
    status: 'active', temporalState: 'applicable', scope: { kind: 'workspace' }, assertion: { factIdentity: identity(value) }, ...extra });
  const row = { caseId: spec.id, threadId: 'owner', userMessageId: 'user', seedId: 'old', modelVerified: true,
    phases: { primary: 'completed', consolidation: 'completed' },
    requests: ['primary', 'consolidation'].map(phase => ({ phase, dispatched: true, blocked: false, modelId: transitionModel.modelId })),
    before: { formal: [fact(spec.oldValue)], pending: [], readErrors: [] },
    after: { formal: [fact(spec.oldValue)], pending: [], readErrors: [] } };
  const next = fact(spec.value, { id: 'new', text: `我的${spec.label}是${spec.word}。`, source,
    assertion: { factIdentity: identity(spec.value, spec.scene ?? 'general') } });
  if (['save', 'thread'].includes(spec.category)) {
    row.seedId = null; row.before.formal = []; row.after.formal = [next];
    if (spec.category === 'thread') next.scope = { kind: 'thread', threadId: 'owner' };
    row.after.ownerReferenceIds = ['new']; row.after.foreignReferenceIds = [];
  } else if (spec.category === 'explicit') {
    row.after.formal = [{ ...next, id: 'old', revision: 2 }];
    row.after.seedHistory = { assertions: [{ text: row.before.formal[0].text, factIdentity: identity(spec.oldValue) },
      { text: next.text, factIdentity: identity(spec.value) }] };
  } else if (spec.category === 'scene') {
    row.before.formal[0].assertion.factIdentity.scenario = spec.seedScene;
    next.text = `在「${spec.scene}」场景，${next.text}`;
    row.after.formal = [structuredClone(row.before.formal[0]), next];
  } else if (spec.category === 'conflict') row.after.pending = [{ status: 'pending', staleReason: null, source,
    change: { operation: 'correct', memoryId: 'old', expectedRevision: 1, text: next.text, factIdentity: identity(spec.value) } }];
  return row;
}

test('twelve frozen cases cover both canonical v2 domains and six operations', () => {
  assert.equal(everydayCases.length, 12);
  assert.equal(new Set(everydayCases.map(spec => spec.id)).size, 12);
  for (const attribute of ['diet_spiciness', 'notification_channel']) {
    const cases = everydayCases.filter(spec => spec.attribute === attribute);
    assert.equal(cases.length, 6);
    assert.deepEqual(cases.map(spec => spec.category), ['save', 'explicit', 'conflict', 'scene', 'thread', 'non_authorizing']);
  }
  for (const spec of everydayCases) assert.equal(scoreEveryday(spec, fixture(spec)).passed, true, spec.id);
});

test('saved facts require current v2 identity, scope and committed sources regardless of success text', () => {
  const spec = everydayCases[0];
  for (const mutate of [
    row => { row.after.formal = []; },
    row => { delete row.after.formal[0].assertion.factIdentity.version; },
    row => { row.after.formal[0].assertion.factIdentity.subject = 'friend'; },
    row => { row.after.formal[0].assertion.factIdentity.value = 'hot'; },
    row => { row.after.formal[0].text = '我的饮食辣度是不辣。'; },
    row => { row.after.formal[0].scope = { kind: 'thread', threadId: 'wrong' }; },
    row => { row.after.formal[0].source.messageId = 'invented'; },
    row => { row.after.formal[0].source.quote = 'unrelated quote'; },
  ]) {
    const row = fixture(spec); mutate(row); row.reply = '已保存';
    assert.equal(scoreEveryday(spec, row).passed, false);
  }
});

test('explicit updates require same-ID CAS advancement, full quote and retained history', () => {
  const spec = everydayCases[1];
  for (const mutate of [
    row => { row.after.formal[0].revision = 1; },
    row => { row.after.formal[0].id = 'replacement-id'; },
    row => { row.after.formal[0].source.quote = '我的'; },
    row => { row.after.seedHistory.assertions.shift(); },
    row => { row.after.seedHistory.assertions.pop(); },
  ]) {
    const row = fixture(spec); mutate(row);
    assert.equal(scoreEveryday(spec, row).passed, false);
  }
});

test('ordinary conflicts need a real actionable target, not stale or unresolvable review', () => {
  const spec = everydayCases[2];
  for (const mutate of [
    row => { row.after.pending = []; },
    row => { row.after.pending[0].change.memoryId = 'missing'; },
    row => { row.after.pending[0].change.expectedRevision = 999; },
    row => { row.after.pending[0].staleReason = 'target_changed'; },
    row => { row.after.pending[0].change.operation = 'disable'; },
    row => { row.after.formal.push({ ...row.after.formal[0], id: 'extra', source: row.after.pending[0].source }); },
  ]) {
    const row = fixture(spec); mutate(row);
    assert.equal(scoreEveryday(spec, row).passed, false);
  }
});

test('different scenes must coexist, thread selector must isolate, and future/negative inputs cannot overwrite', () => {
  const scene = everydayCases[3], thread = everydayCases[4];
  const wrongScene = fixture(scene); wrongScene.after.formal[1].assertion.factIdentity.scenario = scene.seedScene;
  assert.equal(scoreEveryday(scene, wrongScene).passed, false);
  const changedOld = fixture(scene); changedOld.after.formal[0].text = 'old overwritten';
  assert.equal(scoreEveryday(scene, changedOld).passed, false);
  for (const field of ['ownerReferenceIds', 'foreignReferenceIds']) {
    const row = fixture(thread); row.after[field] = field === 'ownerReferenceIds' ? [] : ['new'];
    assert.equal(scoreEveryday(thread, row).passed, false);
  }
  for (const spec of everydayCases.filter(spec => spec.category === 'non_authorizing')) {
    const row = fixture(spec); row.after.formal[0].assertion.factIdentity.value = spec.value;
    assert.equal(scoreEveryday(spec, row).passed, false);
  }
});

test('model/dispatch/read failures cannot pass and unexecuted cases remain in the denominator', () => {
  const spec = everydayCases[0];
  for (const mutate of [row => { row.modelVerified = false; }, row => { row.requests.push(row.requests[0]); },
    row => { row.requests[0].modelId = 'wrong'; }, row => { row.phases.consolidation = 'failed'; },
    row => { row.after.readErrors = ['failed']; }, row => { row.environmentFailure = { code: 'fixture' }; }]) {
    const row = fixture(spec); mutate(row); assert.equal(scoreEveryday(spec, row).passed, false);
  }
  const summary = summarizeEveryday([{ caseId: spec.id, oracle: { passed: true } }]);
  assert.equal(summary.planned, 12); assert.equal(summary.passed, 1); assert.equal(summary.unexecuted, 11);
  assert.equal(summary.passRateOfPlanned, 1 / 12);
  assert.equal(summary.domains.diet_spiciness.planned, 6);
});

test('live entry requires explicit invocation and protected host key', async () => {
  await assert.rejects(runMemoryEveryday(), /--live/);
  await assert.rejects(runMemoryEveryday({ live: true, env: {} }), /COMMAND_CODE_API_KEY/);
});
