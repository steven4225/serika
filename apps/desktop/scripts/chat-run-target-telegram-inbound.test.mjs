import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inspectTelegramInbound, redactTelegramEvidence, telegramHandoff } from './chat-run-target-telegram-inbound.mjs';
import { writeTelegramStopAudit } from '../../../scripts/chat-run-target-telegram-stop-audit.mjs';
import { assertTelegramDelivery } from './chat-run-target-telegram-delivery.mjs';
import { PassThrough } from 'node:stream';
import { waitForTelegramPairReady } from './chat-run-target-telegram-pairing.mjs';

const owner = { userId: 42, chatId: 42, threadId: 'daily-thread' };
const binding = { owner: null, pairing: { code: '3935B76A82', proposed: null }, botId: 100, threadId: 'isolated-thread', offset: 414513485, runId: null };
const context = { owner, pairingCode: binding.pairing.code, pollId: 'offline-poll', indexInPoll: 0 };
const update = text => ({ update_id: 414513485, message: { message_id: 656, date: 1, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false }, ...(text === undefined ? {} : { text }) } });
const evidence = process.env.SERIKA_TG_INBOUND_EVIDENCE;
async function keep(name, value) {
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n'); }
}
async function keepPair(name, root) {
  if (!evidence) return;
  const directory = join(evidence, name); await mkdir(directory, { recursive: true });
  for (const file of ['result.json', 'stop-audit.json']) await copyFile(join(root, file), join(directory, file));
}

