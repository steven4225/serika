import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,symlink,access} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];assert.ok(args.includes('--home')&&args.includes('--repo'));
const home=resolve(arg('--home')),root=dirname(home),repo=resolve(arg('--repo'));assert.ok(home.startsWith('/private/tmp/serika-s1-'));
for(const path of [home,join(root,'A'),join(root,'B'),join(root,'A/sub')])await mkdir(path,{mode:0o700});
await symlink(join(root,'A'),join(root,'alias-A'));await symlink(join(root,'A/sub'),join(root,'A/link'));
const {SeatbeltShellRunner}=await import(join(repo,'packages/assistant/dist/modules/seatbelt-shell-runner.js'));
const runner=new SeatbeltShellRunner({home,protectedPaths:[home]}),execution={timeoutMs:30000,maxOutputBytes:65536,killGraceMs:250};
const git=(...a)=>spawnSync('git',a,{cwd:repo,encoding:'utf8'}).stdout.trim(),sha=data=>createHash('sha256').update(data).digest('hex');
const report={runId:randomUUID(),sourceCommit:git('rev-parse','HEAD'),sourceWorktreeDirty:!!git('status','--porcelain'),scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),status:'failed',checks:[]};
try{
 for(const [name,directory,cwd] of [['S04-root','/','.'],['S07-A-symlink',join(root,'alias-A'),'.'],['S07-cwd-symlink',join(root,'A'),'link'],['S07-cwd-escape',join(root,'A'),'../B']]){
  const result=await runner.execute({directory,input:{command:`printf forbidden > ${root}/fallback-marker`,cwd},signal:new AbortController().signal,execution});
  report.checks.push({name,result});assert.equal(result.ok,false);assert.equal(result.error.code,'SANDBOX_UNAVAILABLE');await assert.rejects(access(join(root,'fallback-marker')),{code:'ENOENT'});
 }
 const result=await runner.execute({directory:join(root,'A'),input:{command:'printf allowed > marker',cwd:'sub'},signal:new AbortController().signal,execution});
 assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.equal(await readFile(join(root,'A/sub/marker'),'utf8'),'allowed');report.checks.push({name:'S07-canonical-cwd-control',result});report.status='passed';
}catch(error){report.failure={name:error.name,message:error.message};process.exitCode=1;}
await runner.settle();await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,runId:report.runId,failure:report.failure}));
