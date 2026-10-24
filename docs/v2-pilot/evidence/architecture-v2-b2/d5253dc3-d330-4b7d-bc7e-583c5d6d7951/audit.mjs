import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
const repo='/Users/a1-6/Code/agents/serika-v2';
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const snapshot='packages/assistant/src/permission-boundary.snapshot.json';
const before=JSON.parse(git(['show',`dc64781:${snapshot}`])), original=JSON.parse(git(['show',`8e0222f:${snapshot}`])), after=JSON.parse(await readFile(`${repo}/${snapshot}`,'utf8'));
const frozen=['examples/eval/cm-step6-live.mjs','packages/assistant/scripts/cm-step6-verify.mjs',...[1,2,3].map(n=>`packages/assistant/scripts/v2-round${n}-verify.mjs`),'apps/desktop/scripts/electron-smoke.mjs','packages/assistant/src/permission-decisions.snapshot.ts','packages/assistant/src/__baseline__','apps/desktop/src/main/__baseline__'];
const report={runId:randomUUID(),sourceCommit:git(['rev-parse','HEAD']),frozenDiff:git(['diff','8e0222f','--',...frozen]),snapshot:{originalRows:Object.keys(original).length,reviewedRows:Object.keys(before).length,currentRows:Object.keys(after).length,changedOriginal:Object.keys(original).filter(k=>JSON.stringify(original[k])!==JSON.stringify(after[k])),changedReviewed:Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])),added:Object.fromEntries(Object.entries(after).filter(([k])=>!(k in before)))},queries:[],commits:[],lines:{product:{added:0,deleted:0},tests:{added:0,deleted:0},snapshot:{added:0,deleted:0},docs:{added:0,deleted:0}}};
for(const args of [
 ['-n','credentialNames|controlNames|netrc|npmrc|pypirc|git-credentials','packages/assistant/src/directory-access.ts','packages/assistant/src/modules/seatbelt-policy.ts','packages/assistant/src/modules/seatbelt-runtime.ts'],
 ['-n','TuiModuleConfigV1|tuiModuleConfigV1Schema','packages/assistant/src','apps/desktop/src','apps/cli/src'],
 ['-n','(config|moduleConfig)[?]?[.]authorizedDirectory\\b','packages/assistant/src','apps/desktop/src','apps/cli/src'],
 ]) { const r=spawnSync('rg',args,{cwd:repo,encoding:'utf8'}); report.queries.push({command:['rg',...args],exitCode:r.status,output:r.stdout}); }
for(const line of git(['diff','--numstat','dc64781']).split('\n').filter(Boolean)) {
 const [add,del,file]=line.split('\t'); let group='product';
 if(file===snapshot)group='snapshot';else if(file.startsWith('docs/'))group='docs';else if(/\.test\.|acceptance|\/scripts\/(?!config-upgrade\.mjs$|home-import\.mjs$)|^scripts\//.test(file))group='tests';
 report.lines[group].added+=Number(add);report.lines[group].deleted+=Number(del);
}
for(const sha of git(['rev-list','--reverse','dc64781..HEAD']).split('\n')) {
 const rows=git(['show','--format=','--numstat',sha]).split('\n').filter(Boolean).map(row=>row.split('\t'));
 report.commits.push({sha,subject:git(['show','-s','--format=%s',sha]),added:rows.reduce((n,r)=>n+Number(r[0]),0),deleted:rows.reduce((n,r)=>n+Number(r[1]),0)});
}
report.frozenSmokeSha256=createHash('sha256').update(await readFile(`${repo}/apps/desktop/scripts/electron-smoke.mjs`)).digest('hex');
assert.equal(report.frozenDiff,'');assert.deepEqual(report.snapshot.changedOriginal,[]);assert.deepEqual(report.snapshot.changedReviewed,[]);
await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({lines:report.lines,snapshot:report.snapshot,commits:report.commits}));
