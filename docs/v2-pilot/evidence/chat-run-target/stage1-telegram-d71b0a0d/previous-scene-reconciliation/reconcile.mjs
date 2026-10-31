import assert from 'node:assert/strict';
import {readFile,writeFile,cp,lstat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadTelegramTestSettings} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-telegram-profile.mjs';
import {TelegramStore} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/src/main/telegram-store.ts';
import {createTelegramApi} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/src/main/telegram-api.ts';
import {redactTelegramEvidence} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-telegram-inbound.mjs';
import {cleanup} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-live-herdr.mjs';
import {tryAcquireFlock} from '/Users/a1-6/Code/agents/serika-chat-run-target/packages/assistant/dist/flock.js';
import {HerdrClient} from '/Users/a1-6/Code/agents/serika-chat-run-target/packages/assistant/dist/herdr.js';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target',output='/private/tmp/s197-tg-reconcile-01nov-a',root='/private/tmp/s197-tg',retained='/private/tmp/s197-tg-failed-4ebdd9b2';
const prior=JSON.parse(await readFile(join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-4ebdd9b2/operator-stop-audit.json')));
const original=JSON.parse(await readFile(join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-4ebdd9b2/result.json')));
const statePath=join(root,'herdr-fixture/herdr-state.json'),state=JSON.parse(await readFile(statePath));
assert.equal(state.unknown,false);assert.equal(state.phase,'ready');assert.equal(state.root,join(root,'herdr-fixture'));
const report={auditId:randomUUID(),startedAt:new Date().toISOString(),purpose:'explicitly-approved-test-only-handoff-and-scene-archive',oldBatchId:original.batchId,root,retained,status:'failed',realModelCalls:0,costUsd:0,ignoredSockets:[]};
let lease,api,settings;
const save=()=>writeFile(join(output,'result.json'),JSON.stringify(redactTelegramEvidence(report,settings?[settings.credentials.key,settings.credentials.telegram,settings.credentials.proxy]:[]),null,2)+'\n');
try{
 settings=await loadTelegramTestSettings({envFile:'/Users/a1-6/.config/serika/chat-run-target-telegram-test.env',forbiddenBotId:8797046945});assert.equal(settings.runtimeRoot,root);
 lease=await tryAcquireFlock(join(settings.profileRoot,'harness.lock'));assert.ok(lease,'Another test host owns the profile');
 const store=new TelegramStore(join(settings.applicationHome,'resident/telegram.json'),settings.applicationHome);await store.load();const before=store.snapshot();
 assert.equal(before.enabled,false);assert.deepEqual(before.owner,prior.storeAfter.owner);assert.deepEqual(before.inputs,prior.storeAfter.inputs);assert.deepEqual(before.deliveries,prior.storeAfter.deliveries);
 assert.ok(before.inputs.every(x=>x.runId===null&&x.state==='rejected'));assert.ok(before.deliveries.every(x=>x.state==='submitted'));
 report.storeBefore=before;
 await cp(root,join(output,'scene-before-close'),{recursive:true,dereference:false,verbatimSymlinks:true,filter:async path=>{const stat=await lstat(path);if(stat.isSocket()){report.ignoredSockets.push(path);return false;}return true;}});
 report.sceneSnapshotSaved=true;await save();
 const offset=Math.max(before.offset,...original.inboundChecks.map(x=>x.update.update_id+1));report.ack={offset,dispatchingAt:new Date().toISOString()};await save();
 api=createTelegramApi(settings.credentials.telegram,fetch,settings.credentials.proxy?{proxyUrl:settings.credentials.proxy}:{});
 const identity=await api.identity(new AbortController().signal);assert.equal(identity.id,settings.botId);report.botIdentityMatches=true;
 const updates=await api.updates(offset,new AbortController().signal);report.ack={...report.ack,returnedAt:new Date().toISOString(),responseIsArray:Array.isArray(updates),returnedUpdates:updates};await save();
 assert.ok(Array.isArray(updates)&&updates.length===0,'New/unexpected test messages returned; stop without forwarding or discarding them');
 report.ack.confirmed=true;
 await store.update(data=>{assert.deepEqual(data.owner,before.owner);assert.equal(data.enabled,false);data.offset=Math.max(data.offset,offset);});report.storeAfter=store.snapshot();
 await api.close();api=undefined;
 const env={HOME:state.home,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',XDG_CONFIG_HOME:join(state.home,'.config'),LANG:'en_US.UTF-8'};
 const client=new HerdrClient({env,cwd:state.work,authorizedDirectory:state.work});report.targetChecks=[];
 for(const target of state.targets){const observation=await client.execute(target,{action:'get'});report.targetChecks.push({target,observation});await save();assert.ok(observation.ok&&observation.value.status==='idle','Old target is not confirmed idle; no cleanup');}
 report.cleanup=await cleanup(statePath);assert.equal(report.cleanup.phase,'cleaned');
 await rename(root,retained);report.retainedDirectoryRenamed=true;
 assert.equal(createHash('sha256').update(await readFile(join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-4ebdd9b2/result.json'))).digest('hex'),prior.originalResultSha256);
 report.originalEvidenceUnchanged=true;report.status='passed';
}catch(error){report.failure={name:error.name,message:error instanceof assert.AssertionError?error.message:'Reconciliation failed; private details withheld'};process.exitCode=1;}
finally{if(api)await api.close();if(lease){await lease.release();report.profileLeaseReleased=true;}report.finishedAt=new Date().toISOString();await save();}
console.log(JSON.stringify({status:report.status,failure:report.failure,ackConfirmed:report.ack?.confirmed,oldTargets:report.targetChecks?.map(x=>x.observation.ok?x.observation.value.status:'error'),retained:report.retainedDirectoryRenamed?retained:root,realModelCalls:0,output}));
