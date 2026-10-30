export async function confirmApproval({ page, approvalId, decision }) {
  return page.evaluate(input => window.runloom.confirm(input), { approvalId, decision });
}

export async function observeApprovals({ page, onEvent }) {
  if (!await page.evaluate(() => typeof window.observeLiveApproval === 'function')) {
    await page.exposeBinding('observeLiveApproval', (_, event) => onEvent(event));
  }
  await page.evaluate(() => window.runloom.onMessage(message => {
    if (message.type === 'approval' || message.type === 'approval-cleared') {
      void window.observeLiveApproval({ ...message, at: new Date().toISOString() });
    }
  }));
}
