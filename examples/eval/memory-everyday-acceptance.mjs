import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

export const everydayOracleVersion = 'memory-everyday-oracle-v1';
const domains = [
  { prefix: 'ED', attribute: 'diet_spiciness', label: '饮食辣度', oldValue: 'none', value: 'mild', oldWord: '不辣', word: '微辣' },
  { prefix: 'EN', attribute: 'notification_channel', label: '通知渠道', oldValue: 'in_app', value: 'telegram', oldWord: '应用内', word: 'Telegram' },
];
/** Developer-authored canonical-vocabulary acceptance; not blind held-out data. */
export const everydayCases = Object.freeze(domains.flatMap(domain => {
  const ordinary = `我的${domain.label}是${domain.word}。`;
  return [
    { category: 'save', input: `请记住，${ordinary}` },
    { category: 'explicit', input: `从现在起，我的${domain.label}改成${domain.word}。` },
    { category: 'conflict', input: ordinary },
    { category: 'scene', input: `在「休息日」场景，${ordinary}`, seedScene: '工作日早餐', scene: '休息日' },
    { category: 'thread', input: `仅在当前对话里，${ordinary}` },
    { category: 'non_authorizing', input: domain.prefix === 'ED'
      ? `下个月我的${domain.label}改成${domain.word}。` : `不要把我的${domain.label}改成${domain.word}。` },
  ].map((test, index) => Object.freeze({ ...domain, ...test, id: `${domain.prefix}${String(index + 1).padStart(2, '0')}` }));
}));
const identity = item => item.assertion?.factIdentity ?? item.change?.factIdentity;
const sources = item => item.sources ?? (item.source ? [item.source] : []);
const active = item => item.enabled === true && item.status === 'active' && item.temporalState === 'applicable';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const factIdentity = (test, value, scenario = 'general') => ({ version: 2, subject: 'user', attribute: test.attribute, scenario, value });

