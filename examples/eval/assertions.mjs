/** No LLM judge: score actual runtime/store evidence, not model success prose. */
export default function check(output, context) {
  const actual = typeof output === 'string' ? JSON.parse(output) : output;
  if (context.vars.caseId) {
    const failed = actual.oracle?.checks?.filter(check => !check.passed);
    const pass = actual.oracle?.passed === true && Array.isArray(failed) && failed.length === 0 && actual.oracle.checks.length > 0;
    return { pass, score: pass ? 1 : 0, reason: pass ? 'Independent artifact/store checks passed' : failed?.map(c => `${c.id}: ${JSON.stringify(c.actual)}`).join('; ') || 'Missing independent evidence' };
  }
  const failures = [];
  for (const [key, value] of Object.entries(context.vars.expected)) {
    if (key.endsWith('Min')) {
      if (!(actual[key.slice(0, -3)] >= value)) failures.push(`${key}: expected >= ${value}, got ${actual[key.slice(0, -3)]}`);
    } else if (actual[key] !== value) failures.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
  }
  if (/\{\s*"batchId"\s*:/.test(actual.reply ?? '')) failures.push('主回复泄漏整理 JSON');
  return { pass: failures.length === 0, score: failures.length ? 0 : 1, reason: failures.join('; ') || '运行时与保存状态符合预期' };
}
