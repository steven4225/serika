import assert from 'node:assert/strict';
import {readFile,writeFile,cp,lstat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadTelegramTestSettings,inspectTelegramTestStore} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-telegram-profile.mjs';
import {TelegramStore} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/src/main/telegram-store.ts';
import {createTelegramApi} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/src/main/telegram-api.ts';
import {redactTelegramEvidence} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-telegram-inbound.mjs';
import {cleanup} from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-live-herdr.mjs';
import {tryAcquireFlock} from '/Users/a1-6/Code/agents/serika-chat-run-target/packages/assistant/dist/flock.js';
import {HerdrClient} from '/Users/a1-6/Code/agents/serika-chat-run-target/packages/assistant/dist/herdr.js';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target',output='/private/tmp/s197-tg-authorized-01nov-c/reconciliation-3',root='/private/tmp/s197-tg',retained='/private/tmp/s197-tg-failed-d71b0a0d';
const oldPath=join(repo,'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-d71b0a0d/result.json');
const oldBytes=await readFile(oldPath),original=JSON.parse(oldBytes),sha=value=>createHash('sha256').update(value).digest('hex');
const statePath=join(root,'herdr-fixture/herdr-state.json'),state=JSON.parse(await readFile(statePath));
const report={auditId:randomUUID(),startedAt:new Date().toISOString(),purpose:'authorized-next-batch-test-only-handoff-without-replay',oldBatchId:original.batchId,oldResultSha256:sha(oldBytes),root,retained,status:'failed',realModelCalls:0,costUsd:0,ignoredSockets:[]};
let lease,api,settings;
const save=()=>writeFile(join(output,'result.json'),JSON.stringify(redactTelegramEvidence(report,settings?[settings.credentials.key,settings.credentials.telegram,settings.credentials.proxy]:[]),null,2)+'\n');
try{
 assert.equal(original.status,'failed');assert.equal(original.unknownEffect,undefined);assert.equal(original.unresolvedReservedUsd,0);
 assert.ok(original.calls.every(call=>call.status==='returned'));
 const receipt=original.cases[0].receiptAfterShutdown;assert.equal(receipt.status,'cancelled');assert.ok(receipt.tools.length&&receipt.tools.every(tool=>tool.status==='not_started'));
 assert.equal(state.unknown,false);assert.equal(state.phase,'ready');assert.equal(state.root,join(root,'herdr-fixture'));
 settings=await loadTelegramTestSettings({envFile:'/Users/a1-6/.config/serika/chat-run-target-telegram-test.env',forbiddenBotId:8797046945});assert.equal(settings.runtimeRoot,root);
 lease=await tryAcquireFlock(join(settings.profileRoot,'harness.lock'));assert.ok(lease,'Another test host owns profile');
 const store=new TelegramStore(join(settings.applicationHome,'resident/telegram.json'),settings.applicationHome);await store.load();const before=store.snapshot();
 inspectTelegramTestStore({data:before,settings});
 const prior=JSON.parse(await readFile('/private/tmp/s197-tg-authorized-01nov-c/reconciliation-2/result.json'));
 assert.equal(prior.botIdentityMatches,true);assert.equal(prior.oldCallbackOwnershipVerified,true);assert.equal(prior.oldCallbackForwarded,false);assert.equal(prior.ack.responseIsArray,true);assert.equal(prior.modelCalls,0);assert.ok(prior.ack.returnedAt);
 assert.deepEqual(before.inputs.find(row=>row.runId===receipt.runId),prior.operatorReview);
 assert.deepEqual(before.owner,original.telegramStoreAfterShutdown.owner);assert.equal(before.offset,original.telegramStoreAfterShutdown.offset);report.storeBefore=before;
 report.previousHandoffEvidence='/private/tmp/s197-tg-authorized-01nov-c/reconciliation-2/result.json';
 report.heldForOriginalGateway=prior.ack.returnedUpdates;assert.equal(report.heldForOriginalGateway.length,1);
 const pending=report.heldForOriginalGateway[0];assert.equal(pending.message.from.id,settings.owner.userId);assert.equal(pending.message.chat.id,settings.owner.chatId);
 const oldCode=original.inboundChecks.find(row=>row.update?.callback_query).update.callback_query.data.split(':')[1];assert.equal(pending.message.text,'允许 '+oldCode);assert.ok(pending.update_id>=prior.ack.offset);
 report.pendingControlForwarded=false;report.pendingControlAcknowledged=false;

 const rejected=original.inboundChecks.filter(row=>!row.forwarded);
 assert.equal(rejected.length,1);const callback=rejected[0].update.callback_query;
 assert.ok(callback);assert.equal(callback.from.id,settings.owner.userId);assert.equal(callback.from.is_bot,false);
 assert.equal(callback.message.chat.id,settings.owner.chatId);assert.equal(callback.message.chat.type,'private');assert.equal(callback.message.from.id,settings.botId);assert.equal(callback.message.from.is_bot,true);
 assert.ok(/^allow:[A-F0-9]{10}$/.test(callback.data));
 report.oldCallbackOwnershipVerified=true;report.oldCallbackForwarded=false;
 for(const path of state.piSessions){let text;try{text=await readFile(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;text='';}assert.equal(text.trim().split('\n').filter(Boolean).map(row=>JSON.parse(row)).filter(row=>row.type==='message'&&row.message?.role==='user').length,0);}
 await cp(root,join(output,'scene-before-close'),{recursive:true,dereference:false,verbatimSymlinks:true,filter:async path=>{const stat=await lstat(path);if(stat.isSocket()){report.ignoredSockets.push(path);return false;}return true;}});report.sceneSnapshotSaved=true;await save();
 const offset=prior.ack.offset;assert.equal(offset,Math.max(before.offset,...original.inboundChecks.map(row=>row.update.update_id+1)));
 report.ack={offset,confirmed:true,confirmedAt:prior.ack.returnedAt,confirmationSource:report.previousHandoffEvidence,pendingUpdateIds:prior.ack.returnedUpdates.map(row=>row.update_id)};
 await store.update(data=>{assert.deepEqual(data.owner,before.owner);assert.equal(data.enabled,false);data.offset=offset;});report.storeAfter=store.snapshot();await save();
 const env={HOME:state.home,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',XDG_CONFIG_HOME:join(state.home,'.config'),LANG:'en_US.UTF-8'};
 const client=new HerdrClient({env,cwd:state.work,authorizedDirectory:state.work});report.targetChecks=[];
 for(const target of state.targets){const observation=await client.execute(target,{action:'get'});report.targetChecks.push({target,observation});await save();assert.ok(observation.ok&&['idle','done'].includes(observation.value.status),'Old target not confirmed idle/done; preserve');}
 report.cleanup=await cleanup(statePath);assert.equal(report.cleanup.phase,'cleaned');await rename(root,retained);report.retainedDirectoryRenamed=true;
 assert.equal(sha(await readFile(oldPath)),report.oldResultSha256);report.originalEvidenceUnchanged=true;report.status='passed';
}catch(error){report.failure={name:error.name,message:error instanceof assert.AssertionError?error.message:'Reconciliation failed; private details withheld'};process.exitCode=1;}
finally{if(api)await api.close();if(lease){await lease.release();report.profileLeaseReleased=true;}report.finishedAt=new Date().toISOString();await save();}
console.log(JSON.stringify({status:report.status,failure:report.failure,ackConfirmed:report.ack?.confirmed,oldTargets:report.targetChecks?.map(row=>row.observation.ok?row.observation.value.status:'error'),retained:report.retainedDirectoryRenamed?retained:root,realModelCalls:0,output}));
