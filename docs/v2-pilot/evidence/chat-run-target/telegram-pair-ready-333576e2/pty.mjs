import {waitForTelegramPairReady} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-telegram-pairing.mjs';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const batchId=randomUUID(),rows=[];
await waitForTelegramPairReady({input:process.stdin,batchId,signal:AbortSignal.timeout(300000),record:async row=>{rows.push(row);await writeFile('/private/tmp/serika-197-tg-pair-ready/pty-result.json',JSON.stringify({batchId,rows},null,2)+'\n');console.log(JSON.stringify({batchId,...row}));}});
console.log(JSON.stringify({status:'completed',batchId}));
