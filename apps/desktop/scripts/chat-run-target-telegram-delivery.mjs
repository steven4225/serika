import assert from 'node:assert/strict';

export function assertTelegramDelivery({ delivery, transport }) {
  assert.equal(delivery?.state, 'submitted');
  const parts = delivery.parts ?? [delivery];
  for (const part of parts) {
    assert.equal(part.state, 'submitted');
    assert.ok(transport.some(row => row.direction === 'outbound' && row.status === 'submitted' &&
      row.chatId === delivery.chatId && row.messageId === part.messageId && row.text === part.text &&
      (!delivery.parts || row.format === 'HTML')), 'Missing exact submitted Telegram part');
  }
}
