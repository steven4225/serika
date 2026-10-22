import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const repo=process.argv[2];
const { ContextCompactor }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-compactor.js'));
const { compactPrefixHash }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-compaction.js'));
const { blockLimits }=await import(pathToFileURL(repo+'/packages/assistant/dist/context-blocks.js'));
const { effectiveCompactionFidelitySpec }=await import(pathToFileURL(repo+'/examples/eval/compaction-fidelity.mjs'));
const budget=effectiveCompactionFidelitySpec('CE05').contextBudget,limits=blockLimits(budget);
const user=(id,text)=>({id,role:'user',parts:[{type:'text',text}]}),assistant=(id,text)=>({...user(id,text),role:'assistant'}),item=text=>({text,evidenceMessageIds:['old']});
const results=[];
for(const size of [500,24000]){
 const messages=[user('old','original'),assistant('old-reply','done'),user('unpublished-request','continue'),assistant('a','a'.repeat(size)),assistant('b','b'.repeat(size)),user('current','next')];
 const record={v:2,type:'thread.context.compacted',threadId:'probe',id:'c5-probe',previousCompactionId:null,firstKeptMessageIndex:2,firstKeptMessageId:messages[2].id,sourcePrefixHash:compactPrefixHash(messages,2),summary:{version:2,goal:item('x'.repeat(5000)),constraints:[item('no deployment')],decisions:[],pending:[],actions:[],files:[],nextStep:null},consolidationExcluded:true,strategyVersion:'summary-json/v2',modelId:'fixture',createdAt:new Date(0).toISOString(),metrics:{estimatedInputBefore:100,estimatedInputAfter:50,durationMs:1,attempts:1}};
 const before=JSON.stringify({messages,record});
 const store={async getMessages(){return structuredClone(messages)},async getContextCompactions(){return [structuredClone(record)]}};
 const compactor=new ContextCompactor({store,threadId:'probe',modelId:'fixture',budget,fixedContext:()=>({instructions:'Maintain original constraints.',tools:[]}),summarizer:{complete:async()=>{throw Error('must not call')}}});
 const view=await compactor.prepare(messages,AbortSignal.timeout(30000)),d=(await compactor.getDiagnostics()).value.lastPreparation;
 if(before!==JSON.stringify({messages,record}))throw Error('Original mutated');
 results.push({fillerCharsPerMessage:size,retainedUnpublishedOriginalIds:view.filter(m=>['unpublished-request','a','b'].includes(m.id)).map(m=>m.id),retainedCurrent:!!view.find(m=>m.id==='current'),summaryLayer:d.summaryLayer,degradation:d.degradation,estimatedInputTokens:d.estimatedInputTokens,originalUnchanged:true});
}
const result={probeId:randomUUID(),generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),kind:'offline_current_behavior_observation_not_authorization',budget,limits,emergencyThreshold:Math.floor(budget.inputBudgetTokens*.85),borrowCap:Math.floor(limits.recent/2),nominalEqualExchangeRemainder:limits.recent-Math.floor(limits.recent/2),actualMinimumOldOriginalGuarantee:0,realModelCalls:0,costUsd:0,results};
await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({probeId:result.probeId,results}));
