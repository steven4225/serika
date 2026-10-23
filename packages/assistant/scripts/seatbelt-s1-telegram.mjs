import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {simulateReadableStream} from 'ai';
import {MockLanguageModelV3} from 'ai/test';
import {createRuntimeApp} from '../dist/app.js';
import {createAssistantController} from '../dist/assistant-controller.js';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];assert.ok(args.includes('--home')&&args.includes('--output'));
const home=resolve(arg('--home')),root=dirname(home),directory=join(root,'A'),outside=join(root,'B'),output=resolve(arg('--output'));
assert.ok(home.startsWith('/private/tmp/serika-s1-'));const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));assert.ok(!output.startsWith(repo+'/'));
for(const path of [home,directory,outside,output]) await mkdir(path,{mode:0o700});
const sha=data=>createHash('sha256').update(data).digest('hex'),git=(...args)=>spawnSync('git',args,{cwd:repo,encoding:'utf8'}).stdout.trim();
const report={runId:randomUUID(),sourceCommit:git('rev-parse','HEAD'),sourceWorktreeDirty:!!git('status','--porcelain'),scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),
 verification:'real-Mac-Controller-with-validated-test-Telegram-binding-no-transport',realModelCalls:0,telegramOutbound:0,status:'failed',approvals:[],events:[]};
const configPath=join(home,'config.json');await writeFile(configPath,JSON.stringify({version:1,authorizedDirectory:directory,desktopAutonomy:{authorizedDirectory:directory},
 telegramAutonomy:{authorizedDirectory:directory,botId:1,userId:2,chatId:3,threadId:'s1-telegram'},modules:{shell:{enabled:true}}}),{mode:0o600});
let step=0;
const model=new MockLanguageModelV3({doStream:async({prompt})=>{report.hostConfirmationInstructions=JSON.stringify(prompt).includes('The command and workspace-relative cwd will be shown for y/n confirmation.');
 const index=step++;return {stream:simulateReadableStream({chunks:[{type:'stream-start',warnings:[]},...(index<2?[{type:'tool-call',toolCallId:'shell-'+index,toolName:'shell_exec',input:JSON.stringify({command:`printf call-${index} > ../B/call-${index}.txt`})}]:[]),
 {type:'finish',finishReason:{unified:index<2?'tool-calls':'stop',raw:undefined},usage:{inputTokens:{total:1,noCache:1,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:1,text:1,reasoning:undefined}}}]})};}});
const app=await createRuntimeApp({directory:join(home,'transcripts'),assistant:{dataDirectory:join(home,'data'),threadId:'s1-telegram',configPath},cwd:root,env:{},modelAlias:'mock',model,output:new PassThrough(),
 desktopAutonomyHost:{home},authorizeTelegramAutonomy:grant=>grant.botId===1&&grant.userId===2&&grant.chatId===3&&grant.threadId==='s1-telegram'});
const controller=createAssistantController(app),rl=args.includes('--interactive')?createInterface({input:process.stdin,output:process.stdout}):undefined;
const idle=new Promise(done=>{const remove=controller.subscribe(event=>{if(event.type==='state'&&event.state.kind==='idle'){remove();done();}});});
let approvalError;
const unsubscribe=controller.subscribe(event=>{
 if(event.type==='run-event'&&['tool.call.completed','tool.call.failed'].includes(event.event.type)) report.events.push(event.event);
 if(event.type!=='approval'||!event.approval.preview)return;
 void (async()=>{const pending=event.approval,index=report.approvals.length;await assert.rejects(access(join(outside,`call-${index}.txt`)),{code:'ENOENT'});
 assert.equal(pending.toolName,'shell_exec');assert.equal(pending.remember,undefined);
 const answer=rl?await rl.question(`TG host 第 ${index+1}/2 次确认\n${pending.preview}\n输入 y 允许，其他输入拒绝：`):'y';const decision=answer==='y'?'allow':'deny';
 report.approvals.push({tool:pending.toolName,preview:pending.preview,decision,remember:null,markerAbsentBeforeApproval:true});
 controller.confirm({approvalId:pending.approvalId,decision});
 })().catch(async error=>{approvalError=error;await controller.cancel();});
});
try {
 const start=await controller.run('离线 TG 两条 Shell 逐次确认检查',{source:'telegram'});assert.equal(start.ok,true);await idle;if(approvalError)throw approvalError;
 assert.equal(report.approvals.length,2);assert.equal(report.hostConfirmationInstructions,true);
 for(let i=0;i<2;i++) {if(report.approvals[i].decision==='allow')assert.equal(await readFile(join(outside,`call-${i}.txt`),'utf8'),`call-${i}`);else await assert.rejects(access(join(outside,`call-${i}.txt`)),{code:'ENOENT'});}
 report.run=await controller.runs.get(start.runId);assert.ok(report.run.tools.every(tool=>!!tool.approvalRequestedAt));report.status='passed';
} catch(error){report.failure={name:error.name,message:error.message};process.exitCode=1;}
finally {unsubscribe();rl?.close();await controller.shutdown();app.dispose();await writeFile(join(output,'telegram-result.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,approvals:report.approvals.length,failure:report.failure,output}));
