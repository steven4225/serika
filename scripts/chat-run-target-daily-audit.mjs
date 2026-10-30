import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const [support, output] = process.argv.slice(2).map(value => resolve(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => { const bytes = await readFile(join(support, name)); return { sha256: sha(bytes), value: JSON.parse(bytes) }; };
const state = await read('state.json'), ui = await read('daily-ui.json'), usage = await read('daily-model-usage.json');
assert.equal(state.value.phase, 'original-daily-restored');
assert.equal(ui.value.status, 'partial');
assert.equal(ui.value.cases.length, 2);
assert.equal(ui.value.configSha256Before, ui.value.configSha256After);
assert.equal(state.value.configSha256, ui.value.configSha256After);
assert.ok(!usage.value.frozen && usage.value.calls.length <= 24);
let cost = 0;
for (const row of usage.value.calls) {
  assert.equal(row.status, 'returned');
  const { input, output, cacheRead } = row.usage;
  const amount = ((input - cacheRead) * .32 + cacheRead * .03 + output * 1.16) / 1e6;
  assert.equal(amount, row.costUsd); cost += amount;
}
assert.equal(cost, usage.value.costUsd); assert.ok(cost <= .25);
const [cli, pi] = ui.value.cases;
const terminalCalls = cli.receipt.run.tools.filter(tool => tool.toolName === 'terminal_exec').length;
const unrecordedDecisionSources = terminalCalls - cli.decisions.length;
assert.equal(unrecordedDecisionSources, 1);
assert.equal(state.value.restoredWorker.running, true);
assert.deepEqual(cli.externalArtifact, { total: 56 });
const artifact = await readFile(join(ui.value.artifactDirectory, 'answer.json'));
assert.equal(sha(artifact), cli.artifactSha256);
assert.deepEqual(JSON.parse(artifact), { total: 56 });
assert.equal(pi.controlCount, 0);
const observations = pi.history.flatMap(message => message.parts ?? []).filter(part => part.output?.value?.checkedCandidates)
  .map(part => part.output.value);
assert.equal(observations.length, 2);
assert.ok(observations.every(value => value.checkedCandidates.length === 8 && value.adoptedTarget === null));
const selections = ui.value.events.filter(event => event.type === 'herdr-selection');
assert.equal(selections.length, 0);
const summary = {
  auditId: randomUUID(), auditedAt: new Date().toISOString(), sourceRunId: ui.value.id,
  verification: ui.value.verification, acceptance: 'failed-pi-selection-not-offered',
  rawEvidenceKeptLocal: true, rawEvidenceSha256: { state: state.sha256, ui: ui.sha256, usage: usage.sha256 },
  testedRevision: state.value.revision, testedBuildId: ui.value.build,
  taskRuns: ui.value.cases.map(row => ({ runId: row.runId, name: row.name, runtimeStatus: row.status })),
  cli: { externalArtifact: cli.externalArtifact, artifactSha256: cli.artifactSha256,
    shellErrors: cli.receipt.run.tools.filter(tool => tool.toolName === 'shell_exec').map(tool => JSON.parse(tool.resultPreview).error?.code),
    terminalCalls, recordedScriptDecisions: cli.decisions.length, unrecordedDecisionSources,
    result: 'artifact-correct-existing-host-terminal-confirmation-used' },
  pi: { discoveryCalls: observations.length, checkedCandidateCounts: observations.map(row => row.checkedCandidates.length),
    candidateStatusCounts: observations.map(row => ({ idle: row.checkedCandidates.filter(candidate => candidate.status === 'idle').length })),
    adopted: false, selectionCards: selections.length, controlDispatches: 0,
    failure: 'Model misread refreshed candidate IDs and past-observation caution as invalid targets, then ended without host selection.' },
  realModelRequests: usage.value.calls.length, amount: cost, amountBasis: usage.value.priceBasis,
  authorizedBatchMaxRequests: 24, authorizedBatchMaxRuns: 2, authorizedBatchCapUsd: .25,
  unresolvedCalls: 0, unresolvedReservedUsd: 0,
  configUnchanged: true, bindingUnchanged: true, rollback: { state: state.value.phase,
    buildId: state.value.restoredBuild.loaded.id, workerRunning: state.value.restoredWorker.running },
  realPiPromptRequests: 0, merged: false,
};
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
