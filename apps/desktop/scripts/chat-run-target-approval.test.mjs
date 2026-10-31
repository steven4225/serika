import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalChain } from './chat-run-target-approval.mjs';

test('an observed file approval cannot be reported as automatic or lack a decision source', () => {
  const receipt = { tools: [{ toolCallId: 'file', toolName: 'read_file', approvalRequestedAt: 'observed' }] };
  const events = [{ type: 'approval', runId: 'run', approval: { toolCallId: 'file', approvalId: 'approval' } },
    { type: 'event', event: { runId: 'run', type: 'tool.call.completed', data: { toolCallId: 'file', output: { ok: true } } } }];
  assert.throws(() => approvalChain({ runId: 'run', receipt, events, decisions: [] }), /accepted decision source/);
  const decisions = [{ runId: 'run', toolCallId: 'file', approvalId: 'approval', source: 'original-preload-confirm', response: { accepted: true } }];
  assert.equal(approvalChain({ runId: 'run', receipt, events, decisions })[0].permission, 'explicit');
  assert.throws(() => approvalChain({ runId: 'run', receipt, events, decisions: [{ ...decisions[0], toolCallId: 'other' }] }), /accepted decision source/);
});

test('one control approval and a separately approved file read retain both conclusions', () => {
  const runId = 'run', target = { terminalId: 'terminal', paneId: 'pane' }, action = { action: 'prompt', text: 'body' };
  const receipt = { tools: [{ toolCallId: 'control', toolName: 'herdr_pi_control' }, { toolCallId: 'file', toolName: 'read_file', approvalRequestedAt: 'observed' }] };
  const decisions = receipt.tools.map(tool => ({ runId, toolCallId: tool.toolCallId, approvalId: `${tool.toolCallId}-approval`, source: 'runtime-bridge', decision: 'allow',
    response: { accepted: true }, value: tool.toolCallId === 'control' ? { herdr: { target, action, selectionVersion: 1 } } : {} }));
  const events = decisions.flatMap(row => [{ type: 'approval', runId, approval: { toolCallId: row.toolCallId, approvalId: row.approvalId } },
    { type: 'approval-cleared', runId, approvalId: row.approvalId }]);
  events.push({ type: 'event', event: { runId, type: 'tool.call.requested', data: { toolCallId: 'control', input: action } } });
  for (const tool of receipt.tools) events.push({ type: 'event', event: { runId, type: 'tool.call.completed', data: { toolCallId: tool.toolCallId,
    output: tool.toolCallId === 'control' ? { ok: true, value: { ...target, dispatched: true } } : { ok: true, content: 'artifact' } } } });
  const chain = approvalChain({ runId, receipt, events, decisions });
  assert.equal(chain.filter(row => row.approvalId).length, 2);
  assert.equal(chain.filter(row => row.frozen).length, 1);
  assert.equal(chain.find(row => row.toolName === 'read_file').permission, 'explicit');
  assert.throws(() => approvalChain({ runId, receipt, events, decisions: decisions.slice(0, 1) }), /accepted decision source/);
});
