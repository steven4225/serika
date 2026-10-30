import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(join(directory, 'result.json'));
const report = JSON.parse(original);
let amount = 0;
for (const [index, call] of report.calls.entries()) {
  assert.equal(sha(await readFile(join(directory, `response-${index + 1}.txt`))), call.responseSha256);
  const request = JSON.parse(await readFile(join(directory, `request-${index + 1}.json`), 'utf8'));
  assert.equal(sha(JSON.stringify(request)), call.requestSha256);
  assert.equal(call.status, 'returned');
  const { input, output, cacheRead } = call.usage;
  const price = report.pricePerMillionUsd;
  const cost = ((input - cacheRead) * price.input + cacheRead * price.cacheRead + output * price.output) / 1e6;
  assert.equal(cost, call.costUsd); amount += cost;
}
assert.equal(amount, report.costUsd);
assert.ok(report.calls.length <= report.maxRequests && report.cases.length <= report.maxRuns && amount <= report.capUsd);
const pi = report.cases.find(item => item.name === 'unique-pi');
const controls = pi.receipt.tools.filter(tool => tool.toolName === 'herdr_pi_control');
assert.equal(controls.length, 1); assert.equal(controls[0].status, 'completed');
const users = (await readFile(join(directory, 'pi-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  .filter(row => row.type === 'message' && row.message?.role === 'user');
assert.equal(users.length, 1);
assert.equal(users[0].message.content.map(part => part.text).join('\n'), JSON.parse(controls[0].inputPreview).text);
const fileReads = pi.receipt.tools.filter(tool => tool.toolName === 'read_file' && tool.status === 'completed')
  .map(tool => JSON.parse(tool.resultPreview));
const answer = JSON.parse(fileReads.find(result => result.path === 'answer.json').content);
assert.deepEqual(answer, { sum: 15, order: report.runId.slice(0, 8) });
const audit = {
  auditId: randomUUID(), auditedAt: new Date().toISOString(), verification: 'post-run-archived-evidence-audit',
  sourceResultSha256: sha(original), sourceRunId: report.runId, originalStatus: report.status,
  sourceResultUnmodified: true, realModelRequests: report.calls.length, taskRuns: report.cases.length,
  amount, amountBasis: report.priceBasis, unresolvedCalls: 0, unresolvedReservedUsd: 0,
  originalFooterUnresolvedReservedUsd: report.unresolvedReservedUsd,
  footerReconciliation: 'Every request row returned with usage; original footer was saved before the last handler settled.',
  ordinaryCliArtifact: report.cases[0].actualArtifact,
  pi: { singlePromptMatchesReceipt: true, serikaReadArtifact: answer,
    recordedControlDecisions: pi.decisions.filter(row => row.value.herdr).length,
    approvalSource: 'unobserved', externalFilesystemCheck: 'not-reached-before-original-assertion-failed' },
  unexecuted: ['multiple-pi', 'real-model-compaction', 'real-telegram'],
  acceptance: 'incomplete', productApprovalBypass: 'not-established',
};
await writeFile(join(directory, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit));
