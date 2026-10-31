import os, sys, json, uuid, hashlib, subprocess, datetime
from pathlib import Path
root=Path(__file__).parent
repo='/Users/a1-6/Code/agents/serika-chat-run-target'
phases={
 'targeted-runtime':['node','--test','--test-concurrency=4','packages/assistant/dist/foreground-herdr.test.js','packages/assistant/dist/herdr-control.test.js','packages/assistant/dist/permission-boundary.test.js','packages/ai-sdk-adapter/dist/loop.test.js'],
 'targeted-desktop-tg':['pnpm','--filter','@serika/desktop','exec','tsx','--test','src/main/telegram-gateway.test.ts','src/main/telegram-herdr-selection.test.ts'],
 'full-test':['pnpm','test'],
 'build':['pnpm','build'],
 'feature-electron':['node','apps/desktop/scripts/chat-run-target-smoke.mjs','--output',str(root/'feature-electron')],
 'standard-electron':['pnpm','--filter','@serika/desktop','smoke']}
phase=sys.argv[1]
result_path=root/'commands.json'
rows=json.loads(result_path.read_text()) if result_path.exists() else []
assert not any(row.get('exitCode') != 0 for row in rows), 'a previous gate failed; stop'
env={k:v for k,v in os.environ.items() if k in ['PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SHELL']}
env['SERIKA_B2_RECORD_CONCURRENT_HOME']='1'
command=['node','scripts/test-home.mjs','--home',str(root/'home'), '--'] + phases[phase]
row={'verificationId':str(uuid.uuid4()),'phase':phase,'command':command,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'realModelRequests':0,'costUsd':0,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()}
log=root/(phase+'.log')
with log.open('w') as stream:
 code=subprocess.call(command,cwd=repo,env=env,stdout=stream,stderr=subprocess.STDOUT)
row.update(exitCode=code,finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),log=log.name,logSha256=hashlib.sha256(log.read_bytes()).hexdigest())
rows.append(row)
result_path.write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps(row))
print('\n'.join(log.read_text().splitlines()[-12:]))
sys.exit(code)
