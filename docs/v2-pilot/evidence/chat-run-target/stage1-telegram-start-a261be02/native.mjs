import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {setup,addPi,cleanup} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-live-herdr.mjs';
import {tryAcquireFlock} from '/Users/a1-6/Code/agents/serika-chat-run-target/packages/assistant/dist/flock.js';
const output='/private/tmp/s197-start-fix/native';await mkdir(output);
const root=await mkdtemp('/private/tmp/r197-');
const report={batchId:randomUUID(),startedAt:new Date().toISOString(),verification:'real-herdr-start-connect-lease-in-fresh-short-root',root,status:'failed',modelProxyRequests:0,realModelCalls:0,telegramCalls:0,costUsd:0,retainedFailureRootUntouched:'/private/tmp/s197-tg'};
const proxy=createServer((_req,res)=>{report.modelProxyRequests++;res.writeHead(503);res.end('Offline only');});let lease,fixture;
try{
 lease=await tryAcquireFlock(join(root,'harness.lock'));assert.ok(lease);
 await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
 fixture=await setup(root,`http://127.0.0.1:${proxy.address().port}/pi/v1`,'deepseek/deepseek-v4.1-flash-fast');
 await addPi(fixture.statePath);
 report.workspaceList=JSON.parse(execFileSync('/opt/homebrew/bin/herdr',['--session',fixture.target.session,'workspace','list'],{cwd:fixture.work,env:fixture.env,encoding:'utf8',timeout:35000}));
 assert.equal(report.workspaceList.result.type,'workspace_list');assert.equal(report.workspaceList.error,undefined);
 const state=JSON.parse(await readFile(fixture.statePath));assert.equal(state.phase,'ready');assert.equal(state.targets.length,2);report.serverPid=state.serverPid;process.kill(state.serverPid,0);
 const second=await tryAcquireFlock(join(root,'harness.lock'));assert.equal(second,null);report.concurrentLeaseRejected=true;
 assert.equal(report.modelProxyRequests,0);report.cleanup=await cleanup(fixture.statePath);assert.equal(report.modelProxyRequests,0);
 await copyFile(fixture.statePath,join(output,'herdr-state.json'));await copyFile(join(fixture.root,'server.log'),join(output,'server.log'));
 await lease.release();lease=undefined;const reacquired=await tryAcquireFlock(join(root,'harness.lock'));assert.ok(reacquired);await reacquired.release();report.leaseReleasedAndReacquired=true;
 await rm(root,{recursive:true});report.status='passed';
}catch(error){report.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{await new Promise(done=>proxy.close(done));if(lease)await lease.release();report.finishedAt=new Date().toISOString();await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,failure:report.failure,modelProxyRequests:report.modelProxyRequests,leaseReleasedAndReacquired:report.leaseReleasedAndReacquired,output}));