it('recovered non-pairing text persists full redacted rejection and exact predicate in stop audit', async () => {
  const root = await mkdtemp('/private/tmp/serika-tg-inbound-');
  try {
    const text = '继续，允许临时停用并恢复日用 TG 接入。';
    const actual = inspectTelegramInbound({ update: update(text), context, binding });
    assert.equal(actual.failedPredicate, 'text_matches_phase'); assert.deepEqual(actual.failedPredicates, ['text_matches_phase']);
    assert.equal(actual.update.message.text, text); assert.equal(actual.forwarded, false);
    const token = '123456:' + 'X'.repeat(30), secret = 'opaque-credential-value';
    const withToken = update(`完整前文 ${token}\n${secret} 完整后文`);
    withToken.message.caption = '附加字段完整保留';
    const sensitive = inspectTelegramInbound({ update: withToken, context, binding, secrets: [secret] });
    assert.equal(sensitive.update.message.text, '完整前文 [REDACTED_TELEGRAM_TOKEN]\n[REDACTED_CREDENTIAL] 完整后文');
    assert.equal(sensitive.update.message.caption, '附加字段完整保留');
    assert.deepEqual(sensitive.bindingBefore, binding); assert.deepEqual(sensitive.bindingAfter, binding);
    const report = { status: 'failed', batchId: randomUUID(), sourceCommit: 'offline-only', pairReadiness: [{ status: 'accepted', at: actual.at, matched: true }], inboundChecks: [actual, sensitive], calls: [], cases: [],
      stopReason: 'unexpected-telegram-inbound', costUsd: 0, unresolvedReservedUsd: 0, errors: [], bindingBeforeShutdown: binding, bindingAfterShutdown: { ...binding, pairing: null } };
    await writeFile(join(root, 'result.json'), JSON.stringify(report));
    await writeTelegramStopAudit({ directory: root });
    const auditText = await readFile(join(root, 'stop-audit.json'), 'utf8'), audit = JSON.parse(auditText);
    assert.ok(!auditText.includes(token) && !auditText.includes(secret));
    assert.deepEqual(audit.inboundChecks, report.inboundChecks);
    assert.deepEqual(audit.pairReadiness, report.pairReadiness);
    assert.deepEqual(audit.bindingBeforeShutdown, binding); assert.equal(audit.bindingAfterShutdown.pairing, null);
    assert.equal(audit.acceptance, 'failed-telegram-batch');
    await keep('rejection-stop-audit.json', audit);
    await keepPair('rejection', root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('owner/type failures remain separate; undefined text never becomes an expected task', async () => {
  const foreign = update('/start 3935B76A82'); foreign.message.from.id = 99;
  const wrongOwner = inspectTelegramInbound({ update: foreign, context, binding });
  assert.equal(wrongOwner.failedPredicate, 'owner_user_matches'); assert.equal(wrongOwner.safeToAcknowledge, false);
  const nonText = inspectTelegramInbound({ update: update(undefined), context, binding });
  assert.ok(nonText.failedPredicates.includes('text_is_string') && nonText.failedPredicates.includes('text_matches_phase'));
  const valid = inspectTelegramInbound({ update: update('  /start 3935B76A82\n'), context, binding });
  assert.equal(valid.accepted, true); assert.equal(valid.normalizedText, '/start 3935B76A82');
  assert.equal(valid.update.message.text, '  /start 3935B76A82\n');
  const malformed = inspectTelegramInbound({ update: null, context, binding });
  assert.equal(malformed.failedPredicate, 'update_object_valid'); assert.equal(malformed.update, null);
  const wrongResponse = inspectTelegramInbound({ update: { error: 'bad response' }, context: { ...context, pollResponseIsArray: false }, binding });
  assert.ok(wrongResponse.failedPredicates.includes('updates_response_array'));
  await keep('predicate-boundaries.json', { wrongOwner, nonText, valid, malformed, wrongResponse });
});

it('rejected observed update requires acknowledgement beyond the old store offset before daily restore', async () => {
  const rejected = inspectTelegramInbound({ update: update('继续，允许临时停用并恢复日用 TG 接入。'), context, binding });
  const before = telegramHandoff({ storeOffset: 414513485, records: [rejected], confirmedOffset: 414513485 });
  assert.equal(before.requiredOffset, 414513486); assert.equal(before.confirmed, false);
  const after = telegramHandoff({ storeOffset: 414513485, records: [rejected], confirmedOffset: 414513486 });
  assert.equal(after.confirmed, true);
  const foreign = update('hello'); foreign.message.chat.id = 99;
  const blocked = telegramHandoff({ storeOffset: 414513485, records: [inspectTelegramInbound({ update: foreign, context, binding })], confirmedOffset: 999999999 });
  assert.equal(blocked.confirmed, false); assert.ok(blocked.blockedBy.length);
  const later = inspectTelegramInbound({ update: update('/start 3935B76A82'), context: { ...context, handoffResponseSize: 1 }, binding });
  assert.equal(later.failedPredicate, 'handoff_response_empty');
  const laterBlocked = telegramHandoff({ storeOffset: 414513485, records: [later], confirmedOffset: 999999999 });
  assert.equal(laterBlocked.confirmed, false); assert.equal(later.forwarded, false);
  await keep('handoff.json', { before, after, blocked, later, laterBlocked });
});

it('early failed Run receipt is counted even before the waiting case receives its runId', async () => {
  const root = await mkdtemp('/private/tmp/serika-tg-early-run-');
  try {
    const report = { status: 'failed', batchId: randomUUID(), sourceCommit: 'offline-accounting-fixture', inboundChecks: [], calls: [],
      cases: [{ receipt: { runId: 'observed-before-wait-completed', status: 'failed' } }], costUsd: 0, unresolvedReservedUsd: 0, errors: [] };
    await writeFile(join(root, 'result.json'), JSON.stringify(report));
    const audit = await writeTelegramStopAudit({ directory: root });
    assert.equal(audit.taskRuns, 1); assert.equal(audit.receipts[0].runId, 'observed-before-wait-completed');
    await keep('early-run-accounting.json', audit);
    await keepPair('early-run', root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('pair readiness rejects wrong batch, EOF, stream error and cancellation before any handoff', async () => {
  const results = [];
  for (const reason of ['wrong-readiness-command', 'stdin-closed', 'stdin-error', 'readiness-aborted']) {
    const input = new PassThrough(), controller = new AbortController(), rows = [];
    const pending = waitForTelegramPairReady({ input, batchId: 'current-batch', signal: controller.signal, record: row => { rows.push(row); } });
    const rejected = assert.rejects(pending, new RegExp(reason));
    if (reason === 'stdin-closed') input.end();
    else if (reason === 'stdin-error') input.destroy(new Error('Private stdin detail'));
    else if (reason === 'readiness-aborted') controller.abort();
    else input.write('pair old-batch\n');
    await rejected;
    assert.equal(rows[0].status, 'waiting'); assert.equal(rows.at(-1).status, 'failed');
    assert.equal(rows.at(-1).matched, false); assert.equal(rows.at(-1).reason, reason);
    input.destroy(); results.push({ reason, rows });
  }
  await keep('pair-readiness-failures.json', { auditId: randomUUID(), results });
});

it('original gateway pairs trimmed command and host shutdown closes real proxy dispatcher once without network', async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const require = createRequire(new URL('../package.json', import.meta.url));
  const code = `
    import assert from 'node:assert/strict';
    import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
    import {join} from 'node:path';
    import {DesktopRuntime} from './apps/desktop/src/main/desktop-runtime.ts';
    import {TelegramGateway} from './apps/desktop/src/main/telegram-gateway.ts';
    import {TelegramStore} from './apps/desktop/src/main/telegram-store.ts';
    import {createTelegramApi} from './apps/desktop/src/main/telegram-api.ts';
    import {telegramParts} from './apps/desktop/src/main/telegram-format.ts';
    import {assertTelegramDelivery} from './apps/desktop/scripts/chat-run-target-telegram-delivery.mjs';
    import {PassThrough} from 'node:stream';
    import {waitForTelegramPairReady} from './apps/desktop/scripts/chat-run-target-telegram-pairing.mjs';
    import {inspectTelegramInbound} from './apps/desktop/scripts/chat-run-target-telegram-inbound.mjs';
    import {MockLanguageModelV3} from 'ai/test';
    const root=await mkdtemp('/private/tmp/serika-tg-lifecycle-');
    let calls=0,closeCalls=0,networkCalls=0,host;const transport=[];
    try {
      const work=join(root,'work'),home=join(root,'profile'),config=join(root,'config.json');await mkdir(work);
      await writeFile(config,JSON.stringify({version:2,authorizedDirectories:[{path:work,access:'readwrite'}],modules:{memory:{enabled:false},shell:{enabled:false}}}));
      host=await DesktopRuntime.create({applicationHome:home,cwd:work,env:{HOME:root,RUNLOOM_CONFIG:config},modelAlias:'mock',model:new MockLanguageModelV3({doStream:async()=>{calls++;throw new Error('Model forbidden');}}),send:()=>{}});
      const store=new TelegramStore(join(home,'resident/telegram.json'),home);await store.load();
      const actual=createTelegramApi('123456:'+ 'X'.repeat(30),async()=>{networkCalls++;throw new Error('Network forbidden');},{proxyUrl:'http://127.0.0.1:9'});
      const api={...actual,identity:async()=>({id:100,username:'offline'}),webhook:async()=>({url:''}),
        updates:async(_offset,signal)=>new Promise(done=>{if(signal.aborted)done([]);else signal.addEventListener('abort',()=>done([]),{once:true});}),
        send:async(chatId,text,_signal,format)=>{const messageId=transport.length+1;transport.push({direction:'outbound',chatId,text,format,messageId,status:'submitted'});return messageId;},close:async()=>{closeCalls++;await actual.close();}};
      let clock=Date.now();
      const gateway=new TelegramGateway(host,store,api,()=>clock);host.attachTelegram(gateway);await gateway.initialize();
      const input=new PassThrough(),readiness=[];
      const pendingReady=waitForTelegramPairReady({input,batchId:'offline-batch',signal:new AbortController().signal,record:row=>{readiness.push(row);}});
      await new Promise(setImmediate);
      const waiting={enabled:store.snapshot().enabled,connection:gateway.status().connection,pairing:gateway.status().pairing,owner:store.snapshot().owner};
      assert.deepEqual(waiting,{enabled:false,connection:'disabled',pairing:null,owner:null});assert.equal(transport.length,0);
      clock+=11*60*1000;assert.equal(gateway.status().pairing,null);
      input.write('pair offline-batch\\n');await pendingReady;input.destroy();assert.equal(readiness.at(-1).status,'accepted');
      await gateway.setEnabled(true);
      const pairing=gateway.beginPairing().pairing;
      assert.equal(Date.parse(pairing.expiresAt)-clock,300000);
      const before={owner:store.snapshot().owner,pairing,runId:null,offset:store.snapshot().offset};
      const message={update_id:1,message:{message_id:1,date:1,chat:{id:42,type:'private'},from:{id:42,is_bot:false,first_name:'Owner'},text:'  /start '+pairing.code+'\\n'}};
      const row=inspectTelegramInbound({update:message,context:{owner:{userId:42,chatId:42},pairingCode:pairing.code,pollId:'offline',indexInPoll:0},binding:before});
      assert.equal(row.accepted,true);await gateway.receive(message);assert.equal(gateway.status().pairing.proposed.userId,42);
      const proposed={owner:store.snapshot().owner,pairing:gateway.status().pairing};
      await gateway.confirmPairing(pairing.code);const after={owner:store.snapshot().owner,pairing:gateway.status().pairing};
      assert.equal(after.owner.userId,42);assert.equal(after.pairing,null);assert.equal(calls,0);
      const deliveries=store.snapshot().deliveries;for(const delivery of deliveries)assertTelegramDelivery({delivery,transport});
      const formatting=[];
      for(const text of ['目标 <Pi> & 正文','长'.repeat(5000)]){
        const parts=telegramParts(text,false).map((text,i)=>({text,state:'submitted',messageId:i+1}));
        const delivery={text,chatId:42,state:'submitted',messageId:parts.at(-1).messageId,parts};
        const sent=parts.map(part=>({direction:'outbound',status:'submitted',chatId:42,format:'HTML',...part}));
        const oldComparison=sent.some(row=>row.messageId===delivery.messageId&&row.text===delivery.text);assert.equal(oldComparison,false);
        assertTelegramDelivery({delivery,transport:sent});assert.throws(()=>assertTelegramDelivery({delivery,transport:sent.slice(1)}),/Missing exact submitted/);
        formatting.push({text,delivery,transport:sent,oldComparison});
      }
      await host.shutdown();host=undefined;assert.equal(closeCalls,1);assert.equal(gateway.status().connection,'disabled');assert.equal(networkCalls,0);
      console.log(JSON.stringify({waiting,simulatedWaitMs:11*60*1000,pairingTtlMs:Date.parse(pairing.expiresAt)-clock,readiness,before,proposed,after,deliveries,transport,formatting,closeCalls,networkCalls,modelCalls:calls,closed:true}));
    } finally {if(host)await host.shutdown();await rm(root,{recursive:true,force:true});}
  `;
  const child = spawnSync(process.execPath, ['--import', resolve(repo, 'apps/desktop/node_modules/tsx/dist/loader.mjs'), '--input-type=module'],
    { cwd: repo, input: code.replace("from 'ai/test'", `from '${pathToFileURL(require.resolve('ai/test')).href}'`), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  const result = JSON.parse(child.stdout.trim()); assert.equal(result.closeCalls, 1); assert.equal(result.networkCalls, 0); assert.equal(result.modelCalls, 0);
  for (const delivery of result.deliveries) assertTelegramDelivery({ delivery, transport: result.transport });
  const source = await readFile(join(repo, 'apps/desktop/scripts/chat-run-target-telegram-live.mjs'), 'utf8');
  assert.ok(!source.includes('await gateway.close()'), 'The attached gateway must be closed only by its host');
  assert.equal(redactTelegramEvidence({ token: 'opaque' }).token, '[REDACTED_CREDENTIAL]');
  await keep('original-gateway-lifecycle.json', result);
});
