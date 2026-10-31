from pathlib import Path
import hashlib, json, os, shutil, subprocess, uuid
from datetime import datetime, timezone
repo=Path('/Users/a1-6/Code/agents/serika-chat-run-target')
evidence=repo/'docs/v2-pilot/evidence/electron-smoke'
out=Path('/private/tmp/serika-197-stage1-standard'); out.mkdir(exist_ok=False)
backup=out/'original-top-files'; backup.mkdir()
names=[p.name for p in evidence.iterdir() if p.is_file()]
for name in names: shutil.copy2(evidence/name, backup/name)
os.environ['SERIKA_TEST_HOME']='/private/tmp/serika-197-standard-guard'
os.environ['SERIKA_B2_RECORD_CONCURRENT_HOME']='1'
report={'id':str(uuid.uuid4()), 'startedAt':datetime.now(timezone.utc).isoformat(), 'status':'failed'}
try:
 with (out/'run.log').open('wb') as log:
  report['exitCode']=subprocess.run(['pnpm','--filter','@serika/desktop','smoke'], cwd=repo, stdout=log, stderr=subprocess.STDOUT).returncode
 raw=json.loads((evidence/'result.json').read_text())
 files=['result.json','home-fixture.json']+[row['file'] for row in raw['screenshots']]
 for name in files: shutil.copy2(evidence/name,out/name)
 report['files']={name:hashlib.sha256((out/name).read_bytes()).hexdigest() for name in files}
 report['status']='passed' if report['exitCode']==0 and raw['status']=='passed' else 'failed'
finally:
 for p in evidence.iterdir():
  if p.is_file() and p.name not in names: p.unlink()
 for name in names: shutil.copy2(backup/name,evidence/name)
 report['originalTopFilesRestored']=all((evidence/name).read_bytes()==(backup/name).read_bytes() for name in names)
 report['finishedAt']=datetime.now(timezone.utc).isoformat()
 (out/'wrapper.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'output':str(out),'status':report['status'],'exitCode':report.get('exitCode')}))
raise SystemExit(report.get('exitCode',1))
