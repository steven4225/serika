import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const repo='/Users/a1-6/Code/agents/serika-foreground-capability-wiring';
const require=createRequire(join(repo,'packages/assistant/package.json'));
const {simulateReadableStream}=await import(pathToFileURL(require.resolve('ai')));
const {MockLanguageModelV3}=await import(pathToFileURL(require.resolve('ai/test')));
const {createRuntimeApp}=await import(pathToFileURL(join(repo,'packages/assistant/dist/app.js')));
const {createAssistantController}=await import(pathToFileURL(join(repo,'packages/assistant/dist/assistant-controller.js')));
const evidence=process.argv[2]; assert.ok(evidence?.startsWith('/private/tmp/'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const report={runId:randomUUID(),startedAt:new Date().toISOString(),verification:'scripted-model-and-summary-real-runtime-controller-shell-file-tools-storage',realModelCalls:0,costUsd:0,platform:process.platform,cases:[],status:'running'};
const save=()=>writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n');
const usage={inputTokens:{total:1,noCache:1,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:1,text:1,reasoning:undefined}};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function response(tool,text='done') {
 return {stream:simulateReadableStream({chunks:[{type:'stream-start',warnings:[]},...(tool?[{type:'tool-call',toolCallId:tool.id,toolName:tool.name,input:JSON.stringify(tool.input)}]:[{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:text},{type:'text-end',id:'text'}]),{type:'finish',finishReason:{unified:tool?'tool-calls':'stop',raw:undefined},usage}]})};
}
async function probe(windowTokens) {
 const root=await mkdtemp(join(evidence,`window-${windowTokens}-`)),workspace=join(root,'workspace'); await mkdir(workspace);
 const marker='CLI_OBSERVED_'+randomUUID().replaceAll('-',''),artifact='ARTIFACT_'+randomUUID().replaceAll('-','');
 const goal=`保留原要求 ${marker}：执行一次已批准的Shell检查并创建artifact.txt，读取一次bulk.txt，最后读取artifact.txt核对；不重复前面的工具。`;
 await writeFile(join(workspace,'bulk.txt'),'BULK_START\n'+'b'.repeat(60000)+'\nBULK_END\n');
 const configPath=join(root,'config.json');
 const contextCompaction=windowTokens===32768?{enabled:true,contextWindowTokens:32768,maxOutputTokens:4096,safetyMarginTokens:2048,keepRecentTokens:8192,summaryMaxOutputTokens:2048}:{enabled:true,contextWindowTokens:1000000,maxOutputTokens:4096,safetyMarginTokens:32768,inputBudgetTokens:256000,keepRecentTokens:48000,summaryMaxOutputTokens:6000,triggerRatio:.85,summaryInputChunkTokens:32000};
 await writeFile(configPath,JSON.stringify({version:2,projectDirectory:workspace,authorizedDirectories:[{path:workspace,access:'readwrite'}],modules:{'read-file':{enabled:true},shell:{enabled:true},terminal:{enabled:false},memory:{enabled:false}},run:{maxSteps:8,totalTimeoutMs:120000},contextCompaction,modelContextWindows:[{provider:'mock-provider',modelId:'mock-model-id',contextWindowTokens:windowTokens}]}));
 const row={windowTokens,root,goal,marker,artifact,steps:[],approvals:[],errors:[],summaryCalls:0,phase:'primary',status:'running'}; report.cases.push(row); await save();
 let primaryCalls=0,nextCalls=0,app,controller,primaryRunId;
 const model=new MockLanguageModelV3({doGenerate:async()=>{throw new Error('unexpected doGenerate');},doStream:async options=>{
  const systems=JSON.stringify(options.prompt.filter(m=>m.role==='system'));
  if(systems.includes('You are a context compactor.')) {
   row.summaryCalls++;
   const messages=await app.store.getMessages('probe'); const ids=messages.map(m=>m.id);
   assert.ok(ids.length);
   return response(undefined,JSON.stringify({version:2,goal:{text:goal,evidenceMessageIds:[ids[0]]},constraints:[],decisions:[],actions:[],pending:[],files:[],nextStep:null}));
  }
  const prompt=JSON.stringify(options.prompt),index=row.phase==='primary'?primaryCalls++:nextCalls++;
  const diagnostics=await app.getContextDiagnostics(); assert.ok(diagnostics.ok);
  const file=`prompt-${row.phase}-${index}.json`; await writeFile(join(root,file),JSON.stringify(options.prompt,null,2));
  row.steps.push({phase:row.phase,index,promptFile:file,promptSha256:sha(prompt),promptBytes:Buffer.byteLength(prompt),diagnostics:diagnostics.value.lastPreparation});
  if(row.phase==='next') return index===0?response({id:'next-read',name:'read_file',input:{path:'artifact.txt'}}):response(undefined,'next read complete');
  assert.ok(prompt.includes(marker),'original goal marker lost');
  if(index===0) {
   const code=`const fs=require('node:fs');fs.writeFileSync('artifact.txt',${JSON.stringify(artifact+'\n')});console.log(${JSON.stringify(marker)});console.log('f'.repeat(60000));`;
   return response({id:'shell-check',name:'shell_exec',input:{command:quote(process.execPath)+' -e '+quote(code)}});
  }
  if(index===1) {
   assert.ok(prompt.includes(marker),'real Shell output lost before next operation');
   return response({id:'bulk-read',name:'read_file',input:{path:'bulk.txt'}});
  }
  if(index===2) {
   if(windowTokens===32768) {
    assert.match(prompt,/Host checklist/,'must exercise host checklist after masking');
    assert.match(prompt,/masked pending background/,'must exercise production masking');
    assert.match(prompt,/shell-check/,'completed Shell receipt disappeared');
    assert.ok(diagnostics.value.lastPreparation?.degradation?.emergencyMasking?.length,'masking evidence missing');
    row.afterMask={requestVisible:prompt.includes(goal),shellMarkerVisible:prompt.includes(marker),checklistVisible:true,masked:true};
    // The host checklist output excerpt must contain the actual Shell marker, independently of the goal copy.
    const checklist=options.prompt.filter(m=>m.role==='assistant').flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(p=>p.type==='text').map(p=>p.text)).find(t=>t.includes('Host checklist:'));
    assert.ok(checklist?.includes(marker),'Shell output marker not retained in host checklist');
   } else { row.afterMask={requestVisible:prompt.includes(goal),shellMarkerVisible:prompt.includes(marker),masked:!!diagnostics.value.lastPreparation?.degradation?.emergencyMasking?.length}; }
   return response({id:'artifact-read',name:'read_file',input:{path:'artifact.txt'}});
  }
  assert.equal(index,3); assert.ok(prompt.includes(artifact),'actual artifact read result missing');
  return response(undefined,'核对完成 '+artifact);
 }});
 const output=new PassThrough();output.resume();
 app=await createRuntimeApp({cwd:root,env:{},directory:join(root,'transcripts'),output,assistant:{configPath,threadId:'probe',dataDirectory:join(workspace,'.runloom')},modelAlias:'scripted',model});
 controller=createAssistantController(app);
 controller.subscribe(event=>{
  if(event.type==='error')row.errors.push(event.message);
  if(event.type==='approval'&&event.approval.preview) {
   row.approvals.push({phase:row.phase,tool:event.approval.toolName,id:event.approval.approvalId,remember:false});
   assert.equal(controller.confirm({approvalId:event.approval.approvalId,decision:'allow'}),true);
  }
 });
 const run=async text=>{
  let off;const done=new Promise((resolveDone,reject)=>{const timer=setTimeout(()=>reject(new Error('probe Run timeout')),30000);off=controller.subscribe(event=>{if(event.type==='state'&&event.state.kind==='idle'){clearTimeout(timer);off();resolveDone();}});});
  const start=await controller.run(text,{desktopEntry:true}); assert.ok(start.ok); await done;
  assert.equal(controller.getSnapshot().lastPrimaryResult?.status,'completed',JSON.stringify(controller.getSnapshot().lastPrimaryResult));return start.runId;
 };
 try {
  assert.equal(app.desktopAutonomyEnabled,false);
  app.toolConfirmation.setPendingAuthorization({tools:['read_file'],allowedPaths:['.'],lifetime:'run'});
  primaryRunId=await run(goal);row.primaryRunId=primaryRunId;
  assert.equal(primaryCalls,4);
  const runReceipt=await controller.runs.get(primaryRunId);row.primaryReceipt=runReceipt;
  assert.deepEqual(runReceipt.tools.map(t=>[t.toolName,t.status]),[['shell_exec','completed'],['read_file','completed'],['read_file','completed']]);
  assert.equal(runReceipt.tools[0].shell.exitCode,0);assert.match(runReceipt.tools[0].resultPreview,new RegExp(marker));
  assert.deepEqual(row.approvals.map(x=>x.tool),['shell_exec'],'current-Run file grant should cover only this Run');
  const transcript=await app.store.getMessages('probe');const request=transcript.find(m=>m.role==='user');
  assert.ok(JSON.stringify(request.metadata).includes('runloom-foreground-task'));
  assert.equal(await readFile(join(workspace,'artifact.txt'),'utf8'),artifact+'\n');
  row.artifactSha256=sha(await readFile(join(workspace,'artifact.txt')));
  // Wait for actual production background summary settlement after primary idle.
  for(let i=0;i<200;i++){const d=await app.getContextDiagnostics();assert.ok(d.ok);if(!d.value.background?.queued&&!d.value.background?.running)break;await delay(25);}
  row.diagnosticsAfterIdle=await app.getContextDiagnostics();
  assert.ok(row.diagnosticsAfterIdle.ok);assert.equal(row.diagnosticsAfterIdle.value.background?.error,null);
  row.compactionRecords=await app.store.getContextCompactions('probe');
  if(windowTokens===32768)assert.ok(row.compactionRecords.length>0,'production compaction must persist');
  const before=await app.executionRecords.listRuns('probe'); assert.equal(before.length,1,'same primary task must have one Run');
  row.phase='next';row.nextRunId=await run('新的请求：只读取当前artifact.txt，不继承上一轮权限。');
  assert.notEqual(row.nextRunId,primaryRunId);assert.equal(nextCalls,2);
  assert.deepEqual(row.approvals.map(x=>x.tool),['shell_exec','read_file'],'old file authorization must expire');
  const next=(await app.store.getMessages('probe')).filter(m=>m.role==='user').at(-1);assert.ok(!JSON.stringify(next.metadata).includes(marker),'old task anchor revived');
  assert.equal(app.getCapabilities().execution.shell.authorization,'per_call_confirmation');
  assert.deepEqual(row.errors,[]);
  row.status='passed';row.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({windowTokens,status:'passed',primaryRunId,primaryCalls,nextCalls,summaryCalls:row.summaryCalls,compactionRecords:row.compactionRecords.length,masked:row.afterMask.masked,approvals:row.approvals.map(x=>x.tool),realModelCalls:0}));
 } finally {await controller.shutdown();app.dispose();}
}
try {await save();await probe(32768);await probe(1000000);report.status='passed';}
catch(error){report.status='failed';report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;console.error(JSON.stringify({status:'failed',failure:report.failure}));}
finally {report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,runId:report.runId,result:join(evidence,'result.json')}));}
