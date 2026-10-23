import re,subprocess,pathlib,json,os
repo=pathlib.Path('/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework')
work=pathlib.Path('/private/tmp/serika-cutover-tools-work/runbook-check');work.mkdir(exist_ok=True)
s=(repo/'docs/v2-pilot/cutover-runbook.md').read_text()
checks=[]
for i,block in enumerate(re.findall(r'```sh\n(.*?)```',s,re.S)):
    file=work/f'block-{i}.sh';file.write_text(block)
    r=subprocess.run(['/bin/sh','-n',str(file),'--home',str(work/'H')],capture_output=True,text=True)
    checks.append({'check':f'shell-{i}','exitCode':r.returncode});assert r.returncode==0,r.stderr
    for j,js in enumerate(re.findall(r"<<'JS'\n(.*?)\nJS",block,re.S)):
        file=work/f'block-{i}-{j}.mjs';file.write_text(js)
        r=subprocess.run(['node','--check',str(file),'--home',str(work/'H')],capture_output=True,text=True)
        checks.append({'check':f'js-{i}-{j}','exitCode':r.returncode});assert r.returncode==0,r.stderr
        if "const launcher=" in js:
            release=work/"release with 'quote";release.mkdir(exist_ok=True)
            r=subprocess.run(['node',str(file),'--home',str(work/'H'),str(release)],capture_output=True,text=True)
            checks.append({'check':'generate-only-launcher-in-temporary-directory','exitCode':r.returncode});assert r.returncode==0,r.stderr
            for cmd in [['node','--check',str(release/'launch-serika.mjs'),'--home',str(work/'H')],['/bin/sh','-n',str(release/'Serika.command'),'--home',str(work/'H')]]:
                r=subprocess.run(cmd,capture_output=True,text=True);checks.append({'check':'generated-launcher-syntax','exitCode':r.returncode});assert r.returncode==0,r.stderr
            expected=str(release/'launch-serika.mjs')
            # Check the shell's argument quoting by replacing exec with printf, never launching Node/Electron.
            shell=(release/'Serika.command').read_text().replace('exec ',"printf '%s\\n' ")
            r=subprocess.run(['/bin/sh','-c',shell,'--home',str(work/'H')],capture_output=True,text=True)
            assert r.returncode==0 and r.stdout.splitlines()[1]==expected,r.stdout
            checks.append({'check':'quoted-release-path','exitCode':r.returncode})
(work/'result.json').write_text(json.dumps({'checks':checks,'productProcessesStarted':0,'dailyPathsAccessed':False},indent=2)+'\n')
print(json.dumps({'checks':len(checks),'status':'passed'}))
