import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo=path.resolve(process.argv[2]);
const output=process.argv[3];
if (!output) throw Error('Usage: node floor-probe.mjs <repo> <output.json>');
const { ContextCompactor }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-compactor.js'));
const { compactPrefixHash }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-compaction.js'));
const { blockLimits }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-blocks.js'));
const { defaultContextBudget, estimateMessageTokens }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-budget.js'));
const { effectiveCompactionFidelitySpec }=await import(pathToFileURL(repo+'/examples/eval/compaction-fidelity.mjs'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>sha(JSON.stringify(value));
const user=(id,text)=>({id,role:'user',parts:[{type:'text',text}]}),assistant=(id,text)=>({...user(id,text),role:'assistant'}),item=text=>({text,evidenceMessageIds:['old']});
const results=[];
for(const mode of ['32k','daily']) for(const scenario of ['zero-recent-split-tools','oversized-floor','provider-overflow']) {
 const budget=mode==='32k'?effectiveCompactionFidelitySpec('CE05').contextBudget:defaultContextBudget(), limits=blockLimits(budget);
 const huge=scenario==='oversized-floor', overflow=scenario==='provider-overflow';
 const fillerCount=mode==='32k'?2:20;
 const fillerSize=overflow?500:mode==='32k'?24000:50000;
 const call={id:'latest-call',role:'assistant',parts:[{type:'dynamic-tool',toolName:'read_file',toolCallId:'latest-read',state:'input-available',input:{path:'notes/fixture.txt'}}]};
 const result={id:'latest-result',role:'assistant',parts:[{type:'dynamic-tool',toolName:'read_file',toolCallId:'latest-read',state:'output-available',input:{path:'notes/fixture.txt'},output:{ok:true,text:huge?'BEGIN RESULT '+ 'R'.repeat(budget.inputBudgetTokens*3)+' END RESULT':'read succeeded; exact fixture body'}}]};
 const request=user('current-request','Q'.repeat(budget.inputBudgetTokens*2));
 const steer={...user('current-steer','S'.repeat(budget.inputBudgetTokens*2)),metadata:{source:'steer'}};
 const messages=[user('old','original'),assistant('old-reply','done'),user('unpublished-request','continue'),...Array.from({length:fillerCount},(_,i)=>assistant(`unpublished-filler-${i}`,'x'.repeat(fillerSize))),call,result,request,steer];
 const record={v:2,type:'thread.context.compacted',threadId:'probe',id:'c5-probe',previousCompactionId:null,firstKeptMessageIndex:2,firstKeptMessageId:messages[2].id,sourcePrefixHash:compactPrefixHash(messages,2),summary:{version:2,goal:item('x'.repeat(limits.totalSummary*2+1000)),constraints:[item('no deployment')],decisions:[],pending:[],actions:[],files:[],nextStep:null},consolidationExcluded:true,strategyVersion:'summary-json/v2',modelId:'fixture',createdAt:new Date(0).toISOString(),metrics:{estimatedInputBefore:100,estimatedInputAfter:50,durationMs:1,attempts:1}};
 const before=hash({messages,record}); let calls=0;
 const store={async getMessages(){return structuredClone(messages)},async getContextCompactions(){return [structuredClone(record)]}};
 const compactor=new ContextCompactor({store,threadId:'probe',modelId:'fixture',budget,fixedContext:()=>({instructions:'Maintain original constraints.',tools:[]}),summarizer:{complete:async()=>{calls++;throw Error('must not call')}}});
 let view=[],error=null;
 try {
  if(overflow){ await compactor.prepare(messages,AbortSignal.timeout(30000)); const first=(await compactor.getDiagnostics()).value.lastPreparation; compactor.reportedOverflow(first.estimatedInputTokens); }
  view=await compactor.prepare(messages,AbortSignal.timeout(30000));
 } catch(e) { error={name:e.name,message:e.message}; }
 const d=(await compactor.getDiagnostics()).value.lastPreparation;
 const floor=[call,result,request,steer];
 const retainedFloorIds=floor.filter(m=>view.some(v=>v.id===m.id)).map(m=>m.id);
 const exactFloorIds=floor.filter(m=>view.some(v=>v.id===m.id && JSON.stringify(v)===JSON.stringify(m))).map(m=>m.id);
 const clippedFloorIds=floor.filter(m=>view.some(v=>v.id===m.id && JSON.stringify(v)!==JSON.stringify(m))).map(m=>m.id);
 const resultProjection=view.find(m=>m.id===result.id);
 results.push({mode,scenario,budget,limits,inputHashBefore:before,inputHashAfter:hash({messages,record}),originalUnchanged:before===hash({messages,record}),originalMessageHashes:Object.fromEntries(messages.map(m=>[m.id,hash(m)])),originalFloorTokens:estimateMessageTokens(floor),retainedUnpublishedTextIds:view.filter(m=>m.id==='unpublished-request'||m.id.startsWith('unpublished-filler-')).map(m=>m.id),retainedFloorIds,exactFloorIds,clippedFloorIds,resultHasNumberedPlaceholder:!!resultProjection && JSON.stringify(resultProjection).includes('Message latest-result truncated for context'),withinInputWindow:!!d&&d.estimatedInputTokens<=budget.inputBudgetTokens,estimatedInputTokens:d?.estimatedInputTokens,summaryLayer:d?.summaryLayer,degradation:d?.degradation,error,realModelCalls:calls,costUsd:0});
 await compactor.close();
}
const sourcePaths=['packages/assistant/src/context-compactor.ts','packages/assistant/src/context-blocks.ts','packages/assistant/src/context-diagnostics.ts'];
const evidence={probeId:randomUUID(),generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),sourceHashes:Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,sha(await readFile(path.join(repo,p)))]))),kind:'offline_emergency_floor_regression_probe',realModelCalls:results.reduce((n,r)=>n+r.realModelCalls,0),costUsd:0,results};
await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({probeId:evidence.probeId,sourceCommit:evidence.sourceCommit,results:results.map(({mode,scenario,retainedFloorIds,exactFloorIds,clippedFloorIds,resultHasNumberedPlaceholder,withinInputWindow,retainedUnpublishedTextIds,degradation,error})=>({mode,scenario,retainedFloorIds,exactFloorIds,clippedFloorIds,resultHasNumberedPlaceholder,withinInputWindow,retainedUnpublishedTextIds,emergencyMasking:degradation?.emergencyMasking,error}))},null,2));
