import assert from 'node:assert/strict';

export async function confirmApproval({ page, approvalId, decision, decisions, save }) {
  const snapshot = await page.evaluate(() => window.runloom.snapshot());
  const value = snapshot.pendingApproval?.approvalId === approvalId ? snapshot.pendingApproval : null;
  const row = { runId: snapshot.state.runId, approvalId, toolCallId: value?.toolCallId ?? null, value,
    decision, source: 'original-preload-confirm', at: new Date().toISOString(), status: 'attempting' };
  decisions?.push(row);
  await save?.();
  try {
    row.response = await page.evaluate(input => window.runloom.confirm(input), { approvalId, decision });
    row.status = row.response.accepted ? 'accepted' : 'rejected';
    await save?.();
    return row.response;
  } catch (error) {
    row.status = 'unknown';
    await save?.();
    throw error;
  }
}

export async function observeApprovals({ page, onEvent }) {
  if (!await page.evaluate(() => typeof window.observeLiveApproval === 'function')) {
    await page.exposeBinding('observeLiveApproval', (_, event) => onEvent(event));
  }
  await page.evaluate(async () => {
    window.stopLiveApprovalObservation?.();
    let runId = (await window.runloom.snapshot()).state.runId;
    const approvals = new Map();
    window.stopLiveApprovalObservation = window.runloom.onMessage(message => {
      if (message.type === 'state' && message.state.kind === 'running') runId = message.state.runId;
      if (message.type === 'event' && message.phase === 'primary') runId = message.event.runId;
      if (message.type === 'approval') approvals.set(message.approval.approvalId, runId);
      if (['state', 'approval', 'approval-cleared', 'event', 'herdr-selection', 'herdr-selection-cleared'].includes(message.type)) {
        void window.observeLiveApproval({ ...message, runId: message.type === 'event' ? message.event.runId :
          message.type === 'approval-cleared' ? approvals.get(message.approvalId) ?? runId : runId, at: new Date().toISOString() });
      }
    });
  });
}

export function approvalChain({ runId, receipt, decisions, events }) {
  const raw = events.filter(row => row.type === 'event' && row.event.runId === runId).map(row => row.event);
  const chain = [];
  for (const tool of receipt.tools) {
    const end = raw.find(event => event.data.toolCallId === tool.toolCallId && ['tool.call.completed', 'tool.call.failed'].includes(event.type));
    assert.ok(end, `Missing tool outcome: ${tool.toolCallId}`);
    const accepted = decisions.filter(row => row.runId === runId && row.toolCallId === tool.toolCallId && row.response?.accepted);
    const cards = events.filter(row => row.type === 'approval' && row.runId === runId && row.approval.toolCallId === tool.toolCallId);
    if (cards.length || tool.approvalRequestedAt) {
      assert.equal(accepted.length, 1, 'An observed approval needs exactly one accepted decision source');
      assert.equal(accepted[0].source, 'original-preload-confirm');
      assert.ok(cards.some(card => card.approval.approvalId === accepted[0].approvalId), 'Accepted ID lacks original approval event');
    }
    if (tool.toolName === 'herdr_pi_control') {
      assert.equal(accepted.length, 1, 'Each control conclusion needs exactly one accepted host decision');
      const decision = accepted[0], output = end.data.output;
      assert.ok(decision.value?.herdr, 'Missing frozen identity and action');
      assert.equal(decision.source, 'original-preload-confirm');
      const requested = raw.find(event => event.type === 'tool.call.requested' && event.data.toolCallId === tool.toolCallId);
      assert.ok(requested, 'Missing original requested action');
      assert.deepEqual(requested.data.input, decision.value.herdr.action, 'Requested and approved bodies differ');
      assert.ok(events.some(row => row.type === 'approval' && row.runId === runId && row.approval.approvalId === decision.approvalId));
      assert.ok(events.some(row => row.type === 'approval-cleared' && row.runId === runId && row.approvalId === decision.approvalId));
      const dispatched = output?.ok === true && output.value?.dispatched === true;
      if (dispatched) {
        assert.equal(decision.decision, 'allow');
        assert.equal(output.value.terminalId, decision.value.herdr.target.terminalId);
        assert.equal(output.value.paneId, decision.value.herdr.target.paneId);
      } else {
        assert.ok(end.type === 'tool.call.failed' || output?.ok === false, 'Missing explicit non-dispatch outcome');
        assert.notEqual(end.data.error?.code, 'TOOL_OUTCOME_UNKNOWN', 'Unknown is not non-dispatch');
      }
      chain.push({ runId, toolCallId: tool.toolCallId, approvalId: decision.approvalId, frozen: decision.value.herdr,
        decision: decision.decision, source: decision.source, accepted: true,
        dispatched, reason: dispatched ? null : end.data.error?.code ?? output.error.code });
    } else {
      chain.push({ runId, toolCallId: tool.toolCallId, toolName: tool.toolName,
        approvalId: accepted[0]?.approvalId ?? null, permission: accepted.length ? 'explicit' : ['herdr_pi_discover', 'herdr_pi_read', 'read_file'].includes(tool.toolName) ? 'read-auto' : 'auto-allow', outcome: end.data });
    }
  }
  for (const row of decisions.filter(row => row.runId === runId && row.response?.accepted)) {
    assert.ok(chain.some(item => item.toolCallId === row.toolCallId), 'Accepted decision lacks execution or non-execution conclusion');
  }
  return chain;
}
