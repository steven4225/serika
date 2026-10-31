import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target';
const root=join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-boundary-949439cf');
const work='/private/tmp/s197-boundary-work';
const hash=value=>createHash('sha256').update(value).digest('hex');
const gate=JSON.parse(await readFile(join(root,'result.json'),'utf8'));
assert.equal(gate.status,'passed');
for(const [file,digest] of Object.entries(gate.sourceHashes))assert.equal(hash(await readFile(join(repo,'apps/desktop/scripts',file))),digest);
const serial=await readFile(join(work,'full-serial-test.log'),'utf8');
const totals=[...serial.matchAll(/^ℹ tests (\d+)$/gm)].map(m=>Number(m[1]));
const passes=[...serial.matchAll(/^ℹ pass (\d+)$/gm)].map(m=>Number(m[1]));
const skipped=[...serial.matchAll(/^ℹ skipped (\d+)$/gm)].map(m=>Number(m[1]));
assert.equal(totals.length,3,'Runtime, desktop TypeScript and desktop script suites must all settle');
assert.equal([...serial.matchAll(/^ℹ fail (\d+)$/gm)].every(m=>Number(m[1])===0),true);
assert.equal([...serial.matchAll(/^ℹ cancelled (\d+)$/gm)].every(m=>Number(m[1])===0),true);
const guardPath=JSON.parse(serial.trim().split('\n').at(-1)).evidence;
const guard=JSON.parse(await readFile(guardPath,'utf8'));assert.equal(guard.status,'passed');assert.equal(guard.exitCode,0);assert.equal(guard.violations.length,0);
await copyFile(join(work,'full-serial-test.log'),join(root,'full-serial-test.log'));
const checks=[];
for(const [cmd,args] of [['pnpm',['typecheck']],['node',['--check','apps/desktop/scripts/chat-run-target-telegram-gate.mjs']],['node',['--check','apps/desktop/scripts/chat-run-target-telegram-live.mjs']],['git',['diff','--check']]]){
 const result=spawnSync(cmd,args,{cwd:repo,encoding:'utf8'});checks.push({cmd,args,exitCode:result.status,stdout:result.stdout,stderr:result.stderr});assert.equal(result.status,0);
}
assert.equal(execFileSync('git',['diff','--name-only','HEAD','--','packages/assistant/src','apps/desktop/src'],{cwd:repo,encoding:'utf8'}),'');
let credentialPatternHits=0;const files={};
async function visit(dir){for(const ent of await readdir(dir,{withFileTypes:true})){const file=join(dir,ent.name);if(ent.isDirectory())await visit(file);else if(!['archive-summary.json','verification.json'].includes(ent.name)){const bytes=await readFile(file);files[relative(root,file)]=hash(bytes);if(!ent.name.endsWith('.png'))for(const pattern of [/\bsk-[A-Za-z0-9_-]{12,}/g,/\b\d{5,}:[A-Za-z0-9_-]{20,}/g,/Bearer [A-Za-z0-9._~+/-]{16,}/g])credentialPatternHits+=(bytes.toString().match(pattern)||[]).length;}}}
await visit(root);assert.equal(credentialPatternHits,0);
const result={verificationId:randomUUID(),at:new Date().toISOString(),batchId:gate.batchId,status:'passed',checks,fullSerial:{totals,passes,skipped,total:totals.reduce((a,b)=>a+b,0),passed:passes.reduce((a,b)=>a+b,0),skip:skipped.reduce((a,b)=>a+b,0)},sourceHashesMatch:true,productSourceDiffEmpty:true,guard:{evidence:guardPath,exitCode:guard.exitCode,violations:guard.violations.length,metadataUnchanged:guard.metadataUnchanged,concurrentChanges:guard.events.length},credentialPatternHits,realModelCalls:0,realTelegramCalls:0,costUsd:0};
await writeFile(join(root,'verification.json'),JSON.stringify(result,null,2)+'\n');files['verification.json']=hash(await readFile(join(root,'verification.json')));
await writeFile(join(root,'archive-summary.json'),JSON.stringify({archiveId:gate.batchId,files},null,2)+'\n');console.log(JSON.stringify(result));
