import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startManual, exportManual, validateFault, repo, faultSha } from './cm6-manual.mjs';
import { modelId } from './cm6-manual-transport.mjs';

const base = await mkdtemp(join(tmpdir(), 'cm6-manual-offline-'));
const output = process.env.SERIKA_CM6_MANUAL_EVIDENCE;
assert.ok(output, 'Set SERIKA_CM6_MANUAL_EVIDENCE to an evidence JSON path');
const report = { runId: randomUUID(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  kind: 'real-electron-local-http-fake-model-manual-harness', platform: process.platform, faultScriptSha256: faultSha,
  startedAt: new Date().toISOString(), realModelCalls: 0, costUsd: 0, checks: {}, requests: 0 };
report.scriptHashes = Object.fromEntries(await Promise.all(['cm6-manual.mjs', 'cm6-manual-transport.mjs', 'cm6-manual-selftest.mjs', 'cm-step6-open-fault.mjs'].map(async name =>
  [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(p => p.text ?? '').join('\n');
async function respond(body) {
  report.requests++;
  const whole = body.messages.map(textOf).join('\n'), last = body.messages.findLast(m => m.role === 'user');
  const text = last ? textOf(last) : ''; let content = '收到。', tool;
  if (whole.includes('You are a context compactor.')) {
    const original = JSON.parse(/Original block:\n([^\n]+)/.exec(whole)[1]);
    const item = text => ({ text, evidenceMessageIds: [original[0].id] });
    content = JSON.stringify({ version: 2, goal: item('完成验收报告'), constraints: [item('部署未获批准')],
      decisions: [{ ...item('采用本地文件方案'), source: 'user', status: 'confirmed' }], pending: [item('补充失败样本')],
      actions: [], files: [], nextStep: null, farIndex: '灯塔项目，验收报告。' });
  } else if (whole.includes('Task: extract memory from the preceding original block.')) {
    const ids = JSON.parse(/Eligible user IDs: (\[[^\n]*\])/.exec(whole)[1]);
    content = JSON.stringify({ proposals: [], outcomes: ids.map(messageId => ({ messageId, status: 'no_memory' })) });
  } else if (!body.messages.slice(body.messages.indexOf(last) + 1).some(m => m.role === 'tool')) {
    if (text.includes('记住：')) tool = { name: 'memory_write', arguments: JSON.stringify({ operation: 'add', text: '我希望报告先给结论', category: 'preference', sourceQuote: '我希望报告先给结论', identity: { subject: 'user', attribute: '报告格式', value: '先给结论' } }) };
    if (text.includes('只调用一次 read_file')) tool = { name: 'read_file', arguments: JSON.stringify({ path: 'notes/brief.txt' }) };
    if (text.includes('只调用一次 write_file')) tool = { name: 'write_file', arguments: JSON.stringify({ path: 'notes/uncertain-manual.txt', content: '灯塔项目待核实写入' }) };
  }
  const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: tool }] } : { role: 'assistant', content };
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } };
  const frame = choices => ({ id: randomUUID(), object: 'chat.completion', created: 1, model: modelId, choices });
  if (!body.stream) return Response.json({ ...frame([{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }]), usage });
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : message;
  const frames = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]), { ...frame([]), usage }];
  return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
