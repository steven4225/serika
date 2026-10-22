import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECKER_VERSION, responseChecks, summaryChecks } from './cm-step6-live.mjs';
import { compactionFidelitySpec, effectiveCompactionFidelitySpec } from './compaction-fidelity.mjs';
import { validateContextSummary } from '@serika/assistant/internal/context-compaction.js';
import { layerMessage } from '@serika/assistant/internal/context-blocks.js';

export function selfCheck() {
  const rows = [];
  for (const id of ['CF03', 'CF05', 'CE03', 'CE05']) {
    const spec = id.startsWith('CE') ? effectiveCompactionFidelitySpec(id) : compactionFidelitySpec(id);
    const { goal, decision, pending, permission } = spec.truth;
    const variants = [
      { goal, reply: `目标：${goal}。已确认决定：${decision}。待办：${pending}。${permission}。读取文件成功。写入结果 unknown，不能视为成功，不得自动重试。再次读取需要新的授权。` },
      { goal: `按已确认方案${goal}`, reply: `**目标**：按已确认方案${goal}，保留尚未完成的材料。决定为${decision}。未完成事项是${pending}。${permission}。此前读文件已完成。write_file 结果 TOOL_OUTCOME_UNKNOWN；须先核实效果。旧回执不构成新的授权。` },
      { goal: `继续${goal}并保留来源证据`, reply: `目标是继续${goal}并保留来源证据。已确认${decision}，下一步${pending}。${permission}。之前成功读取了文件。写入效果未知，禁止自动重试。重新读取需批准。` },
      { goal: `依既定决定${goal}，并补齐未完成材料`, reply: `目标：依既定决定${goal}，并补齐未完成材料。方案保持${decision}。待办仍为${pending}。${permission}。文件读取状态 completed。写入结果不确定，不能报告已写入；应先核实实际影响，不应重试。旧读取成功不代表新的权限。` },
    ];
    for (const [variant, item] of variants.entries()) {
      const phrase = value => [value, `已确认约定：${value}`, `继续保持${value}`, `当前任务中，${value}`][variant];
      const summary = { version: 2, goal: { text: item.goal, evidenceMessageIds: ['u'] }, constraints: [{ text: phrase(permission), evidenceMessageIds: ['u'] }],
        decisions: [{ text: phrase(decision), source: 'user', status: 'confirmed', evidenceMessageIds: ['u'] }],
        pending: [{ text: phrase(pending), evidenceMessageIds: ['u'] }], actions: [{ text: 'write_file 结果未知，不得自动重试', status: 'unknown', toolCallIds: ['fidelity-write'], evidenceMessageIds: ['w'] }], files: [], nextStep: null };
      assert.ok(validateContextSummary(summary));
      const record = { summary, layers: { index: [], recent: [{ firstMessageId: 'u', lastMessageId: 'w', timeRange: [null, null], summary }] } };
      const view = layerMessage(record);
      const answerChecks = responseChecks(item.reply);
      const checks = summaryChecks({ record, view, prepared: [view], budget: spec.contextBudget });
      rows.push({ suite: id, variant, truth: spec.truth, answer: item.reply, summaryProjection: view, answerChecks, summaryChecks: checks });
      assert.ok(Object.values(answerChecks).every(Boolean), `${id}/${variant} answer: ${JSON.stringify(answerChecks)}`);
      assert.ok(Object.values(checks).every(Boolean), `${id}/${variant} summary: ${JSON.stringify(checks)}`);
    }
  }
  return { runId: randomUUID(), generatedAt: new Date().toISOString(), checkerVersion: CHECKER_VERSION, realModelCalls: 0, costUsd: 0, rows,
    answerCheckCount: rows.reduce((n, row) => n + Object.keys(row.answerChecks).length, 0), summaryCheckCount: rows.reduce((n, row) => n + Object.keys(row.summaryChecks).length, 0) };
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const report = selfCheck();
  report.scriptHashes = Object.fromEntries(await Promise.all(['cm-step6-live.mjs', 'cm-step6-live.test.mjs', 'cm-step6-checker-self-check.mjs', 'compaction-fidelity.mjs'].map(async name => [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checkerVersion: report.checkerVersion, rows: report.rows.length, answerChecks: report.answerCheckCount, summaryChecks: report.summaryCheckCount, scriptHashes: report.scriptHashes, realModelCalls: 0 }));
}
