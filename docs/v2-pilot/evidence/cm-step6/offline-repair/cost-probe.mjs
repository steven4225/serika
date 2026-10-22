import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo = process.argv[2];
const { ContextCompactor } = await import(pathToFileURL(repo + '/packages/assistant/dist/context-compactor.js'));
const { compactionFidelitySpec, effectiveCompactionFidelitySpec, compactionFidelityHistory } = await import(pathToFileURL(repo + '/examples/eval/compaction-fidelity.mjs'));
const frozen = JSON.parse(await readFile(repo + '/docs/v2-pilot/evidence/cm-step6/live-d67682ad-0722-43d9-af5c-8c7aef1308fa.json'));
const item = text => ({ text, evidenceMessageIds: ['fidelity-contract'] });
const summary = { version: 2, goal: item('完成验收报告'), constraints: [item('部署尚未获批准，旧读取回执不授予新的读取权限')], decisions: [{ ...item('采用本地文件方案'), source: 'user', status: 'confirmed' }], pending: [item('补充失败样本')], actions: [], files: [], nextStep: null, farIndex: '完成验收报告；本地文件方案；补充失败样本；部署尚未获批准' };
const results = [];
for (const id of ['CF03', 'CF05', 'CE03', 'CE05']) {
 const spec = id.startsWith('CE') ? effectiveCompactionFidelitySpec(id) : compactionFidelitySpec(id);
 const store = { messages: [], records: [], async getMessages(){return structuredClone(this.messages)}, async getContextCompactions(){return structuredClone(this.records)}, async appendContextCompaction(record){this.records.push(structuredClone(record))} };
 let calls = 0;
 const open = () => new ContextCompactor({ store, threadId: 'eval', modelId: 'offline-cost-probe', budget: spec.contextBudget, fixedContext:()=>({instructions:'Maintain original constraints.', tools:[]}), summarizer:{complete:async()=>{calls++;return{text:JSON.stringify(summary)}}} });
 const rounds=[];
 for (let generation=0; generation<spec.rounds; generation++) {
   store.messages.push(...compactionFidelityHistory(spec,generation).messages, {id:`${id}-probe-${generation}`,role:'user',parts:[{type:'text',text:spec.turns[generation]}]});
   let c=open(), before=calls; await c.prepare(store.messages,AbortSignal.timeout(30000));
   while(c.pending) await c.runPending(AbortSignal.timeout(30000));
   if(c.backgroundError) throw new Error(c.backgroundError);
   const directBackgroundCalls=calls-before;
   store.messages.push({id:`question-${generation}`,role:'user',parts:[{type:'text',text:spec.turns[generation]}]}, {id:`reply-${generation}`,role:'assistant',parts:[{type:'text',text:'完成验收报告，采用本地文件方案，补充失败样本。部署尚未获批准。读取已成功，但需要新的批准；写入结果 unknown，不能自动重试。'}]});
   c=open(); before=calls; await c.prepare(store.messages,AbortSignal.timeout(30000));
   while(c.pending) await c.runPending(AbortSignal.timeout(30000));
   if(c.backgroundError) throw new Error(c.backgroundError);
   rounds.push({generation,directBackgroundCalls,estimatedChatBackgroundCalls:calls-before,primaryCalls:1});
 }
 const old=frozen.calls.filter(call=>call.scope.startsWith(id+'/'));
 const directOld=old.filter(call=>call.scope.includes('/background/'));
 const chatOld=old.filter(call=>call.scope.includes('/chat/'));
 const primaryOld=chatOld.filter(call=>call.maxOutputTokens===4096);
 const chatBackgroundOld=chatOld.filter(call=>call.maxOutputTokens!==4096);
 const average = rows => rows.reduce((s,c)=>s+c.costUsd,0)/rows.length;
 const directNew=rounds.reduce((s,r)=>s+r.directBackgroundCalls,0);
 const chatNew=rounds.reduce((s,r)=>s+1+r.estimatedChatBackgroundCalls,0);
 results.push({id,rounds,oldCalls:old.length,estimatedCalls:directNew+chatNew,
   oldDirectBackgroundCalls:directOld.length,estimatedDirectBackgroundCalls:directNew,
   oldChatCalls:chatOld.length,estimatedChatCalls:chatNew,
   meanBasedUsd:directNew*average(directOld)+spec.rounds*average(primaryOld)+(chatNew-spec.rounds)*average(chatBackgroundOld),
   extraChatBackgroundStressCalls:spec.rounds,extraChatBackgroundStressUsd:spec.rounds*Math.max(...chatBackgroundOld.map(c=>c.costUsd)),
   maxObservedCallBasedUsd:directNew*Math.max(...directOld.map(c=>c.costUsd))+chatNew*Math.max(...chatOld.map(c=>c.costUsd))});
}
const remaining=2.5-frozen.priorChargedUsd-frozen.costUsd;
const fixed=frozen.calls.filter(call=>['m1','cold'].includes(call.scope));
const report={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourceSha256:createHash('sha256').update(await readFile(repo + '/docs/v2-pilot/evidence/cm-step6/live-d67682ad-0722-43d9-af5c-8c7aef1308fa.json')).digest('hex'),probeId:randomUUID(),generatedAt:new Date().toISOString(),realModelCalls:0,costUsd:0,
 model:'deterministic fixture summary and synthetic chat append, not model acceptance',results,
 oldTotalCalls:frozen.calls.length,estimatedTotalCalls:results.reduce((s,r)=>s+r.estimatedCalls,0)+fixed.length,
 fixedHistoricalCallCount:fixed.length, fixedHistoricalUsd:fixed.reduce((s,c)=>s+c.costUsd,0),
 estimatedUsd:results.reduce((s,r)=>s+r.meanBasedUsd,0)+fixed.reduce((s,c)=>s+c.costUsd,0),
 maxObservedCallBasedUsd:results.reduce((s,r)=>s+r.maxObservedCallBasedUsd,0)+fixed.reduce((s,c)=>s+c.costUsd,0),
 stressTotalCalls:results.reduce((s,r)=>s+r.estimatedCalls+r.extraChatBackgroundStressCalls,0)+fixed.length,
 maxObservedPlusOneExtraChatBackgroundPerRoundUsd:results.reduce((s,r)=>s+r.maxObservedCallBasedUsd+r.extraChatBackgroundStressUsd,0)+fixed.reduce((s,c)=>s+c.costUsd,0),
 remainingUsd:remaining, limitations:['Counts depend on successful short fixture summaries; actual model invalid output or larger required content changes queues.','M1 and cold call counts/costs copied from the frozen batch, not a forecast of successful cold reuse.','Uses the frozen batch price quote and token usage; it is not a provider price refresh.','Max observed call scenario is a sensitivity calculation, not a guaranteed upper bound.','Runtime pre-dispatch reservation remains authoritative; no retry and stop at cumulative $2.50.']};
await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
