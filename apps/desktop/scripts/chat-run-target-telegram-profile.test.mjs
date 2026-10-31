import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { telegramTestSettings, prepareTelegramTestProfile, loadTelegramTestSettings } from './chat-run-target-telegram-profile.mjs';

const evidence = process.env.SERIKA_TG_INBOUND_EVIDENCE;
const source = { SERIKA_TG_TEST_ONLY: '1', SERIKA_TG_TEST_BOT_ID: '123456', SERIKA_TG_TEST_OWNER_USER_ID: '42', SERIKA_TG_TEST_OWNER_CHAT_ID: '42',
  TELEGRAM_BOT_TOKEN: '123456:' + 'X'.repeat(30), COMMAND_CODE_BASE_URL: 'https://api.commandcode.ai/provider/v1', COMMAND_CODE_MODEL_ID: 'deepseek/deepseek-v4.1-flash-fast', COMMAND_CODE_API_KEY: 'offline-model-key' };
async function keep(name, value) { if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n'); } }

it('dedicated settings reject the day-use Bot, missing fields, symlink aliases, busy profile and retained runtime', async () => {
  const root = await mkdtemp('/private/tmp/serika-tg-dedicated-');
  try {
    assert.throws(() => telegramTestSettings({ source: { ...source, SERIKA_TG_TEST_BOT_ID: '8797046945', TELEGRAM_BOT_TOKEN: '8797046945:private' }, forbiddenBotId: 8797046945 }), /historical day-use Bot/);
    assert.throws(() => telegramTestSettings({ source: { SERIKA_TG_TEST_ONLY: '1', TELEGRAM_BOT_TOKEN: 'private' }, forbiddenBotId: 8797046945 }), /Missing test env fields: SERIKA_TG_TEST_BOT_ID/);
    const settings = telegramTestSettings({ source: { ...source, SERIKA_TG_TEST_PROFILE_ROOT: join(root, 'test-profile'), SERIKA_TG_TEST_RUNTIME_ROOT: join(root, 'runtime') }, forbiddenBotId: 8797046945 });
    const first = await prepareTelegramTestProfile(settings);
    await assert.rejects(prepareTelegramTestProfile(settings), /Another test host/);
    await first.release();
    await assert.rejects(prepareTelegramTestProfile(settings), { code: 'EEXIST' });
    await rm(settings.runtimeRoot, { recursive: true });
    const second = await prepareTelegramTestProfile(settings); await second.release();
    const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, join(root, 'alias'));
    await assert.rejects(prepareTelegramTestProfile({ ...settings, profileRoot: join(root, 'alias', 'child') }), /alias|symlink/);
    await assert.rejects(readFile(join(outside, 'child')), { code: 'ENOENT' });
    const envFile = join(root, 'test.env'); await writeFile(envFile, Object.entries({ ...source, SERIKA_TG_TEST_PROFILE_ROOT: join(root, 'test-profile'), SERIKA_TG_TEST_RUNTIME_ROOT: join(root, 'runtime') }).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
    const loaded = await loadTelegramTestSettings({ envFile, forbiddenBotId: 8797046945 }); assert.equal(loaded.botId, 123456);
    await keep('dedicated-settings-boundaries.json', { auditId: randomUUID(), rejectedDayUseBot: true, rejectedMissingFields: true, rejectedConcurrentHost: true, rejectedRetainedRuntime: true, rejectedSymlinkBeforeWrite: true, privateTestEnvAccepted: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('original gateway persists its first pairing and reuses owner Thread and offset after a new host without daily access', async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url)), require = createRequire(new URL('../package.json', import.meta.url));
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    import {homedir} from 'node:os';
    let forbiddenAccesses=0,networkCalls=0,modelCalls=0,closeCalls=0;
    const dailyRoots=['/Users/a1-6/.serika','/Users/a1-6/.config/serika/v2-daily.env',join(homedir(),'.serika')];
    function check(path){const value=path instanceof URL?path.pathname:String(path);if(dailyRoots.some(root=>value===root||value.startsWith(root+'/'))){forbiddenAccesses++;throw new Error('Day-use access forbidden');}}
    for(const key of ['readFile','writeFile','mkdir','open','stat','lstat','realpath','access','readdir','rename','unlink','rm']){const original=fsp[key];fsp[key]=function(path,...args){check(path);return original.call(this,path,...args);};}
    for(const key of ['readFileSync','writeFileSync','mkdirSync','openSync','statSync','lstatSync','realpathSync','accessSync','readdirSync','renameSync','unlinkSync','rmSync','existsSync']){const original=fs[key];fs[key]=function(path,...args){check(path);return original.call(this,path,...args);};}
    syncBuiltinESMExports();globalThis.fetch=async()=>{networkCalls++;throw new Error('Network forbidden');};
    const {DesktopRuntime}=await import('./apps/desktop/src/main/desktop-runtime.ts');
    const {TelegramGateway}=await import('./apps/desktop/src/main/telegram-gateway.ts');
    const {TelegramStore}=await import('./apps/desktop/src/main/telegram-store.ts');
    const {listDesktopThreads}=await import('./apps/desktop/src/main/desktop-identity.ts');
    const {telegramTestSettings,prepareTelegramTestProfile,writeTelegramTestConfig,inspectTelegramTestStore}=await import('./apps/desktop/scripts/chat-run-target-telegram-profile.mjs');
    const {inspectTelegramInbound}=await import('./apps/desktop/scripts/chat-run-target-telegram-inbound.mjs');
    const {MockLanguageModelV3}=await import('AI_TEST_PATH');
    const root=await fsp.mkdtemp('/private/tmp/serika-tg-reuse-');let host,lease;
    const settings=telegramTestSettings({source:{SERIKA_TG_TEST_ONLY:'1',SERIKA_TG_TEST_BOT_ID:'123456',SERIKA_TG_TEST_OWNER_USER_ID:'42',SERIKA_TG_TEST_OWNER_CHAT_ID:'42',TELEGRAM_BOT_TOKEN:'123456:'+ 'X'.repeat(30),COMMAND_CODE_BASE_URL:'https://api.commandcode.ai/provider/v1',COMMAND_CODE_MODEL_ID:'deepseek/deepseek-v4.1-flash-fast',COMMAND_CODE_API_KEY:'offline-only',SERIKA_TG_TEST_PROFILE_ROOT:join(root,'test-profile'),SERIKA_TG_TEST_RUNTIME_ROOT:join(root,'runtime')},forbiddenBotId:8797046945});
    const records=[];
    async function start(){
      lease=await prepareTelegramTestProfile(settings);await fsp.mkdir(settings.workspace,{recursive:true});await writeTelegramTestConfig({settings,model:'deepseek/deepseek-v4.1-flash-fast'});
      host=await DesktopRuntime.create({applicationHome:settings.applicationHome,cwd:settings.workspace,env:{HOME:root,RUNLOOM_CONFIG:settings.configPath},modelAlias:'mock',model:new MockLanguageModelV3({doStream:async()=>{modelCalls++;throw new Error('Model forbidden');}}),send:()=>{}});
      const store=new TelegramStore(join(settings.applicationHome,'resident/telegram.json'),settings.applicationHome);await store.load();const initial=inspectTelegramTestStore({data:store.snapshot(),settings});
      const api={identity:async()=>({id:123456,username:'dedicated_offline'}),webhook:async()=>({url:''}),updates:async(_offset,signal)=>new Promise(done=>{if(signal.aborted)done([]);else signal.addEventListener('abort',()=>done([]),{once:true});}),send:async()=>1,close:async()=>{closeCalls++;},answerCallback:async()=>{}};
      const gateway=new TelegramGateway(host,store,api);host.attachTelegram(gateway);await gateway.initialize();assert.equal(gateway.status().connection,'disabled');
      return {store,gateway,initial};
    }
    async function stop(store){await host.shutdown();host=undefined;await store.update(data=>{data.enabled=false;});await lease.release();lease=undefined;await fsp.rm(settings.runtimeRoot,{recursive:true});}
    try{
      const first=await start();await first.gateway.setEnabled(true);const pairing=first.gateway.beginPairing().pairing;
      const update={update_id:1,message:{message_id:1,date:1,text:'/start '+pairing.code,from:{id:42,is_bot:false,first_name:'Owner'},chat:{id:42,type:'private'}}};
      const row=inspectTelegramInbound({update,context:{owner:settings.owner,pairingCode:pairing.code,pollId:'offline-first',indexInPoll:0},binding:{owner:null,runId:null}});assert.equal(row.accepted,true);
      await first.gateway.receive(update);assert.equal(first.gateway.status().pairing.proposed.userId,42);await first.gateway.confirmPairing(pairing.code);
      const owner=first.store.snapshot().owner,offset=first.store.snapshot().offset;assert.equal(offset,2);assert.equal(owner.userId,42);
      records.push({phase:'first-pairing',owner,offset});await stop(first.store);
      const second=await start();assert.deepEqual(second.initial.owner,owner);assert.equal(second.initial.offset,offset);
      const threads=await listDesktopThreads({applicationHome:settings.applicationHome,configPath:settings.configPath,workspaceRoot:settings.workspace,cwd:settings.workspace});assert.ok(threads.some(row=>row.threadId===owner.threadId));
      await second.gateway.setEnabled(true);assert.equal(second.gateway.status().pairing,null);assert.throws(()=>second.gateway.beginPairing(),/不会覆盖/);
      assert.deepEqual(second.store.snapshot().owner,owner);assert.equal(second.store.snapshot().offset,offset);assert.equal(second.store.snapshot().inputs.length,0);assert.equal(host.current.snapshot().state.kind,'idle');
      const config=JSON.parse(await fsp.readFile(settings.configPath,'utf8'));assert.deepEqual(config.modules.terminal,{enabled:true});
      records.push({phase:'reused-binding',owner:second.store.snapshot().owner,offset:second.store.snapshot().offset,registeredThread:true,pairing:second.gateway.status().pairing});await stop(second.store);
      assert.equal(closeCalls,2);assert.equal(networkCalls,0);assert.equal(modelCalls,0);assert.equal(forbiddenAccesses,0);
      console.log(JSON.stringify({records,closeCalls,networkCalls,modelCalls,forbiddenAccesses}));
    }finally{if(host)await host.shutdown();if(lease)await lease.release();await fsp.rm(root,{recursive:true,force:true});}
  `;
  const child = spawnSync(process.execPath, ['--import', resolve(repo, 'apps/desktop/node_modules/tsx/dist/loader.mjs'), '--input-type=module'],
    { cwd: repo, input: code.replace('AI_TEST_PATH', pathToFileURL(require.resolve('ai/test')).href), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  const value = JSON.parse(child.stdout.trim()); assert.equal(value.forbiddenAccesses, 0); assert.equal(value.networkCalls, 0); assert.equal(value.modelCalls, 0);
  await keep('dedicated-original-gateway-reuse.json', { auditId: randomUUID(), ...value });
});

it('live observer permits the first paired Telegram task to start and records its unique Run', async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url)), require = createRequire(new URL('../package.json', import.meta.url));
  const code = `
    import assert from 'node:assert/strict';
    import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
    import {join} from 'node:path';
    import vm from 'node:vm';
    import {DesktopRuntime} from './apps/desktop/src/main/desktop-runtime.ts';
    import {TelegramGateway} from './apps/desktop/src/main/telegram-gateway.ts';
    import {TelegramStore} from './apps/desktop/src/main/telegram-store.ts';
    import {MockLanguageModelV3} from 'AI_TEST_PATH';
    const live=await readFile('./apps/desktop/scripts/chat-run-target-telegram-live.mjs','utf8');
    const start=live.indexOf('function observe(message) {'),end=live.indexOf('\\ntry {',start);
    assert.ok(start>=0&&end>start);
    let modelCalls=0,networkCalls=0,host;
    globalThis.fetch=async()=>{networkCalls++;throw new Error('Network forbidden');};
    const root=await mkdtemp('/private/tmp/s197-observer-'),workspace=join(root,'workspace'),applicationHome=join(root,'profile'),configPath=join(root,'config.json');
    const report={cases:[{hostDecisions:[]}],approvalEvents:[]},exceptions=[],sent=[];
    const context=vm.createContext({host:undefined,runId:undefined,report,activeInbound:undefined,Date,save:async()=>{},stop:reason=>{throw new Error(reason);}});
    vm.runInContext(live.slice(start,end),context);
    try{
      await mkdir(workspace);
      await writeFile(configPath,JSON.stringify({version:2,projectDirectory:workspace,authorizedDirectories:[{path:workspace,access:'readwrite'}],modules:{'read-file':{enabled:true},shell:{enabled:false},terminal:{enabled:true},memory:{enabled:false}}}));
      host=await DesktopRuntime.create({applicationHome,cwd:workspace,env:{HOME:root,RUNLOOM_CONFIG:configPath},modelAlias:'mock',
        model:new MockLanguageModelV3({doStream:async()=>{modelCalls++;return {stream:new ReadableStream({start(controller){
          for(const chunk of [{type:'stream-start',warnings:[]},{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:'offline-complete'},{type:'text-end',id:'text'},
            {type:'finish',finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:1,noCache:1,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:1,text:1,reasoning:undefined}}}])controller.enqueue(chunk);controller.close();
        }})};}}),send:message=>{try{context.observe(message);}catch(error){exceptions.push({type:message.type,message:error.message});throw error;}}});
      context.host=host;
      const store=new TelegramStore(join(applicationHome,'resident/telegram.json'),applicationHome);await store.load();
      const api={identity:async()=>({id:123456,username:'offline_only'}),webhook:async()=>({url:''}),
        updates:async(_offset,signal)=>new Promise(done=>{if(signal.aborted)done([]);else signal.addEventListener('abort',()=>done([]),{once:true});}),
        send:async(_chat,text)=>{sent.push(text);return sent.length;},close:async()=>{},answerCallback:async()=>{}};
      const gateway=new TelegramGateway(host,store,api);host.attachTelegram(gateway);await gateway.initialize();await gateway.setEnabled(true);
      const update=(id,text)=>({update_id:id,message:{message_id:id,date:1,text,from:{id:42,is_bot:false,first_name:'Offline'},chat:{id:42,type:'private'}}});
      const pairing=gateway.beginPairing().pairing;await gateway.receive(update(1,'/start '+pairing.code));await gateway.confirmPairing(pairing.code);
      await gateway.receive(update(2,'请处理本次离线任务。'));
      const deadline=Date.now()+10000;
      while(true){
        const snapshot=store.snapshot(),input=snapshot.inputs[0];
        if(input&&['rejected','unknown'].includes(input.state))break;
        if(input?.state==='finished'&&report.approvalEvents.some(row=>row.type==='result'&&row.result.status==='completed')&&
          sent.includes('offline-complete')&&snapshot.deliveries.some(row=>row.state==='submitted'&&row.text==='offline-complete'))break;
        assert.ok(Date.now()<deadline,'Task result and reply submission did not settle');await new Promise(done=>setTimeout(done,10));
      }
      const inputs=store.snapshot().inputs,diagnostic=JSON.stringify({inputs,modelCalls,exceptions,sent});
      assert.equal(inputs.length,1);assert.equal(inputs[0].state,'finished',diagnostic);assert.ok(inputs[0].runId);
      assert.equal(modelCalls,1);assert.equal(networkCalls,0);assert.deepEqual(exceptions,[]);
      assert.equal(report.cases[0].runId,inputs[0].runId);
      assert.deepEqual([...new Set(report.approvalEvents.map(row=>row.runId))],[inputs[0].runId]);
      assert.ok(report.approvalEvents.some(row=>row.type==='result'&&row.result.status==='completed'));
      assert.ok(sent.includes('offline-complete'));
      const deliveries=store.snapshot().deliveries;assert.ok(deliveries.some(row=>row.state==='submitted'&&row.text==='offline-complete'));
      console.log(JSON.stringify({inputs,deliveries,modelCalls,networkCalls,exceptions,observedRunId:report.cases[0].runId}));
    }finally{if(host)await host.shutdown();await rm(root,{recursive:true,force:true});}
  `;
  const child = spawnSync(process.execPath, ['--import', resolve(repo, 'apps/desktop/node_modules/tsx/dist/loader.mjs'), '--input-type=module'],
    { cwd: repo, input: code.replace('AI_TEST_PATH', pathToFileURL(require.resolve('ai/test')).href), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  await keep('dedicated-observer-first-task.json', { auditId: randomUUID(), ...JSON.parse(child.stdout.trim()) });
});
