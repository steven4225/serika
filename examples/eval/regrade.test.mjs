import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regradeRecords } from './regrade.mjs';

test('offline regrade keeps original verdict and evidence immutable, without a provider', () => {
  const record = { id: 'saved', caseId: 'T05', category: 'chat_tools', oracle: { passed: false, checks: [{ id: 'fixture_boundary', passed: false }] },
    failureClass: 'agent_failure', evidence: { phases: [{ status: 'completed', reply: '已保存' }], artifact: '## 一、任务目标\n验证文件交付。\n## 二、执行过程\n写入并读回。\n## 三、验证结果\n内容检查通过。\n',
      runs: [{ tools: [{ toolName: 'write_file', status: 'completed' }, { toolName: 'read_file', status: 'completed' }] }],
      approvals: [{ toolName: 'list_directory', input: { path: 'notes' }, allowed: true }], extraFiles: [] } };
  const before = JSON.stringify(record);
  const [result] = regradeRecords([record], [{ id: 'T05', kind: 'create', strictArtifact: true }]);
  assert.equal(result.originalOracle.passed, false);
  assert.equal(result.oracle.passed, true);
  assert.equal(result.failureClass, null);
  assert.equal(JSON.stringify(record), before);
  assert.throws(() => regradeRecords([record], []), /Missing frozen case/);
});
