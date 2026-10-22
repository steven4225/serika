import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const transitionModel = Object.freeze({ alias: 'command-code/default', modelId: 'deepseek/deepseek-v4.1-flash-fast',
  baseURL: 'https://api.commandcode.ai/provider/v1' });
export const transitionOracleVersion = 'memory-transition-oracle-v3';
const spec = (id, category, input, extra = {}) => ({ id, category, input, ...extra });
// Frozen developer-authored regression set, not blind held-out evaluation.
export const transitionCases = Object.freeze([
  spec('MT01', 'explicit', '从现在起，我喝咖啡改成加糖。'),
  spec('MT02', 'explicit', '请把我的咖啡偏好改为加糖。'),
  spec('MT03', 'thread', '从现在起，仅在当前对话里，我的咖啡改成加糖。', { thread: true }),
  spec('MT04', 'thread', '仅当前对话有效，从现在起，我的咖啡改成加糖。', { thread: true }),
  spec('MT05', 'conflict', '我喝咖啡加糖。'),
  spec('MT06', 'conflict', '我喜欢喝加糖咖啡。'),
  spec('MT07', 'scene', '休息日我喝咖啡加糖，工作时依旧不加糖。', { scenario: 'work' }),
  spec('MT08', 'scene', '私人场景我喝咖啡加糖，工作时依旧不加糖。', { scenario: 'work' }),
  spec('MT09', 'non_authorizing', '如果从现在起我喝咖啡改成加糖，就好了。'),
  spec('MT10', 'non_authorizing', '从现在起，我的朋友喝咖啡改成加糖。'),
  spec('MT11', 'future', '我打算下个月喝咖啡改成加糖，现在依旧不加糖。'),
  spec('MT12', 'future', '以后，我可能喝咖啡改成加糖，但现在还没决定。'),
].map(Object.freeze));
const active = entry => entry.enabled && entry.status === 'active' && entry.temporalState === 'applicable';
const identity = entry => entry.assertion?.factIdentity ?? entry.change?.factIdentity;
const sources = item => item.sources ?? (item.source ? [item.source] : []);

/** Do not serialize arbitrary provider exception messages, headers, response bodies or credentials. */
export function transitionSafeError(cause) {
  const allowed = ['EVAL_DEADLINE', 'EVIDENCE_READ_FAILED', 'MODEL_MISMATCH', 'FIXTURE_APPROVAL_DENIED', 'ADMISSION_FAILED', 'CONFIGURATION_FAILED'];
  return { code: allowed.includes(cause?.code) ? cause.code : 'EVAL_ENVIRONMENT_FAILED',
    message: 'Execution infrastructure failed; inspect bounded run statuses and usage. Raw exception text was not retained.' };
}

/** Product retry behavior is unchanged; this eval permits only one HTTP dispatch per phase. */
export function createTransitionFetch(fetchImpl = fetch) {
  const requests = [], counts = { primary: 0, consolidation: 0 };
  const controlledFetch = async (url, options) => {
    let body;
    try { body = JSON.parse(options?.body); } catch { throw Error('Eval request body unavailable'); }
    const material = body.messages?.some(message => {
      const content = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
      return content.some(text => typeof text === 'string' && text.startsWith('Extract only from this host-prepared material.'));
    });
    const phase = material ? 'consolidation' : 'primary';
    const row = { phase, modelId: body.model, submittedAt: new Date().toISOString(), dispatched: false, blocked: false };
    requests.push(row);
    if (body.model !== transitionModel.modelId || counts[phase] >= 1) {
      row.blocked = true;
      throw Error('Eval refused model mismatch or repeated phase dispatch');
    }
    counts[phase] += 1;
    row.dispatched = true;
    // Never retain request headers, body, authorization or provider error text.
    try {
      const response = await fetchImpl(url, options);
      row.httpStatus = response.status;
      return response;
    } catch (cause) { row.transportFailure = true; throw cause; }
  };
  return { fetch: controlledFetch, requests };
}

