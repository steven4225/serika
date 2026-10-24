import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, lstat, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const [backup,root]=process.argv.slice(2);
assert.ok(backup?.startsWith('/')&&root?.startsWith('/'),'Usage: node <absolute script> <absolute stopped backup> <absolute new private output directory>');
await mkdir(root,{mode:0o700});
async function manifest(base) {
 const rows=[];
 async function visit(relative='') {
  const path=join(base,relative),stat=await lstat(path),row={path:relative,mode:stat.mode&0o777};
  if(stat.isSymbolicLink()) {row.type='symlink';row.target=await (await import('node:fs/promises')).readlink(path);}
  else if(stat.isDirectory()) row.type='directory';
  else {assert.ok(stat.isFile(),'Backup must contain only regular files, directories and symlinks');row.type='file';const bytes=await readFile(path);row.bytes=bytes.length;row.sha256=hash(bytes);}
  rows.push(row);if(row.type==='directory')for(const name of (await readdir(path)).sort())await visit(join(relative,name));
 }
 await visit();return rows;
}
const {upgradeMemory,rollbackMemory}=await import(repo+'/packages/assistant/scripts/memory-upgrade.mjs');
const {upgradeConfig,rollbackConfig}=await import(repo+'/packages/assistant/scripts/config-upgrade.mjs');
const {identifyProject}=await import(repo+'/packages/assistant/dist/project.js');
const {createRuntimeApp}=await import(repo+'/packages/assistant/dist/app.js');
const {memoryReadTools}=await import(repo+'/packages/assistant/dist/memory-read-tools.js');
const require=(await import('node:module')).createRequire(repo+'/packages/assistant/package.json');
const {MockLanguageModelV3}=require('ai/test'),{simulateReadableStream}=require('ai');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const beforeManifest=await manifest(backup);
const copy=join(root,'rehearsal');await cp(backup,copy,{recursive:true,dereference:false,verbatimSymlinks:true});
assert.deepEqual(await manifest(backup),beforeManifest);assert.deepEqual(await manifest(copy),beforeManifest);
await writeFile(join(root,'backup-manifest.json'),JSON.stringify(beforeManifest,null,2)+'\n');
const configPath=join(copy,'config.json'),memoryPath=join(copy,'data/memory.json');
const beforeMemory=await readFile(memoryPath),beforeConfig=await readFile(configPath),old=JSON.parse(beforeMemory);
const project=await identifyProject(repo),personal=await identifyProject('/Users/a1-6/Serika-workspaces/personal');
const configDry=await upgradeConfig({configPath,dryRun:true});
const memoryDry=await upgradeMemory({memoryPath,projectPath:repo,dryRun:true});
assert.equal(memoryDry.ok,true);assert.deepEqual(await readFile(memoryPath),beforeMemory);assert.deepEqual(await readFile(configPath),beforeConfig);
const c=await upgradeConfig({configPath}),m=await upgradeMemory({memoryPath,projectPath:repo});
const upgraded=JSON.parse(await readFile(memoryPath));assert.equal(upgraded.entries.length,7);assert.equal(upgraded.library.documents.length,3);
assert.deepEqual(upgraded.entries.map(({scope,...entry})=>entry),old.entries.map(({scope,...entry})=>entry));
const checks=[];
for(const [name,selected] of [['personal',personal],['serika-v2',project],['none',null]]){
 const prompts=[];
 const model=new MockLanguageModelV3({doGenerate:async()=>assert.fail('No auxiliary/model call'),doStream:async options=>{prompts.push(options.prompt);return {stream:simulateReadableStream({chunks:[{type:'stream-start',warnings:[]},{type:'text-start',id:'answer'},{type:'text-delta',id:'answer',delta:'offline startup check'},{type:'text-end',id:'answer'},{type:'finish',finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}]})};}});
 const directory=join(root,'startup-'+name);const app=await createRuntimeApp({directory,assistant:{configPath,dataDirectory:join(copy,'data'),threadId:'rehearsal-'+name},project:selected,modelAlias:'mock',model,output:new PassThrough().resume(),cwd:personal.directory,env:{}});
 try{
  const user={id:randomUUID(),role:'user',metadata:{memoryProjectId:selected?.id??null},parts:[{type:'text',text:'只检查启动上下文'}]};
  const handle=await app.runtime.run({agentId:app.agentId,threadId:app.threadId,messages:[user],signal:AbortSignal.timeout(10000)});assert.equal((await handle.result).status,'completed');
  const context=JSON.stringify(prompts[0]),visible=name==='serika-v2';
  const store=await app.memoryStore.readV7();assert.equal(store.ok,true);
  const library=await app.memoryStore.getLibrary();assert.equal(library.ok,true);assert.equal(library.value.documents.filter(d=>!d.id.startsWith('memory:')).length,visible?3:0);
  const tool=memoryReadTools({store:app.memoryStore,dreaming:undefined,threadId:app.threadId})[0].tool;
  for(const doc of upgraded.library.documents){assert.equal(context.includes(doc.title),visible); const read=await tool.execute({id:doc.id},{toolCallId:'copy-check',messages:[],abortSignal:AbortSignal.timeout(5000)});assert.equal(read.ok,visible);if(!visible)assert.equal(read.error.code,'NOT_FOUND');}
  for(const entry of upgraded.entries.filter(e=>e.category==='preference')){assert.ok(context.includes(entry.text));const read=await tool.execute({query:entry.text},{toolCallId:'copy-pref',messages:[],abortSignal:AbortSignal.timeout(5000)});assert.ok(read.ok&&read.entries.some(e=>e.id===entry.id));}
  checks.push({project:name,visibleEntries:store.value.entries.length,userPreferences:store.value.entries.filter(e=>e.scope.kind==='user').length,documentIndex:visible?3:0,memoryReadDocuments:visible?3:0,sourceUnchanged:true,mainContextPass:true,memoryReadPass:true,libraryPass:true});
 }finally{await app.memoryExtraction?.close();app.dispose();}
}
assert.equal(hash(await readFile(memoryPath)),m.upgradedSha256);
const mr=await rollbackMemory({memoryPath,receiptPath:m.receiptPath}),cr=await rollbackConfig({configPath,receiptPath:c.receiptPath});
assert.deepEqual(await readFile(memoryPath),beforeMemory);assert.deepEqual(await readFile(configPath),beforeConfig);
const restored=JSON.parse(await readFile(memoryPath));assert.equal(restored.entries.length,7);assert.equal(restored.library.documents.length,3);
const retained=join(root,'upgrade-records');await mkdir(retained,{mode:0o700});
const originalPaths=new Set(beforeManifest.map(row=>row.path));
for(const row of (await manifest(copy)).reverse())if(!originalPaths.has(row.path)){
 const path=join(copy,row.path);
 if(row.type==='file'&&/\.(?:backup|json)$/.test(row.path))await (await import('node:fs/promises')).rename(path,join(retained,row.path.replaceAll('/','__')));
 else {assert.ok(row.path.endsWith('.lock'),'Unexpected startup file: '+row.path);await rm(path);}
}
assert.deepEqual(await manifest(copy),beforeManifest);
const result={runId:randomUUID(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),scriptSha256:hash(await readFile(fileURLToPath(import.meta.url))),verification:'daily-copy-offline-upgrade-production-runtime-fake-model-rollback',realModelCalls:0,sourceBackupStable:true,backupFiles:beforeManifest.filter(row=>row.type==='file').length,backupSymlinks:beforeManifest.filter(row=>row.type==='symlink').length,sourceManifestSha256:hash(JSON.stringify(beforeManifest)),rollbackAllFilesAndModesIdentical:true,counts:memoryDry.counts,assignments:memoryDry.entries,project:memoryDry.project,checks,memory:{before:hash(beforeMemory),upgraded:m.upgradedSha256,restored:mr.restoredSha256,identical:mr.identical},config:{before:hash(beforeConfig),upgraded:c.upgradedSha256,restored:cr.restoredSha256,identical:cr.identical},sourceAndAllEntryFieldsExceptScopeUnchanged:true,status:'passed'};
await writeFile(join(root,'rehearsal-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
