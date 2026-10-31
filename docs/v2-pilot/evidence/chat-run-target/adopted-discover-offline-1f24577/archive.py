import hashlib
import json
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

root = Path('/Users/a1-6/Code/agents/serika-pi-adopted-discover')
dest = root/'docs/v2-pilot/evidence/chat-run-target/adopted-discover-offline-1f24577'
assert not (dest/'verification.json').exists()
smoke = root/'docs/v2-pilot/evidence/electron-smoke'
s = json.loads((smoke/'result.json').read_text())
assert s['status'] == 'passed' and not s['sourceWorktreeDirty'] and len(s['checks']) == 8
assert s['realModelCalls'] == 0 and s['costUsd'] == 0
assert s['sourceCommit'].startswith('1f24577')
assert not subprocess.check_output(['git','diff',s['sourceCommit'],'--','packages','apps/desktop/src'],cwd=root)
gate = Path('/private/tmp/s197-followup-final-gate')
g = json.loads((gate/'result.json').read_text())
assert g['status'] == 'passed' and len(g['checks']) == 8
full = Path('/private/tmp/s197-followup-full.log').read_text()
metrics = {k:[int(v) for v in re.findall(r'^ℹ '+k+r' (\d+)$',full,re.M)] for k in ['tests','pass','fail','cancelled','skipped']}
totals = {k:sum(v) for k,v in metrics.items()}
assert totals == {'tests':1913,'pass':1906,'fail':0,'cancelled':0,'skipped':7}
assert len(metrics['tests']) == 3
assert not re.search(r'^✖',full,re.M)
manifest=[]
def copy(src, path):
    path.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(src,path)
    digest=hashlib.sha256(src.read_bytes()).hexdigest()
    assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
    manifest.append({'path':str(path.relative_to(dest)),'source':str(src),'sha256':digest,'bytes':src.stat().st_size})
for f in smoke.iterdir():
    if f.is_file():copy(f,dest/'standard-electron'/f.name)
for f in gate.iterdir():
    if f.is_file():copy(f,dest/'real-herdr-fake-telegram'/f.name)
log_names=['host-red','host-red-2','host-red-3','host-red-4','green','green-2','status','full','smoke','smoke-download-failed','gate','final-gate']
for name in log_names:
    f=Path('/private/tmp/s197-followup-'+name+'.log')
    if f.exists():copy(f,dest/'logs'/f.name)
copy(Path(__file__),dest/'archive.py')
for name in ['electron-runtime','smoke-download-failed-result']:
    f=Path('/private/tmp/s197-followup-'+name+'.json')
    if f.exists():copy(f,dest/'preparation'/f.name)
guard=[]
for name in ['green-2','status','full','smoke','final-gate']:
    content=Path('/private/tmp/s197-followup-'+name+'.log').read_text()
    for line in content.splitlines():
        if not line.startswith('{"testHomeGuard":'):continue
        summary=json.loads(line)
        if not summary['evidence'].startswith('/private/tmp/s197-followup-'):continue
        if summary['testHomeGuard'] != 'passed': raise AssertionError(summary)
        raw=json.loads(Path(summary['evidence']).read_text())
        assert not raw['violations']
        guard.append({'log':name,'runId':raw['runId'],'status':raw['status'],'exitCode':raw['exitCode'],'violations':0,'changes':len(raw['events']),'recordConcurrentChanges':raw['recordConcurrentChanges'],'metadataUnchanged':raw['metadataUnchanged']})
products=subprocess.check_output(['git','diff','--name-only','origin/main...HEAD','--','packages'],cwd=root,text=True).splitlines()
hashes={f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in products}
patterns=[rb'\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b',rb'\bsk-[A-Za-z0-9_-]{20,}\b']
hits=[str(f.relative_to(dest)) for f in dest.rglob('*') if f.is_file() and any(re.search(p,f.read_bytes()) for p in patterns)]
assert not hits,hits
report={'auditId':str(uuid.uuid4()),'auditedAt':datetime.now(timezone.utc).isoformat(),'verification':'offline-artifact-audit','status':'passed','sourceCommit':s['sourceCommit'],'sourceHashes':hashes,
    'scope':'Separate adopted-discover follow-up; PR197 already merged as desktop-only acceptance. Real Telegram remains unverified.',
    'fullTests':{'command':'SERIKA_B2_RECORD_CONCURRENT_HOME=1 SERIKA_TEST_HOME=/private/tmp/s197-followup-full-home pnpm test','exitCode':0,'suiteMetrics':metrics,'totals':totals},
    'standardElectron':{'exitCode':0,'checks':len(s['checks']),'sourceWorktreeDirty':s['sourceWorktreeDirty'],'scriptSha256':s['scriptSha256']},
    'realHerdrFakeTelegram':{'exitCode':0,'checks':len(g['checks']),'sourceWorktreeDirty':g.get('sourceWorktreeDirty')},
    'redRegression':{'adapterCommit':'f6e4635','hostCommit':'905b59c','validHostLog':'logs/s197-followup-host-red-4.log','hostFailure':"'failed' != 'completed' at both desktop and telegram host fixtures",'fixedStatusLog':'logs/s197-followup-status.log','fixedCases':2},
    'earlierAttempts':'host-red and host-red-2 cancelled on an unreferenced mock-host event loop; host-red-3 has one valid failure and one cancellation. Test fixture now keeps the embedding host alive until its original result. green log stopped when the default guard reacted to concurrent daily metadata; subsequent runs use the existing concurrent-record mode, retaining filesystem write protection. First smoke stopped during a dependency binary download before app launch; original script then reran with the existing locked Electron 44.4.5 runtime, read-only. Original logs retained.',
    'guards':guard,'realModelRequests':0,'realTelegramRequests':0,'amountUsd':0,'dailyOperation':'No stop, restart, Bot takeover, deployment or day-use switch. Concurrent metadata changes are recorded, never claimed unchanged.',
    'credentialPrefixMatches':hits,'originalFiles':manifest}
(dest/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(dest),'status':'passed','files':len(manifest),'fullTests':totals,'electronChecks':len(s['checks']),'gateChecks':len(g['checks']),'realModelRequests':0,'realTelegramRequests':0},ensure_ascii=False))
