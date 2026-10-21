import { maskOldestBlock } from '@serika/assistant/internal/context-blocks.js';

// Fixture geometry uses the same complete-unit boundaries as production masking.
export function sourceBlocks(units, tokens) {
  const messages = units.flatMap(unit => unit.messages), blocks = [];
  let start = 0;
  while (start < messages.length) {
    const end = maskOldestBlock(messages, start, tokens);
    if (end <= start) break;
    blocks.push(messages.slice(start, end)); start = end;
  }
  return blocks;
}