let run;
async function send(text, allowedTool) {
  await run.page.getByLabel('消息输入', { exact: true }).fill(text);
  await run.page.getByRole('button', { name: '发送消息', exact: true }).click();
  await delay(200);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await run.page.evaluate(() => window.runloom.snapshot());
    if (state.pendingApproval) {
      assert.equal(state.pendingApproval.toolName, allowedTool);
      await run.page.evaluate(id => window.runloom.confirm({ approvalId: id, decision: 'allow' }), state.pendingApproval.id ?? state.pendingApproval.approvalId);
    }
    if (state.state.kind === 'idle') {
      const diag = await run.page.evaluate(() => window.runloom.getContextDiagnostics());
      assert.ok(diag.ok); assert.equal(diag.value.background?.error ?? null, null);
      if (!diag.value.background?.running && !diag.value.background?.queued) { await run.capture(); return; }
    }
    await delay(150);
  }
  throw new Error('Offline turn did not settle');
}
try {
  const faultPath = 'notes/uncertain-manual.txt';
  run = await startManual({ base, fresh: true, faultPath, respond }); const root = run.root;
  report.electron = await run.app.evaluate(() => process.versions.electron);
  report.checks.isolation = (await run.page.evaluate(() => window.runloom.info())).workspaceRoot === join(root, 'workspace');
  await assert.rejects(exportManual({ base }), /仍在运行/); report.checks.exportWhileRunningRejected = true;
  for (const path of ['../escape', '/tmp/escape', 'notes/uncertain.txt', 'notes/brief.txt', 'notes/../escape']) await assert.rejects(validateFault(join(root, 'workspace'), path));
  await symlink(join(root, 'workspace/notes'), join(root, 'workspace/link'));
  await assert.rejects(validateFault(join(root, 'workspace'), 'link/escape')); await rm(join(root, 'workspace/link'));
  report.checks.invalidAndExistingFaultPathsRejected = true;
  await send('目标：完成验收报告。已确认决定：采用本地文件方案。待办：补充失败样本。部署未获批准。记住：我希望报告先给结论。', 'memory_write');
  await send('请只调用一次 read_file 读取 notes/brief.txt。', 'read_file');
  await send('请只调用一次 write_file 写入 notes/uncertain-manual.txt。结果未知就停止，禁止重试。', 'write_file');
  await delay(2000); await run.capture();
  const faults = (await readdir(join(root, 'captures'))).filter(n => n.startsWith('fault-'));
  const fault = JSON.parse(await readFile(join(root, 'captures', faults[0])));
  assert.equal(fault.matched, 1); assert.equal(fault.delegatedTargetOpens, 0); assert.equal(fault.released, 1); assert.equal(fault.exists, false);
  report.fault = fault; report.checks.unknownWithNoWrite = true;
  const doc = await readFile(join(repo, 'docs/v2-pilot/cm6-manual-test.md'), 'utf8');
  const material = /<!-- cm6-material -->\s*```text\n([\s\S]*?)\n```/.exec(doc)[1];
  for (let i = 0; i < 8; i++) {
    await send(`背景材料第${i + 1}份，请读完只回复收到。\n${material}`);
    const d = await run.page.evaluate(() => window.runloom.getContextDiagnostics());
    const observed = (await readFile(join(root, 'captures/diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (new Set(observed.map(r => r.diagnostic.value.latestValidCompaction?.id).filter(Boolean)).size >= 2) break;
    assert.equal(d.value.background?.error, null);
  }
  const question = '当前目标、已确认决定、待办、部署权限是什么？先前 read_file 是否成功，能否因此再次读取？write_file 结果是否确定，能否重试？我让你记住了什么？只回答，不调用工具。';
  await send(question);
  const before = await run.page.evaluate(() => window.runloom.history());
  const beforePid = run.app.process().pid;
  await run.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await Promise.race([run.closed, delay(15000, undefined, { ref: false }).then(() => { throw new Error('Window close did not exit the test process'); })]);
  report.checks.windowCloseExitsProcess = true;
  run = await startManual({ base, faultPath, respond }); assert.equal(run.root, root);
  assert.notEqual(run.app.process().pid, beforePid);
  assert.deepEqual(await run.page.evaluate(() => window.runloom.history()), before);
  report.checks.coldStartSameDirectoryAndHistory = true;
  await send(question); await run.stop(); await run.closed; run = undefined;
  const bundle = await exportManual({ base });
  const diagnostics = JSON.parse(await readFile(join(bundle, 'context-diagnostics.json')));
  assert.ok(diagnostics.publishedCompactionCount >= 2); assert.equal(diagnostics.prepareFailures.length, 0);
  report.compactions = diagnostics.publishedCompactionCount; report.checks.twoPublishedCompactions = true;
  const history = JSON.parse(await readFile(join(bundle, 'history.json')));
  const parts = history.flatMap(m => m.parts);
  assert.ok(parts.some(p => p.type === 'dynamic-tool' && p.toolName === 'read_file' && p.output?.ok));
  const events = await readFile(join(bundle, 'captures/events.jsonl'), 'utf8');
  assert.ok(events.includes('TOOL_OUTCOME_UNKNOWN'));
  const dialogue = await readFile(join(bundle, 'dialogue.md'), 'utf8');
  assert.ok(dialogue.includes('请只调用一次 write_file')); assert.ok(dialogue.includes('TOOL_OUTCOME_UNKNOWN'));
  const memory = JSON.parse(await readFile(join(bundle, 'memory-page.json')));
  assert.ok(JSON.stringify(memory).includes('我希望报告先给结论'));
  report.checks.realReadUnknownReceiptAndMemoryExported = true;
  const costs = JSON.parse(await readFile(join(bundle, 'costs.json')));
  assert.equal(costs.unknownCostRequests, 0); assert.equal(costs.knownCostUsd, 0); assert.equal(costs.calls.length, report.requests);
  assert.ok(costs.calls.every(c => c.usage.input === 10 && c.usage.output === 5));
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json')));
  for (const [path, hash] of Object.entries(manifest.hashes)) assert.equal(createHash('sha256').update(await readFile(join(bundle, path))).digest('hex'), hash);
  report.checks.completeExportAndHashes = true; report.exportFiles = Object.keys(manifest.hashes); report.costRequests = costs.calls.length;
  if (process.env.SERIKA_CM6_MANUAL_BUNDLE) await cp(bundle, process.env.SERIKA_CM6_MANUAL_BUNDLE, { recursive: true, errorOnExist: true, force: false });
  run = await startManual({ base, fresh: true, respond }); assert.notEqual(run.root, root);
  assert.equal((await run.page.evaluate(() => window.runloom.history())).length, 0); assert.ok(await readFile(join(root, 'session.json')));
  report.checks.freshPreservesOldDirectory = true; await run.stop(); await run.closed; run = undefined;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  if (run) { await run.stop(); await run.closed; }
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, requests: report.requests, compactions: report.compactions, failure: report.failure }));
  await rm(base, { recursive: true, force: true });
}
