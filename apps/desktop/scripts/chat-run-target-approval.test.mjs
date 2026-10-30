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
