from pathlib import Path
import subprocess,hashlib,json,re,uuid,datetime,sys
repo=Path('/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework')
work=Path('/private/tmp/serika-cutover-tools-work')
out=work/'delivery';out.mkdir(exist_ok=True)
def git(*args): return subprocess.check_output(['git',*args],cwd=repo)
def sha(b): return hashlib.sha256(b).hexdigest()
assert not git('status','--porcelain').strip()
base='bb409fc';head=git('rev-parse','HEAD').decode().strip()
paths=['packages/assistant/src/permission-boundary.snapshot.json','packages/assistant/src/permission-decisions.snapshot.ts','apps/desktop/scripts/electron-smoke.mjs','examples/eval/cm-step6-live.mjs']
frozen={}
for path in paths:
    old=git('show',base+':'+path);new=(repo/path).read_bytes();assert old==new,path
    frozen[path]={'baselineSha256':sha(old),'sourceSha256':sha(new),'byteIdentical':True}
b0=paths[0];old=json.loads(git('show','bb5c6e6:'+b0));current=json.loads((repo/b0).read_bytes())
changed=[key for key in old.keys()|current.keys() if old.get(key)!=current.get(key)]
assert changed==['desktop/shell_exec'],changed
def row_bytes(data):
    match=re.search(rb'^  "telegram/shell_exec": \{\n.*?^  \},\n',data,re.M|re.S)
    assert match
    return match.group(0).rstrip(b'\n')
old_row=row_bytes(git('show','bb5c6e6:'+b0));new_row=row_bytes((repo/b0).read_bytes())
assert old_row==new_row
changes=[];totals={key:{'added':0,'removed':0,'net':0} for key in ['product','migration','tests','docs']}
for line in git('diff','--numstat',base,head).decode().splitlines():
    added,removed,path=line.split('\t');added=int(added);removed=int(removed)
    kind='docs' if path.startswith('docs/') else 'tests' if '.test.' in path else 'migration' if path.startswith('packages/assistant/scripts/') else 'product'
    changes.append({'path':path,'category':kind,'added':added,'removed':removed,'net':added-removed})
    for key,val in [('added',added),('removed',removed),('net',added-removed)]:totals[kind][key]+=val
assert len(changes)==5
runbook='docs/v2-pilot/cutover-runbook.md';diff=git('diff','--no-ext-diff',base,head,'--',runbook)
(out/'cutover-runbook.diff').write_bytes(diff)
report={'runId':str(uuid.uuid4()),'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'sourceCommit':head,'sourceWorktreeDirty':False,'baselineCommit':git('rev-parse',base).decode().strip(),
 'frozenFiles':frozen,'b0ChangesFromS0':changed,'telegramRow':{'byteIdenticalToB0':True,'bytes':len(new_row),'sha256':sha(new_row)},
 'lineChanges':changes,'totals':totals,
 'runbook':{'beforeSha256':sha(git('show',base+':'+runbook)),'afterSha256':sha((repo/runbook).read_bytes()),'completeDiffSha256':sha(diff)},
 'sourceHashes':{item['path']:sha((repo/item['path']).read_bytes()) for item in changes},
 'targetedLogs':{name:sha((work/name).read_bytes()) for name in ['targeted-1.log','targeted-2.log']},
 'runbookCheck':json.loads((work/'runbook-check/result.json').read_text())}
(out/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sourceCommit':head,'totals':totals,'frozenFilesUnchanged':True,'b0ChangesFromS0':changed}))
