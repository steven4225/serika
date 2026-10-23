import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
assert.ok(args.includes('--home')&&args.includes('--output'));
const home=resolve(arg('--home')),output=resolve(arg('--output')),repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
assert.ok(home.startsWith('/private/tmp/serika-s1-'));assert.ok(!output.startsWith(repo+'/'));
const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
const sha=data=>createHash('sha256').update(data).digest('hex'),json=value=>JSON.stringify(value,null,2)+'\n';
const baseline='bb5c6e6c1674b0a2bdb3b71f331abf6b33467ced',path='packages/assistant/src/permission-boundary.snapshot.json';
const before=git('show',baseline+':'+path),after=await readFile(join(repo,path),'utf8');
assert.equal(sha(before),'b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670');
const acceptedS1='9ad2b9cf5560c2b9c57f6a3c57a85001b1452b8d', acceptedBytes=git('show',acceptedS1+':'+path);
assert.equal(sha(acceptedBytes),'d0b820f3eef8a8230d951e8e4da3d53cde0756b776b7645ffc00980dbbcc2e07');
assert.equal(after,acceptedBytes,'S05 must not change the accepted S1 b0 bytes');
const oldRows=JSON.parse(before),newRows=JSON.parse(after);
const changed=[...new Set([...Object.keys(oldRows),...Object.keys(newRows)])].filter(key=>JSON.stringify(oldRows[key])!==JSON.stringify(newRows[key]));
assert.deepEqual(changed,['desktop/shell_exec']);
const expected=structuredClone(oldRows);expected['desktop/shell_exec']={approvals:[],status:'completed',events:[{type:'tool.call.completed',ok:true,code:null}]};
assert.equal(after,json(expected),'The complete file must equal precisely the one approved replacement');
const row=(text,key)=>{const start=text.indexOf('  '+JSON.stringify(key)+': ');assert.ok(start>=0);const end=text.indexOf('\n  "',start+3);return text.slice(start,end<0?text.lastIndexOf('\n}'):end);};
const oldTelegram=row(before,'telegram/shell_exec'),newTelegram=row(after,'telegram/shell_exec');assert.equal(newTelegram,oldTelegram);
const frozen={
 'packages/assistant/src/permission-decisions.snapshot.ts':'08acd418d5d3831504b7393f72472c2910093a4b4b5d70394275f9847981bace',
 'apps/desktop/scripts/electron-smoke.mjs':'03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34',
 'examples/eval/cm-step6-live.mjs':'6a5572c3a0a37bb0979e2badcbc3cdbd16cda0849683c716f096a43815de1546'};
for(const [file,digest] of Object.entries(frozen)) assert.equal(sha(await readFile(join(repo,file))),digest,file);
const report={runId:randomUUID(),generatedAt:new Date().toISOString(),sourceCommit:git('rev-parse','HEAD').trim(),sourceWorktreeDirty:!!git('status','--porcelain').trim(),
 scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),baselineCommit:baseline,acceptedS1:{commit:acceptedS1,sha256:sha(acceptedBytes),byteIdentical:true},status:'passed',b0:{file:path,beforeSha256:sha(before),afterSha256:sha(after),
 approvedChangedKeys:['desktop/shell_exec'],actualChangedKeys:changed,unapprovedChanges:[],completeFileExactlyApprovedPatch:true,
 telegram:{byteIdentical:true,beforeBytes:Buffer.byteLength(oldTelegram),afterBytes:Buffer.byteLength(newTelegram),beforeSha256:sha(oldTelegram),afterSha256:sha(newTelegram)}},frozen};
const lines=git('diff','--numstat',acceptedS1,'HEAD').trim().split('\n').filter(Boolean).map(line=>{const [added,removed,path]=line.split('\t');
 const kind=path.startsWith('docs/')||path.endsWith('.json')?'evidence-docs':path.includes('/scripts/')||path.includes('.test.')||path.endsWith('/smoke-model.ts')?'tests-verification':'product';return {path,added:Number(added),removed:Number(removed),kind};});
report.lineChanges=Object.fromEntries(['product','migration-tools','tests-verification'].map(kind=>{const files=lines.filter(file=>file.kind===kind);return [kind,{added:files.reduce((n,f)=>n+f.added,0),removed:files.reduce((n,f)=>n+f.removed,0),net:files.reduce((n,f)=>n+f.added-f.removed,0),files}];}));
report.excludedNonCode=lines.filter(file=>file.kind==='evidence-docs');
await mkdir(output,{recursive:true});await writeFile(join(output,'b0.diff'),git('diff',baseline,'HEAD','--',path));await writeFile(join(output,'audit.json'),json(report));
console.log(json({status:report.status,sourceCommit:report.sourceCommit,b0:report.b0,lineChanges:Object.fromEntries(Object.entries(report.lineChanges).map(([k,v])=>[k,{added:v.added,removed:v.removed,net:v.net}]))}));
