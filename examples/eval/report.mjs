import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const command = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
export const evaluationFiles = ['e2e-cases.json', 'reliability-cases.mjs', 'daily-compaction.mjs', 'compaction-fidelity.mjs', 'e2e.mjs', 'oracle.mjs', 'provider.mjs', 'assertions.mjs', 'run.mjs', 'report.mjs'];
export async function manifest(caseIds, repeat, options = {}) {
  const fingerprint = createHash('sha256');
  for (const file of evaluationFiles) fingerprint.update(file).update(await readFile(join(here, file)));
  const runtimeVariant = process.env.SERIKA_EVAL_BASELINE === '1' ? 'before' : 'after';
  const runtimeDirectory = runtimeVariant === 'before' ? join(here, 'results/baseline-b15a2fd-runtime/cli') : join(repo, 'packages/assistant/dist');
  const runtimeFingerprint = createHash('sha256');
  for (const file of (await readdir(runtimeDirectory, { recursive: true })).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).sort()) {
    runtimeFingerprint.update(file).update(await readFile(join(runtimeDirectory, file)));
  }
  return { startedAt: new Date().toISOString(), gitCommit: command('rev-parse', 'HEAD'),
    dirty: !!command('status', '--porcelain'), trackedDiffHash: createHash('sha256').update(command('diff', 'HEAD')).digest('hex'),
    evalFingerprint: fingerprint.digest('hex'), caseIds, repeat, planned: caseIds.length * repeat,
    runtimeVariant, runtimeFingerprint: runtimeFingerprint.digest('hex'),
    mode: 'real_model_backend', modelConfiguration: { alias: process.env.RUNLOOM_MODEL ?? null,
      requestedModelId: process.env.COMMAND_CODE_MODEL_ID ?? null },
    cache: false, wholeCaseRetries: 0, concurrency: 1,
    denominator: 'all planned scenario executions; environment errors and missing runs retained', ...options };
}
export const productCases = [
  { id: 'P01', title: '桌面工具批准／拒绝与真实产物一致', status: 'not_run' },
  { id: 'P02', title: '桌面记忆保存／同义来源／冲突待审一致', status: 'not_run' },
  { id: 'P03', title: '提醒到期：worker／应用内横幅／系统通知分开验收', status: 'not_run' },
  { id: 'P04', title: 'Telegram 收发／单次确认／同一执行关联', status: 'not_run' },
];
export async function recordProduct(dir, caseId, record, options = {}) {
  const base = join(here, 'results');
  dir = resolve(dir);
  const rel = relative(base, dir);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) throw new Error('Product report must be inside eval/results');
  if (!productCases.some(c => c.id === caseId) || !['passed', 'failed', 'blocked', 'not_run'].includes(record.status)) throw new Error('Unknown product case or status');
  if (record.status !== 'not_run' && (!record.reason || !Array.isArray(record.evidence) || record.evidence.length === 0)) throw new Error('Product verdict requires a reason and actual evidence references');
  for (const name of record.evidence ?? []) {
    const path = resolve(dir, name), within = relative(dir, path);
    if (!within || within.startsWith('..') || within.startsWith(sep) || (await lstat(path)).isSymbolicLink()) throw new Error('Product evidence must be a saved file inside its report');
  }
  const product = await readFile(join(dir, 'product.json'), 'utf8').then(JSON.parse);
  product.checks = product.checks.map(c => c.id === caseId ? { ...c, ...record, observedAt: new Date().toISOString() } : c);
  await writeFile(join(dir, 'product.json'), JSON.stringify(product, null, 2));
  const plan = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
  await finishReport(dir, plan, summary.processExitCode, options);
  return product;
}
export async function finishReport(dir, plan, exitCode, options = {}) {
  const records = [];
  for (const name of await readdir(join(dir, 'evidence')).catch(() => [])) {
    if (name.endsWith('.json')) records.push(JSON.parse(await readFile(join(dir, 'evidence', name), 'utf8')));
  }
  const result = { ...plan, finishedAt: new Date().toISOString(), processExitCode: exitCode,
    passed: records.filter(r => r.oracle.passed).length,
    agentFailures: records.filter(r => r.failureClass === 'agent_failure').length,
    environmentErrors: records.filter(r => r.failureClass === 'environment_error').length,
    notRun: Math.max(0, plan.planned - records.length), records: records.map(r => ({ id: r.id, caseId: r.caseId, category: r.category,
      title: r.title, source: r.source, variant: r.variant ?? null, passed: r.oracle.passed, failureClass: r.failureClass, durationMs: r.durationMs,
      model: r.model, usage: r.usage, failedChecks: r.oracle.checks.filter(c => !c.passed), evidence: `evidence/${r.id}.json` })) };
  result.byCategory = Object.fromEntries([...new Set([...Object.keys(plan.plannedByCategory ?? {}), ...result.records.map(r => r.category)])].map(category => {
    const rows = result.records.filter(r => r.category === category);
    const planned = plan.plannedByCategory?.[category] ?? rows.length;
    return [category, { planned, executed: rows.length, notRun: Math.max(0, planned - rows.length), passed: rows.filter(r => r.passed).length, percent: Number((rows.filter(r => r.passed).length / planned * 100).toFixed(2)), agentFailures: rows.filter(r => r.failureClass === 'agent_failure').length, environmentErrors: rows.filter(r => r.failureClass === 'environment_error').length }];
  }));
  result.byCase = Object.fromEntries(plan.caseIds.map(caseId => {
    const rows = result.records.filter(r => r.caseId === caseId);
    return [caseId, { planned: plan.repeat, executed: rows.length, passed: rows.filter(r => r.passed).length,
      allVariantsPassed: rows.length === plan.repeat && rows.every(r => r.passed) }];
  }));
  await writeFile(join(dir, 'summary.json'), JSON.stringify(result, null, 2));
  const product = await readFile(join(dir, 'product.json'), 'utf8').then(JSON.parse)
    .catch(cause => { if (cause.code !== 'ENOENT') throw cause; return { layer: 'native_product', backendPassIsNotProductPass: true, checks: structuredClone(productCases) }; });
  await writeFile(join(dir, 'product.json'), JSON.stringify(product, null, 2));
  const guard = await readFile(join(dir, 'guards.json'), 'utf8').then(JSON.parse).catch(() => ({ status: 'not_run' }));
  const table = result.records.map(r => `<tr><td>${escape(r.caseId)} ${escape(r.title)}${r.variant === null ? '' : ` · 变体 ${r.variant + 1}`}</td><td>${r.passed ? 'PASS' : escape(r.failureClass)}</td><td>${(r.durationMs / 1000).toFixed(1)}s</td><td>${escape(r.model?.modelId ?? '未知')}</td><td>${r.usage.inputTokens ?? '未知'} / ${r.usage.outputTokens ?? '未知'}</td><td>${r.failedChecks.map(c => escape(c.id)).join('<br>')}</td><td><a href="${escape(r.evidence)}">原始证据</a></td></tr>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Serika 三层 Eval</title><style>body{font:15px/1.6 system-ui;color:#3c3b41;max-width:1400px;margin:40px auto;padding:0 24px}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}a{color:#315a8d}</style><h1>Serika 三层 Eval</h1><p>真实模型 + 合成输入 + 独立验收。不是整个 Agent 的可靠性认证；不混入离线绿测。</p><p>代码 ${escape(plan.gitCommit)} · 工作区 ${plan.dirty ? '有未提交改动' : '干净'} · 测试集指纹 ${escape(plan.evalFingerprint)}</p><h2>第一层：程序保护</h2><pre>${escape(JSON.stringify(guard, null, 2))}</pre><h2>第二层：真实模型后端任务</h2><p>不同场景 ${plan.caseIds.length} 个；${escape(plan.repeatSemantics ?? `每场景重复 ${plan.repeat} 次`)}。计划 ${plan.planned} 次，通过 ${result.passed}，Agent 失败 ${result.agentFailures}，环境错误 ${result.environmentErrors}，未运行 ${result.notRun}。所有计划运行保留在分母中。</p><pre>${escape(JSON.stringify(result.byCategory, null, 2))}</pre><table><tr><th>案例</th><th>结果</th><th>耗时</th><th>实际模型</th><th>输入 / 输出 Token</th><th>失败断言</th><th>证据</th></tr>${table}</table><p>缓存字段与费用缺失记为未知；费用有价格配置才估算，不是账单。</p><h2>第三层：产品验收</h2><p>后端通过不自动填写这里。桌面、系统通知、Telegram 需各自实际证据。</p><pre>${escape(JSON.stringify(product, null, 2))}</pre><p><a href="summary.json">完整汇总 JSON</a> · <a href="promptfoo.html">Promptfoo 原始报告</a> · <a href="product.json">产品验收记录</a></p></html>`;
  await writeFile(join(dir, 'index.html'), html);
  if (options.publishLatest !== false) await writeFile(join(here, 'results/latest.json'), JSON.stringify({ directory: dir, summary: join(dir, 'summary.json'), urlPath: `/${dir.split('/').at(-1)}/index.html` }, null, 2));
  return result;
}
