from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re,shutil,subprocess,uuid
repo=Path('/Users/a1-6/Code/agents/serika-chat-run-target')
r2=Path('/private/tmp/serika-197-stage1-feature-r2')
feature=json.loads((r2/'result.json').read_text())
out=repo/'docs/v2-pilot/evidence/chat-run-target'/('stage1-'+feature['runId'][:8]); out.mkdir(exist_ok=False)
sha=lambda b:hashlib.sha256(b).hexdigest()
for name,source in [('feature-first-failed',Path('/private/tmp/serika-197-stage1-feature')),('feature-r2',r2),('offline',Path('/private/tmp/serika-197-stage1-final-offline')),('shell-native',Path('/private/tmp/serika-197-shell-final'))]: shutil.copytree(source,out/name)
standard=Path('/private/tmp/serika-197-stage1-standard'); target=out/'standard';target.mkdir()
for p in standard.iterdir():
 if p.is_file(): shutil.copy2(p,target/p.name)
logs={'feature-first-failed.log':'/tmp/serika-197-feature.log','feature-r2.log':'/tmp/serika-197-feature-r2.log','selection-expected-failure.log':'/tmp/serika-197-selection-repro.log','targeted.log':'/tmp/serika-197-targeted4.log','last-targeted.log':'/tmp/serika-197-last-targeted.log','tg-targeted.log':'/tmp/serika-197-tg-targeted3.log','observer-unit.log':'/tmp/serika-197-observer-final.log','live-zero-request-preflight.json':'/tmp/serika-197-live-final-preflight.log','build.log':'/tmp/serika-197-desktop-feature-r2-build.log'}
for name,path in logs.items(): shutil.copy2(path,out/name)
shutil.copy2('/private/tmp/serika-197-stage1-trail/decisions.tsv',out/'decisions.tsv')
shutil.copy2('/private/tmp/serika-197-stage1-trail/run-standard.py',out/'run-standard.py')
shutil.copy2(__file__,out/'collect.py')
guards=[]
for name in ['feature-first-failed.log','feature-r2.log','tg-targeted.log','offline/full-test.log','standard/run.log']:
 for line in (out/name).read_text().splitlines():
  if not line.startswith('{'): continue
  try: row=json.loads(line)
  except json.JSONDecodeError: continue
  if 'testHomeGuard' in row:
   guards.append({k:row[k] for k in ['testHomeGuard','violations','changes','metadataUnchanged']})
   if row.get('evidence') and Path(row['evidence']).is_file(): guards[-1]['originalSha256']=sha(Path(row['evidence']).read_bytes())
summary={'id':str(uuid.uuid4()),'createdAt':datetime.now(timezone.utc).isoformat(),'scope':'stage1-offline-gates-only; real-model-approval-pending','realModelCalls':feature['realModelCalls'],'costUsd':feature['costUsd'],'offline':json.loads((out/'offline/result.json').read_text()),'feature':{k:feature[k] for k in ['runId','status','sourceCommit','sourceWorktreeDirty','realModelCalls','costUsd']},'featureChecks':[{k:v for k,v in row.items() if k in ['name','result','runId']} for row in feature['checks']],'firstFeatureStatus':json.loads((out/'feature-first-failed/result.json').read_text())['status'],'standard':json.loads((out/'standard/result.json').read_text())['status'],'shellNative':json.loads((out/'shell-native/result.json').read_text())['status'],'guards':guards}
for dir in ['feature-first-failed','feature-r2','standard']:
 raw=json.loads((out/dir/'result.json').read_text())
 for image in raw['screenshots']: assert sha((out/dir/image['file']).read_bytes())==image['sha256']
summary['sourceDiffAfterFullTests']=subprocess.check_output(['git','diff','--stat',summary['offline']['sourceCommit'],'HEAD'],cwd=repo,text=True)
summary['counts']={'product':{'added':0,'deleted':0},'test':{'added':0,'deleted':0}}
for line in subprocess.check_output(['git','diff','71f9c3d','HEAD','--numstat'],cwd=repo,text=True).splitlines():
 add,delete,path=line.split('\t')
 if path.startswith('docs/'):continue
 kind='product' if path.endswith(('.ts','.tsx')) and '.test.' not in path and not path.endswith('smoke-model.ts') else 'test'
 summary['counts'][kind]['added']+=int(add);summary['counts'][kind]['deleted']+=int(delete)
summary['files']={str(p.relative_to(out)):sha(p.read_bytes()) for p in out.rglob('*') if p.is_file()}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(out),'counts':summary['counts'],'firstFeatureStatus':summary['firstFeatureStatus'],'featureStatus':summary['feature']['status'],'standard':summary['standard'],'files':len(summary['files'])}))
