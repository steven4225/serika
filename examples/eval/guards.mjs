import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './report.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
await mkdir(join(here, 'results'), { recursive: true });
const groups = [
  ['eval_oracle', ['examples/eval/oracle.test.mjs', 'examples/eval/provider.test.mjs', 'examples/eval/e2e.test.mjs', 'examples/eval/report.test.mjs', 'examples/eval/reliability.test.mjs', 'examples/eval/regrade.test.mjs']],
  ['loop_deadline_cancel', ['packages/ai-sdk-adapter/dist/loop.test.js']],
  ['memory_correctness', ['packages/assistant/dist/memory-correctness.test.js', 'packages/assistant/dist/memory-write-truth.test.js', 'packages/assistant/dist/memory-store.test.js', 'packages/assistant/dist/memory-candidate-store.test.js']],
  ['context_budget_cancel', ['packages/assistant/dist/context-compactor.test.js']],
  ['storage_receipts', ['packages/core/dist/jsonl-store.test.js', 'packages/assistant/dist/execution-record-store.test.js']],
];
const identity = await manifest([], 0);
const records = [];
for (const [id, files] of groups) {
  const childEnv = { ...process.env, SERIKA_EVAL_MODE: 'offline' };
  for (const key of Object.keys(childEnv)) if (/^RUNLOOM_.*(?:ACCEPTANCE|CONTINUITY|REAL_TEST)$/.test(key)) childEnv[key] = '0';
  const command = [process.execPath, '--test', '--test-concurrency=2', ...files];
  const startedAt = new Date().toISOString();
  const child = spawn(command[0], command.slice(1), { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  await writeFile(join(here, 'results', `guard-${id}.log`), output);
  records.push({ id, command, startedAt, exitCode, passed: exitCode === 0, log: `guard-${id}.log` });
  console.log(`${id}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (exit ${exitCode})`);
}
const report = { layer: 'program_guards', model: 'scripted_or_none', countedInRealModelRate: false,
  gitCommit: identity.gitCommit, evalFingerprint: identity.evalFingerprint, finishedAt: new Date().toISOString(), passed: records.every(r => r.passed), groups: records };
await writeFile(join(here, 'results/guards.json'), JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
