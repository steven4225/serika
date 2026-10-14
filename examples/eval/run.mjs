import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { requireLive } from './provider.mjs';
import { manifest, finishReport, evaluationFiles } from './report.mjs';
import { reliabilityCases, reliabilitySpec } from './reliability-cases.mjs';
import { dailyCompactionCases, dailyCompactionSpec } from './daily-compaction.mjs';
import { compactionFidelityCases, compactionFidelitySpec } from './compaction-fidelity.mjs';

const mode = process.argv[2];
if (!['offline', 'live', 'e2e', 'view'].includes(mode)) throw new Error('使用 offline / live / e2e / view');
if (mode === 'live' || mode === 'e2e') requireLive(process.env);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const state = join(cwd, '.promptfoo');
await mkdir(state, { recursive: true });
await mkdir(join(cwd, 'results'), { recursive: true });
const env = { ...process.env, SERIKA_EVAL_MODE: mode,
  PROMPTFOO_CONFIG_DIR: state, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_CACHE_ENABLED: 'false',
  PROMPTFOO_DISABLE_UPDATE: '1' };
if (mode === 'view') {
  // promptfoo 0.124's view command binds all interfaces and has no --host.
  // Serve only our exported HTML reports on loopback, not its management API.
  const server = createServer(async (request, response) => {
    let file = { '/': 'offline.html', '/offline.html': 'offline.html', '/live.html': 'live.html' }[request.url];
    if (request.url === '/latest') {
      try { const latest = JSON.parse(await readFile(join(cwd, 'results/latest.json'), 'utf8')); response.writeHead(302, { Location: latest.urlPath }).end(); }
      catch { response.writeHead(404).end('E2E report not generated'); }
      return;
    }
    if (!file && /^\/[\w-]+\/(?:index\.html|summary\.json|product\.json|promptfoo\.(?:html|json|csv)|evidence\/[\w-]+\.json)$/.test(request.url ?? '')) file = request.url.slice(1);
    if (!file) { response.writeHead(404).end('Not found'); return; }
    try {
      const report = await readFile(join(cwd, 'results', file));
      response.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json; charset=utf-8' : file.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(report);
    } catch {
      response.writeHead(404).end('报告尚未生成，请先运行 pnpm eval 或 pnpm eval:live');
    }
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  const port = Number(process.env.SERIKA_EVAL_VIEW_PORT ?? 15500);
  server.listen(port, '127.0.0.1', () => console.log(`评测报告：http://127.0.0.1:${port}/latest（旧 live：/live.html）；Ctrl+C 关闭`));
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
} else {
  if (mode === 'e2e') {
    const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
    const suite = option('--suite') ?? 'seed';
    if (!['seed', 'reliability', 'daily-compaction', 'compaction-fidelity'].includes(suite)) throw new Error('suite must be seed, reliability, daily-compaction or compaction-fidelity');
    const raw = suite === 'reliability' ? reliabilityCases : suite === 'daily-compaction' ? dailyCompactionCases
      : suite === 'compaction-fidelity' ? compactionFidelityCases : JSON.parse(await readFile(join(cwd, 'e2e-cases.json'), 'utf8'));
    const repeat = Number(option('--repeat') ?? 3);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error('repeat must be 1..5');
    if (suite === 'reliability' && repeat > 3) throw new Error('Reliability fixtures have exactly three expression/data variants, not five identical repeats');
    if (suite === 'daily-compaction' && repeat !== 1) throw new Error('This daily-scale first batch runs each mode/scenario exactly once');
    if (suite === 'compaction-fidelity' && repeat !== 1) throw new Error('Continuous fidelity cases run once each; 3/5 are compaction rounds, not case repeats');
    if (suite !== 'seed' && (!['command-code', 'command-code/default'].includes(process.env.RUNLOOM_MODEL) || process.env.COMMAND_CODE_MODEL_ID !== 'deepseek/deepseek-v4.1-flash-fast')) throw new Error('Reliability run requires Command Code deepseek/deepseek-v4.1-flash-fast');
    const ids = option('--cases')?.split(',') ?? raw.map(c => c.id);
    if (new Set(ids).size !== ids.length || ids.some(id => !raw.some(c => c.id === id))) throw new Error('unknown or duplicate case ID');
    const plan = await manifest(ids, repeat, { suite, repeatSemantics: suite === 'reliability' ? `每场景 ${repeat} 个明确的表达／数据变体，各独立运行一次；不是重试或 ${ids.length * repeat} 个不同任务` : suite === 'daily-compaction' ? '每档位、每场景独立运行一次；日用 256K／长任务 400K 配置与大体量合成历史，不代表模型物理上限或原生日用验收'
      : suite === 'compaction-fidelity' ? '两项独立回归任务：日常档连续3轮／长任务档连续5轮压缩，逐轮快照＋新进程复用；轮数不是独立样本数，不代表产品可靠性或模型物理容量' : `每场景相同输入独立重复 ${repeat} 次`,
      plannedByCategory: Object.fromEntries([...new Set(raw.map(c => c.category))].map(category => [category, ids.filter(id => raw.find(c => c.id === id).category === category).length * repeat])) });
    const dir = join(cwd, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.gitCommit.slice(0, 7)}-${plan.runtimeVariant}`);
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(plan, null, 2));
    await mkdir(join(dir, 'frozen-eval'));
    for (const name of evaluationFiles) {
      await writeFile(join(dir, 'frozen-eval', name), await readFile(join(cwd, name)));
    }
    const guards = await readFile(join(cwd, 'results/guards.json'), 'utf8').catch(() => JSON.stringify({ status: 'not_run' }));
    await writeFile(join(dir, 'guards.json'), guards);
    const tests = join(dir, 'cases.json');
    const specs = suite === 'reliability' ? ids.flatMap(id => Array.from({ length: repeat }, (_, variant) => reliabilitySpec(id, variant)))
      : ids.map(id => suite === 'daily-compaction' ? dailyCompactionSpec(id) : suite === 'compaction-fidelity' ? compactionFidelitySpec(id) : raw.find(c => c.id === id));
    await writeFile(join(dir, 'frozen-eval/resolved-specs.json'), JSON.stringify(specs, null, 2));
    const rows = specs.map(c => ({ description: `${c.id}: ${c.title}${c.contextMode ? ` / ${c.contextMode}` : c.variant != null ? ` / 变体${c.variant + 1}` : ''}`,
      vars: { caseId: c.id, ...(c.variant != null ? { variant: c.variant } : {}), input: c.turns[0] } }));
    await writeFile(tests, JSON.stringify(rows));
    const child = spawn(join(cwd, 'node_modules/.bin/promptfoo'), ['eval', '--config', 'promptfooconfig.yaml', '--tests', tests, '--no-cache', '--no-share', '--max-concurrency', '1', '--repeat', String(suite === 'seed' ? repeat : 1), '--no-table',
      '--output', join(dir, 'promptfoo.json'), '--output', join(dir, 'promptfoo.csv'), '--output', join(dir, 'promptfoo.html')],
      { cwd, env: { ...env, SERIKA_EVAL_MODE: 'live', SERIKA_EVAL_REPORT_DIR: dir }, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
    const summary = await finishReport(dir, plan, code);
    console.log(JSON.stringify({ report: dir, planned: plan.planned, passed: summary.passed, agentFailures: summary.agentFailures, environmentErrors: summary.environmentErrors, notRun: summary.notRun }));
    process.exitCode = summary.passed === plan.planned && code === 0 ? 0 : 1;
  } else {
  const cases = JSON.parse(await readFile(join(cwd, 'cases.json'), 'utf8'));
  const selected = mode === 'live' ? cases.filter(test => !test.vars.offlineOnly) : cases;
  const tests = join(state, `${mode}-cases.json`);
  await writeFile(tests, JSON.stringify(selected));
  const args = ['eval', '--config', 'promptfooconfig.yaml', '--tests', tests, '--no-cache', '--no-share', '--max-concurrency', '1',
    '--output', `results/${mode}.json`, '--output', `results/${mode}.html`];
  const child = spawn(join(cwd, 'node_modules/.bin/promptfoo'), args, { cwd, env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
}
