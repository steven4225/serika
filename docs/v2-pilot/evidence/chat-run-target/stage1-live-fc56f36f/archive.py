from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,shutil,subprocess,uuid
repo=Path('/Users/a1-6/Code/agents/serika-chat-run-target')
source=Path('/private/tmp/serika-197-stage1-live-c')
raw=json.loads((source/'result.json').read_text())
audit=json.loads((source/'stop-audit.json').read_text())
out=repo/'docs/v2-pilot/evidence/chat-run-target'/('stage1-live-'+raw['runId'][:8])
out.mkdir(exist_ok=False)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for path in source.iterdir():
 if path.is_file():shutil.copy2(path,out/path.name)
shutil.copy2('/private/tmp/serika-197-stage1-live-c.log',out/'run.log')
shutil.copy2(__file__,out/'archive.py')
script=subprocess.check_output(['git','show',raw['sourceCommit']+':apps/desktop/scripts/chat-run-target-live.mjs'],cwd=repo)
assert hashlib.sha256(script).hexdigest()==raw['scriptSha256']
for img in raw['screenshots']:assert sha(out/img['file'])==img['sha256']
for path in source.iterdir():
 if path.is_file():assert sha(path)==sha(out/path.name)
guards=[]
for line in (out/'run.log').read_text().splitlines():
 try:r=json.loads(line)
 except json.JSONDecodeError:continue
 if 'testHomeGuard' in r:
  summary={k:r[k] for k in ['testHomeGuard','violations','changes','metadataUnchanged']}
  summary['originalSha256']=sha(Path(r['evidence']));guards.append(summary)
summary={'id':str(uuid.uuid4()),'archivedAt':datetime.now(timezone.utc).isoformat(),'sourceRunId':raw['runId'],
 'sourceCommit':raw['sourceCommit'],'sourceWorktreeDirty':raw['sourceWorktreeDirty'],
 'rawHarnessStatus':raw['status'],'auditedAcceptance':audit['acceptance'],'failureStopGate':audit['failureStopGate'],
 'realModelRequests':audit['realModelRequests'],'taskRuns':audit['taskRuns'],'callers':{caller:sum(call['caller']==caller for call in raw['calls']) for caller in ['serika','pi']},
 'amount':audit['amount'],'amountBasis':audit['amountBasis'],'guards':guards,
 'sourceResultSha256':sha(source/'result.json'),'originalResultUnmodified':True,
 'files':{p.name:sha(p) for p in sorted(out.iterdir()) if p.is_file()}}
(out/'archive-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
ledger=repo/'docs/v2-pilot/evidence/cost-ledger.json';d=json.loads(ledger.read_text())
assert all(e.get('runId')!=raw['runId'] for e in d['entries'])
d['entries'].append({'step':'chat-run-target-stage1','runId':raw['runId'],'realModelRequests':audit['realModelRequests'],
 'taskRuns':audit['taskRuns'],'amount':audit['amount'],'amountBasis':audit['amountBasis'],
 'authorizedBatchCapUsd':raw['capUsd'],'authorizedBatchMaxRequests':raw['maxRequests'],'authorizedBatchMaxRuns':raw['maxRuns'],
 'unresolvedCalls':0,'unresolvedReservedUsd':0,'evidence':str((out/'result.json').relative_to(ledger.parent)),
 'evidenceSha256':sha(out/'result.json'),'acceptance':audit['acceptance'],
 'audit':str((out/'stop-audit.json').relative_to(ledger.parent))})
d['knownTotal']+=audit['amount'];d['total']+=audit['amount'];ledger.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(out),'files':len(summary['files']),'rawHarnessStatus':raw['status'],'auditedAcceptance':audit['acceptance'],'guards':guards}))
