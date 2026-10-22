import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECKER_VERSION, goalMentioned, uncertainMentioned, responseChecks } from './cm-step6-live.mjs';
import { m1Cases } from './cm-step4.mjs';
import { hashCanonicalJson } from '@serika/core';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const all = checks => Object.values(checks).every(Boolean);
const evidenceSentences = (reply, check) => {
  const patterns = {
    goal: /目标|验收报告|主项目报告/u, decision: /方案|本地/u, pending: /失败样本|未完成/u,
    permission: /部署|批准|授权/u, uncertain: /写入|write_file|unknown|不确定|未知/iu,
    noAutomaticRetry: /重试|核实|确认|对账/u, pastRead: /读取|读回|read_file|成功|completed/iu,
    permissionNotInherited: /读取|再读|授权|批准/u,
  };
  return reply.split('\n').filter(line => patterns[check]?.test(line));
};

export function regradeRecorded(report) {
  const rows = [], flips = [], previousFlips = [], answerScan = [], answerFailures = [], runtimeFailures = [], evidenceGaps = [];
  const answer = (chat, path, suite, stage) => {
    if (!chat) return null;
    const previousChecks = { ...chat.checks, goal: goalMentioned(chat.reply), uncertain: uncertainMentioned(chat.reply) };
    const checks = { ...chat.checks, ...responseChecks(chat.reply) };
    for (const key of Object.keys(checks)) {
      const sentences = evidenceSentences(chat.reply, key), textCheck = key in responseChecks('');
      answerScan.push({ path, suite, stage, check: key, kind: textCheck ? 'answer' : 'runtime',
        original: chat.checks[key], previousReference: previousChecks[key], reference: checks[key] });
      const flip = { path, check: key, old: chat.checks[key], new: checks[key], sourceKind: 'recorded_model_reply', sentences };
      if (checks[key] !== chat.checks[key]) flips.push(flip);
      if (checks[key] !== previousChecks[key]) previousFlips.push({ ...flip, old: previousChecks[key] });
      if (checks[key]) continue;
      if (!textCheck) {
        runtimeFailures.push({ path, suite, stage, check: key, sourceKind: 'recorded_runtime_check',
          originalValue: chat.checks[key], backgroundFailure: chat.backgroundFailure ?? null,
          diagnostics: chat.diagnostics?.lastPreparation ?? null, modelSentences: [],
          explanation: 'This is an execution/preparation check, not an answer-content judgment.' });
        continue;
      }
      const suspected = key === 'goal' && /验收报告做好|完成验收主项目报告|完成“验收主项目”，并给出验收报告/u.test(chat.reply);
      answerFailures.push({ path, suite, stage, check: key, classification: suspected ? '疑似误判' : '真没答到',
        reviewOnly: suspected, sentences, reply: chat.reply,
        rationale: suspected ? 'The recorded answer expresses producing the acceptance report in a different construction. The approved goal checker is unchanged; this row stays failed pending user review.' :
          key === 'pastRead' ? 'The answer denies or omits the historical successful read, contrary to the fixture receipt.' :
          key === 'permissionNotInherited' ? 'The answer discusses result/existence limits but does not require a new authorization for another read.' : 'The required answer content is absent or contradicted.' });
    }
    return { originalChecks: chat.checks, previousReferenceChecks: previousChecks, referenceChecks: checks,
      originalPassed: chat.passed, previousReferencePassed: all(previousChecks), referencePassed: all(checks) };
  };
  for (const [suiteIndex, suite] of report.results.entries()) {
    if (suite.suite === 'M1') {
      for (const [index, row] of suite.results.entries()) {
        const path = `results[${suiteIndex}].results[${index}]`, checks = { ...row.checks };
        if (row.case === 'confirmation' && row.checks.completed && row.checks.saved) {
          const fixture = m1Cases().find(item => item.id === row.case), proposal = fixture.proposals[0];
          assert.equal(row.sourceHash, hashCanonicalJson(fixture.messages));
          checks.confirmation = proposal.sourceQuote.includes(proposal.identity.value);
          if (checks.confirmation !== row.checks.confirmation) flips.push({ path, check: 'confirmation',
            old: row.checks.confirmation, new: checks.confirmation, sourceKind: 'frozen_fixture_and_saved_checks',
            sentences: [proposal.sourceQuote], modelReply: null, limitation: 'No original proposal text was archived; inference uses the exact source fixture and recorded successful host validation/storage.' });
        }
        const validationFailure = row.diagnostics?.validationFailure ?? (row.diagnostics?.error === '同句矛盾必须完整保留证据中的原话' ?
          { reasonCode: 'UNCERTAIN_QUOTE_MISMATCH', origin: 'historical_exact_error_text', originalError: row.diagnostics.error } : null);
        rows.push({ suite: 'M1', case: row.case, window: row.window, originalPassed: row.passed, previousReferencePassed: all(checks), referencePassed: all(checks),
          originalChecks: row.checks, previousReferenceChecks: checks, referenceChecks: checks, validationFailure });
        evidenceGaps.push({ path, suite: 'M1', case: row.case, window: row.window, sourceKind: 'missing_model_proposal_text',
          checks: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key), validationFailure,
          modelSentences: [], limitation: 'Only output hashes and validation/storage checks were archived. No model proposal sentence can be quoted or semantically rejudged.' });
      }
      continue;
    }
    for (const [index, round] of suite.rounds.entries()) {
      const path = `results[${suiteIndex}].rounds[${index}]`, chat = answer(round.chat, path + '.chat', suite.suite, round.generation);
      const hostPassed = all(round.layerChecks ?? {}) && !round.backgroundItems.some(item => item.failure) && !round.error;
      rows.push({ suite: suite.suite, generation: round.generation, originalPassed: round.passed,
        previousReferencePassed: !!chat?.previousReferencePassed && hostPassed, referencePassed: !!chat?.referencePassed && hostPassed,
        chat, layerChecks: round.layerChecks, layerRegrade: 'not_regraded_no_original_summary_text', error: round.error ?? null });
      for (const [check, value] of Object.entries(round.layerChecks ?? {})) if (!value) runtimeFailures.push({ path: path + '.layerChecks', suite: suite.suite,
        stage: round.generation, check, sourceKind: 'recorded_summary_layer_check', originalValue: value, modelSentences: [],
        explanation: 'Original summary text was not archived; preserve the recorded structural/content layer result without regrading it from the primary answer.' });
      for (const item of round.backgroundItems.filter(item => item.failure)) runtimeFailures.push({ path: path + `.backgroundItems[${item.index}]`, suite: suite.suite,
        stage: round.generation, check: 'backgroundSummary', sourceKind: 'recorded_background_failure', failure: item.failure, reason: item.reason, modelSentences: [] });
      if (round.error) runtimeFailures.push({ path, suite: suite.suite, stage: round.generation, check: 'roundError', sourceKind: 'recorded_round_error', error: round.error, modelSentences: [] });
    }
    const coldPath = `results[${suiteIndex}].cold`, cold = answer(suite.cold, coldPath, suite.suite, 'cold');
    const coldPassed = checks => cold ? all({ ...suite.coldChecks, answer: checks }) : null;
    rows.push({ suite: suite.suite, generation: 'cold', originalPassed: suite.cold?.passed ?? null,
      previousReferencePassed: coldPassed(cold?.previousReferencePassed), referencePassed: coldPassed(cold?.referencePassed), chat: cold,
      missing: !cold, limitation: cold ? null : 'Cold model reply and checks were not archived; returned call metadata cannot reconstruct its text.' });
    if (!cold) evidenceGaps.push({ path: coldPath, suite: suite.suite, stage: 'cold', sourceKind: 'missing_model_reply', modelSentences: [],
      limitation: 'Cold model reply and checks were not archived; returned call metadata cannot reconstruct its text.' });
    for (const [check, value] of Object.entries(suite.coldChecks ?? {})) if (!value && check !== 'answer') runtimeFailures.push({ path: `results[${suiteIndex}].coldChecks`,
      suite: suite.suite, stage: 'cold', check, sourceKind: 'recorded_cold_runtime_check', originalValue: value, modelSentences: [] });
  }
  const scores = report.results.map(suite => {
    const regular = rows.filter(row => row.suite === suite.suite && row.generation !== 'cold');
    const cold = rows.find(row => row.suite === suite.suite && row.generation === 'cold');
    return { suite: suite.suite, total: regular.length, recordedPassed: regular.filter(row => row.originalPassed).length,
      previousReferencePassed: regular.filter(row => row.previousReferencePassed).length, referencePassed: regular.filter(row => row.referencePassed).length,
      recordedCold: cold?.originalPassed ?? null, previousReferenceCold: cold?.previousReferencePassed ?? null, referenceCold: cold?.referencePassed ?? null,
      referenceSuitePassed: regular.every(row => row.referencePassed) && (!cold || cold.referencePassed === true) };
  });
  return { scores, rows, flips, previousFlips, validationReasonCounts: rows.reduce((counts, row) => {
    const code = row.validationFailure?.reasonCode; if (code) counts[code] = (counts[code] ?? 0) + 1; return counts;
  }, {}), answerScan, answerFailures, runtimeFailures, evidenceGaps,
    scanCoverage: { recordedAnswerCount: new Set(answerScan.map(row => row.path)).size, checkedAnswerFields: answerScan.length,
      semanticFailures: answerFailures.length, suspectedMisjudgments: answerFailures.filter(row => row.reviewOnly).length,
      m1ProposalTextsMissing: evidenceGaps.filter(row => row.sourceKind === 'missing_model_proposal_text').length },
    unchangedChecks: ['goal', 'uncertain', 'permissionNotInherited', 'decision', 'pending', 'permission', 'all runtime and layer checks'],
    checkerFreeze: { status: 'awaiting_user_review', appliesTo: 'future_batch_only', noRuleChangesUntilUserApprovesSuspectedFindings: true } };
}

export async function writeReference({ source = 'docs/v2-pilot/evidence/cm-step6/live-d67682ad-0722-43d9-af5c-8c7aef1308fa.json', output }) {
  const path = resolve(repo, source), bytes = await readFile(path), report = JSON.parse(bytes);
  const result = { referenceId: randomUUID(), generatedAt: new Date().toISOString(), kind: 'offline_reference_only',
    checkerVersion: CHECKER_VERSION, previousCheckerVersion: 'cm-step6-offline-v2', originalCheckerVersion: 'recorded_818f2f4_batch_checks', source,
    sourceSha256: sha(bytes), sourceRunId: report.runId, realModelCalls: 0, costUsd: 0,
    formalScoresChanged: false, ...regradeRecorded(report) };
  assert.equal(sha(await readFile(path)), result.sourceSha256);
  if (output) { assert.notEqual(resolve(output), path); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
  return result;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  assert.equal(process.argv.length, 3, 'Pass an explicit output path outside the frozen source file');
  const result = await writeReference({ output: process.argv[2] });
  console.log(JSON.stringify({ referenceId: result.referenceId, sourceSha256: result.sourceSha256, scores: result.scores, scanCoverage: result.scanCoverage, flips: result.flips.length, realModelCalls: 0 }));
}
