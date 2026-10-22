import { ContextCompactor } from '@serika/assistant/internal/context-compactor.js';
import { effectiveCompactionFidelitySpec, compactionFidelityHistory } from './compaction-fidelity.mjs';
const item = text => ({ text, evidenceMessageIds: ['fidelity-contract'] });
for (const id of ['CE03', 'CE05']) {
  const spec = effectiveCompactionFidelitySpec(id);
  const store = { messages: [], records: [], async getMessages(){return structuredClone(this.messages)}, async getContextCompactions(){return structuredClone(this.records)}, async appendContextCompaction(record){this.records.push(structuredClone(record))} };
  let calls = 0;
  const compactor = new ContextCompactor({ store, threadId:'eval', modelId:'offline', budget:spec.contextBudget, fixedContext:()=>({instructions:'Maintain original constraints.',tools:[]}),
    summarizer:{complete:async()=>{calls++;return{text:JSON.stringify({version:2,goal:item('完成验收报告'),constraints:[item('部署尚未获批准，旧读取回执不授予新的读取权限'),item('部署尚未获批准，旧读取回执不授予新的读取权限'.repeat(20))],decisions:[{...item('采用本地文件方案'),source:'user',status:'confirmed'}],pending:[item('补充失败样本')],actions:[],files:[],nextStep:null,farIndex:'Old file details\n'.repeat(208)})}}} });
  for(let generation=0;generation<spec.rounds;generation++){
    store.messages.push(...compactionFidelityHistory(spec,generation).messages,{id:`${id}-probe-${generation}`,role:'user',parts:[{type:'text',text:spec.turns[generation]}]});
    const first = await compactor.prepare(store.messages,AbortSignal.timeout(30000));
    while(compactor.pending)await compactor.runPending(AbortSignal.timeout(30000));
    const after=await compactor.prepare(store.messages,AbortSignal.timeout(30000));
    console.log(JSON.stringify({id,generation,calls,error:compactor.backgroundError??null,readBefore:JSON.stringify(first).includes('fidelity-read'),readAfter:JSON.stringify(after).includes('fidelity-read'),records:store.records.length,realModelCalls:0}));
  }
}
