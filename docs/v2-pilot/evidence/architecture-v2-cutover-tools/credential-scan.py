from pathlib import Path
import re,json,uuid,datetime
root=Path('/private/tmp/serika-cutover-tools-work/delivery')
pattern=re.compile(r'(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})')
files=[];hits=[]
for path in sorted(root.rglob('*')):
    if path.is_file() and path.suffix in ['.json','.log','.diff','.py']:
        files.append(str(path.relative_to(root)))
        for match in pattern.finditer(path.read_text()): hits.append({'file':str(path.relative_to(root)),'line':path.read_text()[:match.start()].count('\n')+1})
assert not hits,'Credential-like prefix found; inspect privately'
(root/'credential-scan.json').write_text(json.dumps({'runId':str(uuid.uuid4()),'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed','files':files,'credentialLikeHits':hits,'initialSubstringFalsePositives':10,'initialFalsePositiveKind':'task filenames and work-task lock paths; corrected with token boundary'},indent=2)+'\n')
print(json.dumps({'status':'passed','files':len(files),'credentialLikeHits':0}))
