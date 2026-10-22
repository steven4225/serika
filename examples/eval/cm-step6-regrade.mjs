import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECKER_VERSION, goalMentioned, uncertainMentioned } from './cm-step6-live.mjs';
import { m1Cases } from './cm-step4.mjs';
import { hashCanonicalJson } from '@serika/core';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const all = checks => Object.values(checks).every(Boolean);

export function regradeRecorded(report) {
  const rows = [], flips = [];
  const answer = (chat, path) => {
    if (!chat) return null;
    const checks = { ...chat.checks, goal: goalMentioned(chat.reply), uncertain: uncertainMentioned(chat.reply) };
    for (const key of ['goal', 'uncertain']) if (checks[key] !== chat.checks[key]) flips.push({ path, check: key,
      old: chat.checks[key], new: checks[key], sourceKind: 'recorded_model_reply',
      sentences: chat.reply.split('\n').filter(line => key === 'goal' ? /完成.*验收报告/u.test(line.replace(/[「」『』“”"`*]/gu, '')) : /unknown|TOOL_OUTCOME_UNKNOWN|效果未知|不确定/iu.test(line)) });
    return { originalChecks: chat.checks, referenceChecks: checks, originalPassed: chat.passed, referencePassed: all(checks) };
  };
  for (const [suiteIndex, suite] of report.results.entries()) {
    if (suite.suite === 'M1') {
      for (const [index, row] of suite.results.entries()) {
        const checks = { ...row.checks };
        if (row.case === 'confirmation' && row.checks.completed && row.checks.saved) {
          const fixture = m1Cases().find(item => item.id === row.case), proposal = fixture.proposals[0];
          assert.equal(row.sourceHash, hashCanonicalJson(fixture.messages));
          checks.confirmation = proposal.sourceQuote.includes(proposal.identity.value);
          if (checks.confirmation !== row.checks.confirmation) flips.push({ path: `results[${suiteIndex}].results[${index}]`, check: 'confirmation',
            old: row.checks.confirmation, new: checks.confirmation, sourceKind: 'frozen_fixture_and_saved_checks',
            sentences: [proposal.sourceQuote], modelReply: null, limitation: 'No original proposal text was archived; inference uses the exact source fixture and recorded successful host validation/storage.' });
        }
        const validationFailure = row.diagnostics?.validationFailure ?? (row.diagnostics?.error === '同句矛盾必须完整保留证据中的原话' ?
          { reasonCode: 'UNCERTAIN_QUOTE_MISMATCH', origin: 'historical_exact_error_text', originalError: row.diagnostics.error } : null);
        rows.push({ suite: 'M1', case: row.case, window: row.window, originalPassed: row.passed, referencePassed: all(checks),
          originalChecks: row.checks, referenceChecks: checks, validationFailure });
      }
      continue;
    }
    for (const [index, round] of suite.rounds.entries()) {
      const chat = answer(round.chat, `results[${suiteIndex}].rounds[${index}].chat`);
      rows.push({ suite: suite.suite, generation: round.generation, originalPassed: round.passed,
        referencePassed: !!chat?.referencePassed && all(round.layerChecks ?? {}) && !round.backgroundItems.some(item => item.failure) && !round.error,
        chat, layerChecks: round.layerChecks, layerRegrade: 'not_regraded_no_original_summary_text', error: round.error ?? null });
    }
    const cold = answer(suite.cold, `results[${suiteIndex}].cold`);
    rows.push({ suite: suite.suite, generation: 'cold', originalPassed: suite.cold?.passed ?? null,
      referencePassed: cold ? cold.referencePassed && all({ ...suite.coldChecks, answer: cold.referencePassed }) : null, chat: cold,
      missing: !cold, limitation: cold ? null : 'Cold model reply and checks were not archived; returned call metadata cannot reconstruct its text.' });
  }
  const scores = report.results.map(suite => {
    const regular = rows.filter(row => row.suite === suite.suite && row.generation !== 'cold');
    const cold = rows.find(row => row.suite === suite.suite && row.generation === 'cold');
    return { suite: suite.suite, total: regular.length, recordedPassed: regular.filter(row => row.originalPassed).length,
      referencePassed: regular.filter(row => row.referencePassed).length, recordedCold: cold?.originalPassed ?? null,
      referenceCold: cold?.referencePassed ?? null, referenceSuitePassed: regular.every(row => row.referencePassed) && (!cold || cold.referencePassed === true) };
  });
  return { scores, rows, flips, validationReasonCounts: rows.reduce((counts, row) => {
    const code = row.validationFailure?.reasonCode; if (code) counts[code] = (counts[code] ?? 0) + 1; return counts;
  }, {}), unchangedChecks: ['noAutomaticRetry', 'pastRead', 'permissionNotInherited', 'all layer checks'],
    pending: ['noAutomaticRetry does not yet recognize 禁止自动重试; this checker change was not included in the three approved changes.'] };
}

export async function writeReference({ source = 'docs/v2-pilot/evidence/cm-step6/live-d67682ad-0722-43d9-af5c-8c7aef1308fa.json', output }) {
  const path = resolve(repo, source), bytes = await readFile(path), report = JSON.parse(bytes);
  const result = { referenceId: randomUUID(), generatedAt: new Date().toISOString(), kind: 'offline_reference_only',
    checkerVersion: CHECKER_VERSION, originalCheckerVersion: 'recorded_818f2f4_batch_checks', source,
    sourceSha256: sha(bytes), sourceRunId: report.runId, realModelCalls: 0, costUsd: 0,
    formalScoresChanged: false, ...regradeRecorded(report) };
  assert.equal(sha(await readFile(path)), result.sourceSha256);
  if (output) { assert.notEqual(resolve(output), path); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
  return result;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  assert.equal(process.argv.length, 3, 'Pass an explicit output path outside the frozen source file');
  const result = await writeReference({ output: process.argv[2] });
  console.log(JSON.stringify({ referenceId: result.referenceId, sourceSha256: result.sourceSha256, scores: result.scores, flips: result.flips.length, realModelCalls: 0 }));
}