/** Oracle reads persisted state only; model claims and final reply never determine pass. */
export function scoreTransition(test, evidence) {
  const failures = [];
  const require = (condition, code) => { if (!condition) failures.push(code); };
  const { before, after, seedId, userMessageId, threadId } = evidence;
  require(!before.readErrors?.length && !after.readErrors?.length, 'state_read_error');
  const old = before.formal.find(entry => entry.id === seedId);
  const current = after.formal.find(entry => entry.id === seedId);
  const isNewSource = source => source?.kind === 'conversation' && source.threadId === threadId && source.messageId === userMessageId
    && typeof source.quote === 'string' && source.quote.length > 0 && test.input.includes(source.quote);
  const scoped = item => {
    const scope = item.change?.scope ?? item.scope ?? old?.scope;
    return JSON.stringify(scope) === JSON.stringify(old?.scope);
  };
  const newFormal = after.formal.filter(entry => active(entry) && identity(entry)?.value === 'sweetened');
  const pending = after.pending.filter(entry => entry.status === 'pending');
  require(evidence.phases.primary === 'completed' && evidence.phases.consolidation === 'completed', 'run_not_completed');
  require(evidence.modelVerified === true, 'model_unverified');
  require(evidence.requests?.length === 2 && evidence.requests.every(request => request.dispatched && !request.blocked)
    && ['primary', 'consolidation'].every(phase => evidence.requests.filter(request => request.phase === phase).length === 1), 'request_count_or_retry');
  require(!!old && !!current, 'seed_missing');
  require(typeof userMessageId === 'string' && userMessageId.length > 0, 'user_source_missing');
  require(after.formal.every(entry => entry.id === seedId || sources(entry).every(isNewSource) && sources(entry).length > 0), 'formal_source_invalid');
  require(pending.every(entry => sources(entry).length > 0 && sources(entry).every(isNewSource)), 'pending_source_invalid');
  if (['explicit', 'thread'].includes(test.category)) {
    require(current?.revision === old?.revision + 1 && active(current) && identity(current)?.value === 'sweetened', 'explicit_not_updated');
    require(identity(current)?.scenario === identity(old)?.scenario && scoped(current), 'scope_or_scene_changed');
    require(current?.source?.quote === test.input && isNewSource(current?.source), 'change_source_not_complete');
    require(pending.length === 0, 'explicit_still_pending');
    require(after.formal.length === before.formal.length, 'duplicate_fact');
  } else {
    // Source reinforcement may legitimately increment the old revision.
    require(active(current) && current?.text === old?.text && identity(current)?.value === 'unsweetened'
      && identity(current)?.scenario === identity(old)?.scenario && scoped(current), 'old_fact_changed');
    require(newFormal.every(entry => test.category === 'scene' && identity(entry)?.scenario !== identity(old)?.scenario
      && identity(entry)?.scenario !== 'general' && scoped(entry)), 'unauthorized_current_fact');
    if (['non_authorizing', 'future'].includes(test.category)) {
      require(!after.formal.some(entry => entry.id !== seedId && active(entry)), 'unauthorized_new_active_fact');
    }
    if (test.category === 'conflict') {
      require(!after.formal.some(entry => entry.id !== seedId && active(entry)), 'unauthorized_new_active_fact');
      require(pending.some(entry => {
        const change = entry.change;
        return !entry.staleReason && identity(entry)?.value === 'sweetened'
          && identity(entry)?.attribute === identity(old)?.attribute
          && identity(entry)?.scenario === identity(old)?.scenario && scoped(entry)
          && typeof change?.text === 'string' && change.text.trim().length > 0
          && (change.operation === 'add' || ['correct', 'change'].includes(change.operation)
            && change.memoryId === seedId && change.expectedRevision === current?.revision);
      }), 'conflict_not_actionable');
    }
    if (test.category === 'scene') {
      const identified = [...newFormal, ...pending].some(entry => identity(entry)?.value === 'sweetened'
        && identity(entry)?.scenario && !['general', identity(old)?.scenario].includes(identity(entry).scenario)
        && (active(entry) || entry.status === 'pending' && !entry.staleReason && entry.change?.operation === 'add' && scoped(entry)));
      // A safe pending add may intentionally have no factIdentity: mixed-scene
      // source ambiguity must not make its independently reviewable body vanish.
      // These are fixture-owned scene/value checks, not product extraction code.
      const scene = test.id === 'MT07' ? /休息日|休息时|休息的时候/ : /私人场景|个人场景|生活场景/;
      const review = pending.some(entry => entry.change?.operation === 'add' && !entry.staleReason && scoped(entry)
        && !identity(entry) && String(entry.change.text).split(/[，,。；;\n]/).some(clause => scene.test(clause)
          && /咖啡.{0,8}加糖/.test(clause) && !/不加糖|没加糖|未加糖|如果|可能|朋友|他|她/.test(clause)));
      require(identified || review, 'new_scene_not_actionable');
    }
  }
  return { version: transitionOracleVersion, passed: failures.length === 0, failures };
}

export function summarizeTransitions(rows, planned = transitionCases.length) {
  const passed = rows.filter(row => row.oracle?.passed && !row.environmentFailure).length;
  return { status: rows.some(row => row.environmentFailure) ? 'environment_failed' : rows.length < planned ? 'incomplete'
    : passed === planned ? 'completed_pass' : 'completed_with_failures', planned, executed: rows.length,
  unexecuted: planned - rows.length, passed, passRateOfPlanned: passed / planned,
  categories: Object.fromEntries([...new Set(transitionCases.map(test => test.category))].map(category => {
    const selected = rows.filter(row => row.category === category), total = transitionCases.filter(test => test.category === category).length;
    return [category, { passed: selected.filter(row => row.oracle?.passed && !row.environmentFailure).length, executed: selected.length, planned: total }];
  })), failures: rows.filter(row => !row.oracle?.passed || row.environmentFailure).map(row => ({ caseId: row.caseId,
    failures: row.oracle?.failures ?? [], environmentFailure: row.environmentFailure ?? null })) };
}

export async function runMemoryTransitions({ live = false, env = process.env } = {}) {
  if (!live) throw Error('Explicit --live is required; no mock scores are generated.');
  if (!env.COMMAND_CODE_API_KEY?.trim()) throw Object.assign(new Error('Configure COMMAND_CODE_API_KEY in the protected environment, never in chat.'), { code: 'CONFIGURATION_FAILED' });
  throw new Error("此 v5 候选评测入口已停用；v6 使用 cm-step4.mjs，历史 Oracle 和分数保持原样");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMemoryTransitions({ live: process.argv.includes('--live') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed_pass') process.exitCode = 1;
  } catch (cause) { console.error(JSON.stringify(transitionSafeError(cause))); process.exitCode = 1; }
}