/** Store state and production-selector output decide pass, never model completion claims. */
export function scoreEveryday(test, evidence) {
  const failures = [], require = (condition, code) => { if (!condition) failures.push(code); };
  const before = evidence.before ?? {}, after = evidence.after ?? {};
  const formal = after.formal ?? [], pending = (after.pending ?? []).filter(item => item.status === 'pending');
  const old = before.formal?.find(item => item.id === evidence.seedId);
  const current = formal.find(item => item.id === evidence.seedId);
  const scope = test.category === 'thread' ? { kind: 'thread', threadId: evidence.threadId } : { kind: 'workspace' };
  const scenario = test.scene ?? 'general';
  const correct = item => {
    const text = String(item.text ?? item.change?.text ?? '').toLowerCase();
    return equal(identity(item), factIdentity(test, test.value, scenario)) && text.includes(test.label)
      && text.includes(test.word.toLowerCase()) && !text.includes(test.oldWord.toLowerCase())
      && (scenario === 'general' || text.includes(scenario));
  };
  const isSource = source => source?.kind === 'conversation' && source.threadId === evidence.threadId
    && source.messageId === evidence.userMessageId && typeof source.quote === 'string' && source.quote.length > 0 && test.input.includes(source.quote);
  const newFacts = formal.filter(item => item.id !== evidence.seedId);
  require(!evidence.environmentFailure && !evidence.readErrors?.length && !before.readErrors?.length && !after.readErrors?.length, 'state_or_environment_error');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.phases?.primary === 'completed' && evidence.phases?.consolidation === 'completed', 'run_not_completed');
  require(evidence.requests?.length === 2 && ['primary', 'consolidation'].every(phase =>
    evidence.requests.filter(row => row.phase === phase && row.dispatched && !row.blocked && row.modelId === transitionModel.modelId).length === 1), 'request_count_or_retry');
  require(typeof evidence.userMessageId === 'string' && evidence.userMessageId.length > 0, 'source_message_missing');
  require(newFacts.every(item => sources(item).length > 0 && sources(item).every(isSource)), 'formal_source_invalid');
  require(pending.every(item => sources(item).length > 0 && sources(item).every(isSource)), 'pending_source_invalid');
  if (['save', 'thread', 'scene'].includes(test.category)) {
    require(newFacts.length === 1 && active(newFacts[0]) && correct(newFacts[0]) && equal(newFacts[0].scope, scope), 'new_fact_not_saved');
    require(pending.length === 0, 'save_still_pending');
    if (test.category === 'scene') require(!!old && !!current && current.text === old.text
      && equal(identity(current), identity(old)) && equal(current.scope, old.scope) && active(current), 'old_scene_changed');
    else require((before.formal?.length ?? 0) === 0 && formal.length === 1, 'unexpected_seed_or_duplicate');
    if (test.category === 'thread') {
      const savedId = newFacts[0]?.id;
      require(!!savedId && after.ownerReferenceIds?.includes(savedId) && !after.foreignReferenceIds?.includes(savedId), 'thread_reference_leak_or_missing');
    }
  } else {
    require(!!old && !!current && equal(current.scope, old.scope), 'seed_missing_or_scope_changed');
    require(newFacts.length === 0, 'unauthorized_new_fact');
    if (test.category === 'explicit') {
      require(active(current ?? {}) && current?.revision === old?.revision + 1 && correct(current ?? {}), 'explicit_not_updated');
      require(current?.source?.quote === test.input && isSource(current?.source), 'change_source_not_complete');
      require(pending.length === 0, 'explicit_still_pending');
      require(after.seedHistory?.assertions?.some(item => item.text === old?.text)
        && after.seedHistory.assertions.some(item => equal(item.factIdentity, factIdentity(test, test.value))), 'old_history_missing');
    } else {
      require(active(current ?? {}) && current?.text === old?.text && equal(identity(current ?? {}), identity(old ?? {})), 'old_fact_changed');
      if (test.category === 'conflict') require(pending.some(item => {
        const change = item.change;
        return !item.staleReason && correct(item) && typeof change?.text === 'string' && change.text.trim().length > 0
          && equal(change.scope ?? old?.scope, old?.scope)
          && (change.operation === 'add' || ['correct', 'change'].includes(change.operation)
            && change.memoryId === evidence.seedId && change.expectedRevision === current?.revision);
      }), 'conflict_not_actionable');
    }
  }
  return { version: everydayOracleVersion, passed: failures.length === 0, failures };
}

export function summarizeEveryday(rows) {
  const group = tests => { const ids = new Set(tests.map(test => test.id)), executed = rows.filter(row => ids.has(row.caseId));
    const passed = executed.filter(row => row.oracle?.passed && !row.environmentFailure).length;
    return { planned: tests.length, executed: executed.length, unexecuted: tests.length - executed.length, passed, passRateOfPlanned: passed / tests.length }; };
  const total = group(everydayCases);
  return { status: rows.some(row => row.environmentFailure) ? 'environment_failed' : total.unexecuted ? 'incomplete'
    : total.passed === total.planned ? 'completed_pass' : 'completed_with_failures', ...total,
    domains: Object.fromEntries(domains.map(domain => [domain.attribute, group(everydayCases.filter(test => test.attribute === domain.attribute))])),
    failures: rows.filter(row => !row.oracle?.passed || row.environmentFailure).map(row => ({ caseId: row.caseId,
      failures: row.oracle?.failures ?? [], environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemoryEveryday({ live = false, env = process.env } = {}) {
  if (!live) throw Error('Explicit --live is required; fixture tests are not model quality data.');
  if (!env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(new Error('Protected COMMAND_CODE_API_KEY required'), { code: 'CONFIGURATION_FAILED' });
  throw new Error("此 v5 候选评测入口已停用；v6 使用 cm-step4.mjs，历史 Oracle 和分数保持原样");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--live')) throw Error('Unknown argument');
    const result = await runMemoryEveryday({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2)); if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
