import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target';
const git=(...args)=>execFileSync('git',args,{cwd:repo});
const sha=b=>createHash('sha256').update(b).digest('hex');
const files=git('ls-files','docs/v2-pilot/evidence/chat-run-target/stage1-live-c9a16383/*','docs/v2-pilot/evidence/chat-run-target/stage1-telegram-74ccfd3f/*').toString().trim().split('\n');
const report={auditId:randomUUID(),at:new Date().toISOString(),sourceCommit:git('rev-parse','HEAD').toString().trim(),files:[],checks:[]};
for(const path of files){const current=sha(await readFile(join(repo,path))),committed=sha(git('show','HEAD:'+path));assert.equal(current,committed,path);report.files.push({path,sha256:current,unchanged:true});}
const path='docs/v2-pilot/evidence/chat-run-target/stage1-telegram-74ccfd3f/result.json';
const failure=JSON.parse(await readFile(join(repo,path),'utf8'));assert.equal(failure.status,'failed');assert.equal(failure.realModelCalls,0);assert.equal(failure.costUsd,0);report.checks.push({batch:'74ccfd3f',status:failure.status,realModelCalls:failure.realModelCalls,costUsd:failure.costUsd});
for(const file of ['herdr-state.json','server.log']){const retained=sha(await readFile(join(failure.isolatedRoot,'herdr-fixture',file))),archived=sha(await readFile(join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-74ccfd3f',file)));assert.equal(retained,archived);report.checks.push({retained:file,sha256:retained,unchanged:true});}
const settings=JSON.parse(execFileSync(process.execPath,['--import','./apps/desktop/node_modules/tsx/dist/loader.mjs','apps/desktop/scripts/chat-run-target-telegram-live.mjs','--check-settings'],{cwd:repo,encoding:'utf8'}));assert.equal(settings.valid,true);assert.equal(settings.runtimeRoot,'/private/tmp/s197-tg');report.settings=settings;
report.status='passed';await writeFile('/private/tmp/s197-socket-work/integrity.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,unchangedFiles:files.length,checks:report.checks,settingsValid:settings.valid,runtimeRoot:settings.runtimeRoot}));
