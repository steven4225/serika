import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target',source='/private/tmp/s197-tg-live-01nov-a';
const sha=b=>createHash('sha256').update(b).digest('hex');
const original=await readFile(join(source,'result.json')),r=JSON.parse(original),a=JSON.parse(await readFile(join(source,'operator-stop-audit.json')));
assert.equal(a.originalResultSha256,sha(original));assert.equal(a.acceptance,'failed-task-start-after-successful-pairing');assert.equal(a.modelRequests,0);assert.equal(a.testProfileDisabled,true);
const out=join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-'+r.batchId.slice(0,8));await mkdir(out);
const rows=[];let credentialPrefixHits=0;
for(const name of await readdir(source)){const bytes=await readFile(join(source,name));credentialPrefixHits+=(bytes.toString().match(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g)||[]).length;await copyFile(join(source,name),join(out,name));rows.push({name,sha256:sha(bytes)});}
assert.equal(credentialPrefixHits,0);
const ledgerPath=join(repo,'docs/v2-pilot/evidence/cost-ledger.json');const ledger=JSON.parse(await readFile(ledgerPath));assert.ok(!ledger.entries.some(x=>x.runId===r.batchId));
ledger.entries.push({step:'chat-run-target-stage1-telegram',runId:r.batchId,realModelRequests:0,taskRuns:0,amount:0,amountBasis:'Successful dedicated Bot pairing, then task startup rejected before any model dispatch; operator stopped without retry',authorizedBatchCapUsd:r.capUsd,authorizedBatchMaxRequests:r.maxRequests,authorizedBatchMaxRuns:r.maxRuns,unresolvedCalls:0,unresolvedReservedUsd:0,evidence:'chat-run-target/stage1-telegram-'+r.batchId.slice(0,8)+'/result.json',evidenceSha256:sha(original),acceptance:a.acceptance,audit:'chat-run-target/stage1-telegram-'+r.batchId.slice(0,8)+'/operator-stop-audit.json'});
await writeFile(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const summary={auditId:randomUUID(),at:new Date().toISOString(),batchId:r.batchId,acceptance:a.acceptance,originalResultStatus:r.status,harnessFinalizationCompleted:false,originalResultSha256:sha(original),originalResultUnmodified:sha(await readFile(join(out,'result.json')))===sha(original),credentialPrefixHits,files:rows,ledgerRecordedExactlyOnce:ledger.entries.filter(x=>x.runId===r.batchId).length===1};
await writeFile(join(out,'archive-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({out,acceptance:summary.acceptance,originalResultStatus:r.status,originalResultUnmodified:summary.originalResultUnmodified,credentialPrefixHits,ledgerRecordedExactlyOnce:summary.ledgerRecordedExactlyOnce}));
