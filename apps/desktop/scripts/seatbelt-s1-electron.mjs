import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--home') && args.includes('--output'));
const home = resolve(arg('--home')), root = dirname(home), directory = join(root, 'A'), output = resolve(arg('--output'));
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url))), desktop = join(repo, 'apps/desktop');
assert.ok(home.startsWith('/private/tmp/serika-s1-')); assert.ok(!output.startsWith(repo + '/'));
const sha = data => createHash('sha256').update(data).digest('hex'), hash = async path => sha(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n', wait = ms => new Promise(done => setTimeout(done, ms));
const git = (...args) => spawnSync('git', args, {cwd:repo, encoding:'utf8'}).stdout.trim();
const report = {runId:randomUUID(), startedAt:new Date().toISOString(), verification:'real-macos-electron-fake-model-real-shell',
  sourceCommit:git('rev-parse','HEAD'), sourceWorktreeDirty:!!git('status','--porcelain'), scriptSha256:await hash(fileURLToPath(import.meta.url)),
  status:'failed', realModelCalls:0, costUsd:0, checks:[], screenshots:[], commands:[]};
const fixture = spawnSync(process.execPath,[join(repo,'packages/assistant/scripts/seatbelt-s1-check.mjs'),'--home',home,'--output',output], {cwd:repo,encoding:'utf8'});
report.commands.push({name:'native-fixture',exitCode:fixture.status,stdout:fixture.stdout,stderr:fixture.stderr});
assert.equal(fixture.status,0,fixture.stdout + fixture.stderr);
const planPath = join(directory,'plan.json'), plan = JSON.parse(await readFile(planPath,'utf8'));
plan.protectedRename = home;
plan.protectedFiles = [join(home,'config.json'),join(home,'config.json.lock'),join(home,'data/canary')];
for (const path of plan.protectedFiles) {await mkdir(dirname(path),{recursive:true}); await writeFile(path,'fixture-only');}
const servers=[], datagrams=[]; let connections=0, udpPackets=0;
for (const [name,host] of [['IPv4','127.0.0.1'],['IPv6','::1'],['Unix',null]]) {
  const server=createServer(socket=>{connections++;socket.end();}); servers.push(server);
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(host?{host,port:0}:{path:plan.socket},done);});
  if(host) plan.ports[name]=server.address().port;
}
for (const [name,host] of [['UDP4','127.0.0.1'],['UDP6','::1']]) {
  const socket=createSocket(name==='UDP4'?'udp4':'udp6'); datagrams.push(socket);socket.on('message',()=>udpPackets++);
  await new Promise((done,fail)=>{socket.once('error',fail);socket.bind(0,host,done);});plan.ports[name]=socket.address().port;
}
await writeFile(planPath,json(plan));
const userhome=join(root,'userhome'); await mkdir(userhome);
await writeFile(join(home,'config.json'),json({version:1,authorizedDirectory:directory,desktopAutonomy:{authorizedDirectory:directory},modules:{shell:{enabled:true},'read-file':{enabled:true},memory:{enabled:false}},automation:{hooks:[]}}),{mode:0o600});
await writeFile(join(home,'test.env'),'RUNLOOM_MODEL=mock\n',{mode:0o600});
const env=Object.fromEntries(['PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR'].flatMap(name=>process.env[name]?[[name,process.env[name]]]:[]));
Object.assign(env,{HOME:userhome,XDG_CONFIG_HOME:join(userhome,'.config'),XDG_CACHE_HOME:join(userhome,'.cache'),RUNLOOM_MODEL:'mock',RUNLOOM_DESKTOP_TEST:'1',
  RUNLOOM_USER_DATA:join(root,'profile'),RUNLOOM_CONFIG:join(home,'config.json'),RUNLOOM_ENV_FILE:join(home,'test.env'),RUNLOOM_WORKSPACE:directory,
  RUNLOOM_TRANSCRIPTS:join(home,'transcripts'),RUNLOOM_THREAD:'s1-electron',PROBE_CREDENTIAL_CANARY:randomUUID()});
