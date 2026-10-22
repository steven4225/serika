import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transitionModel, transitionSafeError } from './memory-transition-acceptance.mjs';

export const sequenceCases = Object.freeze([
  { id: 'MS01', input: '【升级验收1015A】仅在当前对话里，请记住：我喝咖啡不加糖。', value: 'unsweetened' },
  { id: 'MS02', input: '从现在起，仅在当前对话里，我喝咖啡改成加糖。', value: 'sweetened' },
  { id: 'MS03', input: '仅在当前对话里，我喝咖啡不加糖。', value: 'sweetened' },
].map(Object.freeze));
export const sequenceOracleVersion = 'memory-sequence-oracle-v1';
const identity = item => item.assertion?.factIdentity ?? item.change?.factIdentity;
const active = item => item.enabled && item.status === 'active' && item.temporalState === 'applicable';
const scopeMatches = (item, threadId) => item.scope?.kind === 'thread' && item.scope.threadId === threadId;

/** Exact fragments of the observed false reply, NOT a semantic truthfulness judge.
 * No fuzzy persistence regex and no assumption that other wording is truthful.
 */
export function hasSequenceFalsePersistenceClaim(text) {
  return ['明白，当前对话里再改回：', '（「加糖」那版作废）'].some(fragment => String(text).includes(fragment));
}

/** Pure oracle: a scripted fixture can test this logic but is never live semantic evidence. */
export function scoreSequenceRound(index, evidence, previous = []) {
  const failures = [], require = (condition, code) => { if (!condition) failures.push(code); };
  const test = sequenceCases[index], { before, after, threadId, userMessageId } = evidence;
  const expectedRevision = index === 0 ? 1 : 2;
  const old = previous[0]?.after.formal[0];
  const fact = after.formal[0];
  require(!evidence.environmentFailure && !evidence.readErrors?.length && !before.readErrors?.length && !after.readErrors?.length, 'evidence_unavailable');
  require(evidence.phases.primary === 'completed' && evidence.phases.consolidation === 'completed', 'run_not_completed');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.requests.length === 2 && evidence.requests.every(row => row.dispatched && !row.blocked && row.httpStatus === 200 && row.modelId === transitionModel.modelId)
    && ['primary', 'consolidation'].every(phase => evidence.requests.filter(row => row.phase === phase).length === 1), 'request_boundary');
  require(typeof userMessageId === 'string' && userMessageId.length > 0, 'missing_source');
  require(after.formal.length === 1 && active(fact) && scopeMatches(fact, threadId)
    && identity(fact)?.attribute === 'coffee' && identity(fact)?.scenario === 'general'
    && identity(fact)?.value === test.value && fact?.revision === expectedRevision, 'formal_state_invalid');
  require(index === 0 ? before.formal.length === 0 : old && fact?.id === old.id, 'identity_or_initial_state');
  const boundSource = source => source?.kind === 'conversation' && source.threadId === threadId
    && source.messageId === userMessageId && source.quote === test.input;
  const currentReceipts = evidence.receipts?.filter(row => row.sourceMessageId === userMessageId && row.threadId === threadId) ?? [];
  require(currentReceipts.length === 1, 'receipt_missing_or_duplicated');
  const receipt = currentReceipts[0]?.text ?? '';
  if (index < 2) {
    require(after.pending.length === 0, 'unexpected_pending');
    require(boundSource(fact?.source), 'formal_source_incomplete');
    require(index === 0 ? /当时已保存/.test(receipt) : /当时已更新/.test(receipt), 'receipt_not_persisted_success');
    const raw = after.raw?.entries?.find(row => row.id === fact?.id);
    require(raw?.versions?.some(version => version.revision === 1), 'initial_version_lost');
    if (index === 1) require(raw?.assertions?.some(assertion => assertion.factIdentity?.value === 'unsweetened'
      && assertion.validTime.to !== null) && raw.versions.some(version => version.revision === 2), 'old_timeline_lost');
  } else {
    require(JSON.stringify(after.formal) === JSON.stringify(before.formal), 'ordinary_conflict_mutated_formal');
    const applicable = after.pending.filter(candidate => candidate.status === 'pending' && !candidate.staleReason
      && identity(candidate)?.attribute === 'coffee' && identity(candidate)?.scenario === 'general'
      && identity(candidate)?.value === 'unsweetened' && candidate.originThreadId === threadId
      && ['correct', 'change'].includes(candidate.change?.operation) && candidate.change.memoryId === fact?.id
      && candidate.change.expectedRevision === fact?.revision
      && (candidate.sources ?? [candidate.source]).some(boundSource)
      && after.previews?.some(preview => preview.candidate.id === candidate.id && preview.applicable === true));
    require(after.pending.length === 1 && applicable.length === 1, 'conflict_not_actionable');
    require(/记忆需要你确认/.test(receipt) && !/当时已(?:保存|更新)|暂时不能确认/.test(receipt), 'receipt_falsely_claims_success');
    require(JSON.stringify(after.raw?.entries) === JSON.stringify(before.raw?.entries), 'history_changed_or_revived');
    const primaryText = evidence.phaseResults?.findLast(row => row.phase === 'primary')?.text;
    require(typeof primaryText === 'string' && !hasSequenceFalsePersistenceClaim(primaryText), 'primary_false_persistence_claim');
  }
  return { version: sequenceOracleVersion, passed: failures.length === 0, failures };
}

export function summarizeSequence(rows) {
  const passed = rows.filter(row => row.oracle?.passed && !row.environmentFailure).length;
  return { planned: 3, executed: rows.length, unexecuted: 3 - rows.length, passed, failed: rows.filter(row => !row.oracle?.passed).length,
    environmentFailures: rows.filter(row => row.environmentFailure).length, passRateOfPlanned: passed / 3,
    status: rows.some(row => row.environmentFailure) ? 'environment_failed' : rows.length < 3 ? 'incomplete' : passed === 3 ? 'completed_pass' : 'completed_with_failures',
    failures: rows.filter(row => !row.oracle?.passed).map(row => ({ caseId: row.caseId, failures: row.oracle?.failures, environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemorySequence({ live = false, env = process.env } = {}) {
  if (!live || !env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(Error('Explicit live and protected credentials required'), { code: 'CONFIGURATION_FAILED' });
  throw new Error("此 v5 候选评测入口已停用；v6 使用 cm-step4.mjs，历史 Oracle 和分数保持原样");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMemorySequence({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
