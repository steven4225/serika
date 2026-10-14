import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, 'results');
const wanted = ['MY01', 'MY02', 'MY03', 'MY04', 'T05', 'T06', 'S03', 'C03'];
const reports = [];
for (const name of await readdir(base)) {
  try {
    const data = JSON.parse(await readFile(join(base, name, 'summary.json'), 'utf8'));
    if (data.caseIds?.join(',') === wanted.join(',')) reports.push({ name, data });
  } catch (cause) { if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause; }
}
const latest = variant => reports.filter(r => r.data.runtimeVariant === variant).sort((a, b) => a.data.startedAt.localeCompare(b.data.startedAt)).at(-1);
const before = latest('before'), after = latest('after');
if (!before || !after) throw new Error('Before/After 尚未各执行；不生成推算成功率');
if (before.data.evalFingerprint !== after.data.evalFingerprint || before.data.repeat !== after.data.repeat) throw new Error('测试集／Oracle／重复数不同，禁止直接作前后比较');
if (before.data.modelConfiguration?.requestedModelId !== after.data.modelConfiguration?.requestedModelId) throw new Error('模型不同，禁止混算前后对照');
const rate = d => Number((d.passed / d.planned * 100).toFixed(2));
const perCase = wanted.map(caseId => {
  const counts = report => { const rows = report.data.records.filter(r => r.caseId === caseId); return { planned: report.data.repeat, executed: rows.length, passed: rows.filter(r => r.passed).length,
    environmentErrors: rows.filter(r => r.failureClass === 'environment_error').length, failures: rows.filter(r => !r.passed).map(r => ({ evidence: join(base, report.name, r.evidence), checks: r.failedChecks })) }; };
  return { caseId, source: ['MY01','MY02','MY03','MY04'].includes(caseId) ? '我的 eval' : '100% 补测', before: counts(before), after: counts(after),
    ...(caseId === 'MY04' ? { boundary: '仅场景安全观察，未实现放宽自动保存' } : {}) };
});
const comparison = { evalFingerprint: after.data.evalFingerprint,
  before: { report: join(base, before.name), passed: before.data.passed, planned: before.data.planned, percent: rate(before.data), runtimeFingerprint: before.data.runtimeFingerprint },
  after: { report: join(base, after.name), passed: after.data.passed, planned: after.data.planned, percent: rate(after.data), runtimeFingerprint: after.data.runtimeFingerprint },
  percentagePointChange: Number((rate(after.data) - rate(before.data)).toFixed(2)), perCase,
  boundaries: ['真实模型后端＋合成输入，不等于日用 Electron 重载', 'MY03 模拟 Telegram 入站时钟；真实 Gateway 传递另有离线集成回归', 'C03 使用 12K 隔离预算，不宣称 256K／400K 压力验收', 'M04 仅安全边界，未放宽自动保存'] };
await writeFile(join(base, 'card-ab-comparison.json'), JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison, null, 2));
