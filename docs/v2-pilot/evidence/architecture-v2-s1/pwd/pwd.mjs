import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];assert.ok(args.includes('--home')&&args.includes('--repo'));
const home=resolve(arg('--home')),root=dirname(home),repo=resolve(arg('--repo'));assert.ok(home.startsWith('/private/tmp/serika-s1-'));
for(const p of [home,join(root,'A'),join(root,'userhome')])await mkdir(p,{mode:0o700});
const directory=join(root,'A');await writeFile(join(home,'config.json'),JSON.stringify({version:1,authorizedDirectory:directory,desktopAutonomy:{authorizedDirectory:directory},modules:{shell:{enabled:true}}}));await writeFile(join(home,'test.env'),'RUNLOOM_MODEL=mock\n');
const sha=data=>createHash('sha256').update(data).digest('hex'),git=(...a)=>spawnSync('git',a,{cwd:repo,encoding:'utf8'}).stdout.trim();
const report={runId:randomUUID(),sourceCommit:git('rev-parse','HEAD'),sourceWorktreeDirty:!!git('status','--porcelain'),scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),status:'failed',realModelCalls:0};assert.equal(report.sourceWorktreeDirty,false);
const {_electron:electron,expect}=createRequire(join(repo,'apps/desktop/package.json'))('playwright/test');
const env=Object.fromEntries(['PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]));Object.assign(env,{HOME:join(root,'userhome'),RUNLOOM_MODEL:'mock',RUNLOOM_DESKTOP_TEST:'1',RUNLOOM_USER_DATA:join(root,'profile'),RUNLOOM_CONFIG:join(home,'config.json'),RUNLOOM_ENV_FILE:join(home,'test.env'),RUNLOOM_WORKSPACE:directory,RUNLOOM_TRANSCRIPTS:join(home,'transcripts'),RUNLOOM_THREAD:'s1-pwd'});
let app,child;
try{
 app=await electron.launch({args:[join(repo,'apps/desktop/out/main/index.js'),'--home',home],cwd:root,env});child=app.process();const page=await app.firstWindow();
 report.main=await app.evaluate(({app})=>({pid:process.pid,electron:process.versions.electron,userData:app.getPath('userData'),home:app.getPath('home')}));report.renderer=await page.evaluate(()=>({userAgent:navigator.userAgent,url:location.href}));assert.match(report.renderer.userAgent,/Electron\//);
 await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();await page.getByPlaceholder('和 Serika 聊天').fill('S1 shell pwd');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('离线冒烟回复完成。',{exact:true})).toHaveCount(1);
 await expect(page.getByRole('button',{name:'停止本轮',exact:true})).toHaveCount(0);const runs=await page.evaluate(()=>window.runloom.listRuns());report.record=(await page.evaluate(id=>window.runloom.getRun(id),runs.runs[0].runId)).run;
 const tool=report.record.tools[0],result=JSON.parse(tool.resultPreview);assert.equal(tool.approvalRequestedAt,undefined);assert.equal(result.exitCode,0);assert.equal(result.output.trim().split('\n').at(-1),directory);
 const collapse=page.getByRole('button',{name:'收起侧栏',exact:true});if(await collapse.count())await collapse.click();const path=join(root,'pwd.png');await page.screenshot({path});report.screenshot={file:'pwd.png',sha256:sha(await readFile(path))};report.status='passed';
}catch(error){report.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{if(app)await app.close();if(child){report.exit={pid:child.pid,exitCode:child.exitCode,signal:child.signalCode};assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});}await writeFile(join(root,'pwd-result.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,runId:report.runId,failure:report.failure}));
