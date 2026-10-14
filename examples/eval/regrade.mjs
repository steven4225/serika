import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateCase } from './oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export function regradeRecords(records, specs) {
  return records.map(record => {
    const spec = specs.find(c => c.id === record.caseId && (c.suite !== 'reliability' || c.variant === record.variant));
    if (!spec) throw new Error(`Missing frozen case: ${record.caseId}`);
    const oracle = evaluateCase(spec, record.evidence);
    return { id: record.id, caseId: record.caseId, category: record.category,
      originalOracle: record.oracle, oracle, model: record.model,
      failureClass: oracle.passed ? null : record.failureClass ?? 'agent_failure' };
  });
}

/** Re-score saved synthetic evidence only. Never import a provider or rewrite a source report. */
export async function regradeReport(source) {
  const base = join(here, 'results');
  source = resolve(source);
  const within = relative(base, source);
  if (!within || within.startsWith('..') || within.startsWith(sep)) throw new Error('Source must be a report inside eval/results');
  const plan = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const resolved = await readFile(join(source, 'frozen-eval/resolved-specs.json'), 'utf8').catch(cause => {
    if (cause.code !== 'ENOENT') throw cause; return null;
  });
  const specs = JSON.parse(resolved ?? await readFile(join(source, 'frozen-eval/e2e-cases.json'), 'utf8'));
  if (!resolved && plan.suite === 'reliability') {
    const frozen = await import(pathToFileURL(join(source, 'frozen-eval/reliability-cases.mjs')).href);
    specs.push(...frozen.reliabilityCases.flatMap(c => [0, 1, 2].map(v => frozen.reliabilitySpec(c.id, v))));
  }
  const records = [];
  for (const name of (await readdir(join(source, 'evidence'))).filter(n => n.endsWith('.json')).sort()) {
    records.push(JSON.parse(await readFile(join(source, 'evidence', name), 'utf8')));
  }
  const revised = regradeRecords(records, specs);
  const summary = { mode: 'offline_evidence_regrade', newModelCalls: 0, sourceReport: source,
    originalEvalFingerprint: plan.evalFingerprint, runtimeFingerprint: plan.runtimeFingerprint,
    oracleFingerprint: createHash('sha256').update(await readFile(join(here, 'oracle.mjs'))).digest('hex'),
    planned: plan.planned, executed: records.length, notRun: Math.max(0, plan.planned - records.length),
    originalPassed: records.filter(r => r.oracle.passed).length,
    passed: revised.filter(r => r.oracle.passed).length,
    agentFailures: revised.filter(r => r.failureClass === 'agent_failure').length,
    environmentErrors: revised.filter(r => r.failureClass === 'environment_error').length,
    records: revised.map(r => ({ ...r, sourceEvidence: join(source, 'evidence', `${r.id}.json`) })) };
  summary.byCategory = Object.fromEntries([...new Set(revised.map(r => r.category))].map(category => {
    const rows = revised.filter(r => r.category === category);
    return [category, { executed: rows.length, originalPassed: rows.filter(r => r.originalOracle.passed).length, passed: rows.filter(r => r.oracle.passed).length }];
  }));
  const dir = join(base, `${within}-regrade-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir); // Do not overwrite an earlier regrade either.
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = revised.map(r => `<tr><td>${escape(r.caseId)}</td><td>${r.originalOracle.passed ? 'PASS' : 'FAIL'}</td><td>${r.oracle.passed ? 'PASS' : 'FAIL'}</td><td>${escape(r.oracle.checks.filter(c => !c.passed).map(c => c.id).join(', '))}</td><td><a href="../${escape(within)}/evidence/${escape(r.id)}.json">原始证据</a></td></tr>`).join('');
  await writeFile(join(dir, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Serika 离线证据重评</title><h1>旧证据离线重评，不是新模型运行</h1><p>新增模型调用：0。旧报告未修改。原通过 ${summary.originalPassed}/${plan.planned}；新版 Oracle ${summary.passed}/${plan.planned}；未执行 ${summary.notRun}。</p><table><tr><th>案例</th><th>原分</th><th>重评</th><th>仍失败</th><th>证据</th></tr>${rows}</table><p><a href="summary.json">重评汇总与两版断言</a></p></html>`);
  return { directory: dir, ...summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await regradeReport(process.argv[2] ?? '');
  console.log(JSON.stringify({ directory: result.directory, newModelCalls: 0, originalPassed: result.originalPassed, passed: result.passed, planned: result.planned, byCategory: result.byCategory }));
}
