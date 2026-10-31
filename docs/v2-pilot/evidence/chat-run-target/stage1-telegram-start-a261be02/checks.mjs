import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
const repo='/Users/a1-6/Code/agents/serika-chat-run-target',out='/private/tmp/s197-start-fix/checks';await mkdir(out);
const env=Object.fromEntries(['PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SHELL'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]));
Object.assign(env,{HOME:join(out,'home'),SERIKA_TEST_HOME:join(out,'home'),SERIKA_B2_RECORD_CONCURRENT_HOME:'1',SERIKA_TG_INBOUND_EVIDENCE:join(out,'test-evidence')});await mkdir(env.HOME);
const report={id:randomUUID(),startedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourceWorktreeDirty:true,realModelCalls:0,telegramCalls:0,costUsd:0,status:'running',phases:[]};
const save=()=>writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
for(const [name,args]of [['typecheck',['typecheck']],['full-test',['test']]]){const log=join(out,name+'.log'),fd=openSync(log,'w'),row={name,command:['pnpm',...args],startedAt:new Date().toISOString()};report.phases.push(row);await save();console.log(JSON.stringify({phase:name,status:'running'}));
try{const child=spawn('pnpm',args,{cwd:repo,env,stdio:['ignore',fd,fd]});Object.assign(row,await new Promise((done,fail)=>{child.once('error',fail);child.once('close',(exitCode,signal)=>done({exitCode,signal}));}));}finally{closeSync(fd);}
const bytes=await readFile(log),text=bytes.toString();row.logSha256=createHash('sha256').update(bytes).digest('hex');row.counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,[...text.matchAll(new RegExp('^ℹ '+k+' (\\d+)','gm'))].reduce((s,m)=>s+Number(m[1]),0)]));row.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(row));if(row.exitCode!==0){report.status='failed';break;}}
if(report.status==='running')report.status='passed';report.finishedAt=new Date().toISOString();await save();if(report.status!=='passed')process.exitCode=1;