let running,page,electronChild;
const shot=async name=>{const collapse=page.getByRole('button',{name:'收起侧栏',exact:true});if(await collapse.count())await collapse.click();assert.equal(await page.locator('.settings-detail:visible').count(),0);const file=name+'.png';await page.screenshot({path:join(output,file)});const item={file,sha256:await hash(join(output,file))};report.screenshots.push(item);return item;};
const snapshot=()=>page.evaluate(()=>window.runloom.snapshot());
const until=async check=>{const end=Date.now()+(args.includes('--interactive')?180000:30000);while(!await check()){assert.ok(Date.now()<end,'Timed out waiting for real runtime');await wait(20);}};
const send=async command=>{await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();await page.getByPlaceholder('和 Serika 聊天').fill('S1 shell '+command);await page.getByRole('button',{name:'发送消息',exact:true}).click();};
const idle=()=>until(async()=>{const s=await snapshot();return s.state.kind==='idle' && !s.pendingApproval;});
async function receipt(name) {
  await idle();const runs=await page.evaluate(()=>window.runloom.listRuns());assert.equal(runs.ok,true);
  const id=runs.runs[0].runId;const read=await page.evaluate(id=>window.runloom.getRun(id),id);assert.equal(read.ok,true);
  const record=read.run;assert.equal(record.tools.length,1);const tool=record.tools[0];assert.equal(tool.toolName,'shell_exec');
  report.checks.push({name,record});return tool;
}
function parse(tool) {assert.equal(tool.resultTruncated,false);const result=JSON.parse(tool.resultPreview);assert.equal(result.ok,true);assert.equal(result.exitCode,0);return JSON.parse(result.output.trim().split('\n').at(-1));}
try {
  running=await electron.launch({args:[join(desktop,'out/main/index.js'),'--home',home],cwd:root,env,timeout:30000});
  electronChild=running.process(); page=await running.firstWindow();page.setDefaultTimeout(15000);await expect(page.getByPlaceholder('和 Serika 聊天')).toBeEnabled();
  report.main=await running.evaluate(({app})=>({electron:process.versions.electron,pid:process.pid,userData:app.getPath('userData'),home:app.getPath('home')}));
  report.renderer=await page.evaluate(()=>({userAgent:navigator.userAgent,url:location.href}));
  assert.ok(report.main.electron);assert.match(report.renderer.userAgent,/Electron\//);assert.equal(report.main.home,userhome);assert.equal(report.main.userData,env.RUNLOOM_USER_DATA);
  report.artifactHashes=Object.fromEntries(await Promise.all(['out/main/index.js','out/preload/index.cjs','out/renderer/index.html'].map(async path=>[path,await hash(join(desktop,path))])));
  const info=await page.evaluate(()=>window.runloom.info());assert.equal(info.autonomy.enabled,true);
  const control=spawnSync(join(directory,'process'),['--pid',String(report.main.pid),'--home',home,'--read-control'],{env:{PATH:'/usr/bin:/bin',HOME:userhome},encoding:'utf8'});
  assert.equal(control.status,0);const positive=JSON.parse(control.stdout);assert.equal(positive.numericProcargs2.variableNameObserved,true);
  report.checks.push({name:'S15-Electron-host-positive-control',signalControlSkipped:true,exitCode:control.status,result:positive});
  await send(`${directory}/process --pid ${report.main.pid} --home ${home}`);
  const processTool=await receipt('S01-S10-S11-S15');assert.equal(processTool.approvalRequestedAt,undefined);
  const cross=parse(processTool);for(const name of ['numericProcargs2','numericProcargs','numericProcInfo','processInfo','processPath','taskPort','taskReadPort','taskInspectPort','taskNamePort','externalSignal']) assert.equal(cross[name].blocked,true,name);
  assert.ok(cross.machServices.every(item=>item.blocked));assert.equal(cross.descriptors.extraOpen,0);assert.equal(cross.descriptors.sockets,0);report.crossProcess=cross;
  await shot('S15-cross-process-denied');
  const observed=join(directory,'electron-observed.json');
  await send(`node ${directory}/checks.mjs --child checks --plan ${planPath} --result-file ${observed} --home ${home}`);
  const fsTool=await receipt('S04-S09');assert.equal(fsTool.shell.exitCode,0);assert.equal(fsTool.approvalRequestedAt,undefined);
  const filesystem=JSON.parse(await readFile(observed,'utf8'));
  for(const [name,value] of Object.entries(filesystem)) {if(typeof value==='boolean') assert.equal(value,true,name);else if(Array.isArray(value)) assert.ok(value.every(item=>item.blocked),name);else assert.equal(value.blocked,true,name);}
  report.filesystem=filesystem;
  await send(`${directory}/network ${plan.ports.UDP4} --home ${home}`);const network=parse(await receipt('S09-raw-TCP-UDP-DNS-listen'));assert.ok(Object.values(network).every(item=>item.blocked));report.network=network;
  assert.equal(connections,0);assert.equal(udpPackets,0);await shot('S04-S09-files-network-denied');
  const childObserved=join(directory,'electron-descendant.json');
  await send(`{ node ${directory}/checks.mjs --child checks --plan ${planPath} --result-file ${childObserved} --home ${home}; } & wait`);
  assert.equal((await receipt('S12-fork-exec')).shell.exitCode,0);assert.deepEqual(JSON.parse(await readFile(childObserved,'utf8')),filesystem);
  await send(`node ${directory}/checks.mjs --child spawn --plan ${planPath} --home ${home}`);assert.equal(parse(await receipt('S12-detached-posix-spawn')).detachedSpawn.blocked,true);
  const cancel=join(directory,'electron-cancel');await mkdir(cancel);
  await send(`${directory}/cancel --temp ${cancel} --home ${home}`);let ready;
  await until(async()=>{try{ready=JSON.parse(await readFile(join(cancel,'ready.json'),'utf8'));return true;}catch{return false;}});
  assert.equal(ready.setsidBlocked,true);assert.equal(ready.setpgidBlocked,true);await shot('S13-before-cancel');
  if(!args.includes('--interactive')) await page.getByRole('button',{name:'停止本轮',exact:true}).click(); else console.log('手动检查：请在 Electron 点「停止本轮」，脚本将核对后代停止。');const cancelled=await receipt('S13-cancel');
  if(cancelled.shell) assert.equal(cancelled.shell.cancelled,true); else assert.equal(cancelled.status,'unknown');const before=await readFile(join(cancel,'heartbeat'),'utf8');await wait(400);const after=await readFile(join(cancel,'heartbeat'),'utf8');
  const late=Number(await readFile(join(cancel,'after-term.pid'),'utf8'));for(const pid of [ready.pid,late]) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(before,after);report.cancellation={ready,latePid:late,descendantsStopped:true,heartbeatStopped:true};await shot('S13-after-cancel');
  await page.evaluate(()=>window.runloom.setAutonomyEnabled({enabled:false,expectedEnabled:true}));assert.equal((await page.evaluate(()=>window.runloom.info())).autonomy.enabled,false);
  for(let i=0;i<2;i++) {
    const command=i===0?'printf host-confirmed':`node -e 'const s=require("node:net").connect({host:"127.0.0.1",port:${plan.ports.IPv4}});s.on("connect",()=>{console.log("host-network-ok");s.end()});s.on("error",()=>process.exit(1))' -- --home ${home}`;
    await send(command);await until(async()=>!!(await snapshot()).pendingApproval);assert.equal(connections,0);
    await expect(page.locator('[aria-label="工具调用确认"]')).toBeVisible();
    await shot(i===0?'host-first-confirmation':'host-network-confirmation');if(!args.includes('--interactive')) await page.getByRole('button',{name:'允许本次调用',exact:true}).click();else console.log('手动检查：请核对 host 命令并点「允许本次调用」，两条命令各确认一次。');
    const tool=await receipt(i===0?'host-first-command':'host-network-command');assert.ok(tool.approvalRequestedAt);assert.equal(tool.shell.exitCode,0);
  }
  assert.equal(connections,1);report.hostNetworkConnections=connections;
  const visible=await page.locator('[role="alert"]:visible, [class*="error"]:visible, [class*="warning"]:visible, .status-failed:visible, .status-unknown:visible, .status-timed_out:visible').allTextContents();
  assert.deepEqual(visible,[]);report.unexpectedVisibleErrors=0;report.status='passed';
} catch(error) {
  report.failure={name:error.name,message:error.message};process.exitCode=1;if(page)await shot('failure').catch(()=>{});
} finally {
  if(running) {await running.close().catch(error=>{report.cleanupError=error.message;report.status='failed';process.exitCode=1;});report.electronExit={pid:electronChild.pid,exitCode:electronChild.exitCode,signal:electronChild.signalCode};assert.throws(()=>process.kill(electronChild.pid,0),{code:'ESRCH'});}
  await Promise.all(servers.map(server=>new Promise(done=>server.close(done))));await Promise.all(datagrams.map(socket=>new Promise(done=>socket.close(done))));
  report.finishedAt=new Date().toISOString();await writeFile(join(output,'electron-result.json'),json(report));
}
console.log(JSON.stringify({runId:report.runId,status:report.status,failure:report.failure,output}));
