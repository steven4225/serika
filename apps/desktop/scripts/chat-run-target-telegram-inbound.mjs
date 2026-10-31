import { createHash } from 'node:crypto';

export function redactTelegramEvidence(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, '[REDACTED_CREDENTIAL]');
    return value.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_TOKEN]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]');
  }
  if (Array.isArray(value)) return value.map(item => redactTelegramEvidence(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:token|api_?key|authorization|password)$/i.test(key) ? '[REDACTED_CREDENTIAL]' : redactTelegramEvidence(item, secrets)]));
  return value;
}

export function inspectTelegramInbound({ update, context, binding, secrets = [] }) {
  const message = update?.message, text = typeof message?.text === 'string' ? message.text.trim() : null;
  const phase = !binding.owner ? 'pairing' : binding.runId ? 'control' : 'task';
  const expectedCommand = phase === 'pairing' ? context.pairingCode && `/start ${context.pairingCode}` : context.taskText;
  const commandMatches = text !== null && (phase === 'control'
    ? /^(?:选择\s+[A-F0-9]{10}\s+[1-9][0-9]*|取消选择\s+[A-F0-9]{10}|(?:允许|拒绝)\s+[A-F0-9]{10})$/i.test(text)
    : typeof expectedCommand === 'string' && text === expectedCommand);
  const check = (id, expected, actual, passed = actual === expected) => ({ id, expected, actual: actual ?? null, passed });
  const predicates = [
    check('update_object_valid', 'object', update === null ? 'null' : Array.isArray(update) ? 'array' : typeof update, !!update && typeof update === 'object' && !Array.isArray(update)),
    check('update_id_valid', 'nonnegative safe integer', update?.update_id, Number.isSafeInteger(update?.update_id) && update.update_id >= 0),
    check('message_present', true, !!message),
    check('message_id_valid', 'positive safe integer', message?.message_id, Number.isSafeInteger(message?.message_id) && message.message_id > 0),
    check('owner_user_matches', context.owner.userId, message?.from?.id),
    check('owner_chat_matches', context.owner.chatId, message?.chat?.id),
    check('chat_private', 'private', message?.chat?.type),
    check('sender_is_human', false, message?.from?.is_bot),
    check('not_forwarded', false, message?.forward_origin !== undefined),
    check('not_via_bot', false, message?.via_bot !== undefined),
    check('text_is_string', 'string', typeof message?.text),
    check('text_matches_phase', phase === 'control' ? 'selection/cancel/allow/deny shortcode' : expectedCommand ?? 'command not ready', text, commandMatches),
    check('single_task_message', context.taskMessageId ?? 'first task', message?.message_id,
      phase !== 'task' || !context.taskMessageId || context.taskMessageId === message?.message_id),
  ];
  if (context.pollResponseIsArray === false) predicates.push(check('updates_response_array', true, false));
  if (context.handoffResponseSize !== undefined) predicates.push(check('handoff_response_empty', 0, context.handoffResponseSize));
  const failures = predicates.filter(predicate => !predicate.passed).map(predicate => predicate.id);
  return redactTelegramEvidence({ at: new Date().toISOString(), pollId: context.pollId, indexInPoll: context.indexInPoll, phase,
    sourceOwner: { userId: context.owner.userId, chatId: context.owner.chatId, threadId: context.owner.threadId ?? null },
    updateSha256: createHash('sha256').update(JSON.stringify(update) ?? 'undefined').digest('hex'), update: update ?? null, normalizedText: text, predicates,
    accepted: failures.length === 0, failedPredicate: failures[0] ?? null, failedPredicates: failures,
    safeToAcknowledge: predicates.filter(predicate => !['text_matches_phase', 'single_task_message'].includes(predicate.id)).every(predicate => predicate.passed),
    forwarded: false, bindingBefore: binding, bindingAfter: binding }, secrets);
}

export function telegramHandoff({ storeOffset, records, confirmedOffset }) {
  const unsafe = records.filter(record => !record.safeToAcknowledge);
  const requiredOffset = Math.max(storeOffset, ...records.map(record => Number.isSafeInteger(record.update?.update_id) ? record.update.update_id + 1 : storeOffset));
  return { storeOffset, requiredOffset, confirmedOffset, confirmed: !unsafe.length && confirmedOffset >= requiredOffset,
    blockedBy: unsafe.map(record => ({ updateId: record.update?.update_id ?? null, failedPredicates: record.failedPredicates })) };
}
