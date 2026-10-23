import hashlib,json,re,shutil,subprocess,sys,uuid,shlex
from datetime import datetime,timezone
from pathlib import Path
repo=Path(sys.argv[1]).resolve(); source=Path('/private/tmp/serika-v2-round3'); target=repo/'docs/v2-pilot/evidence/v2-round3'
audit=json.loads((source/'audit-final/audit.json').read_text()); verified=json.loads((source/'unified-final/docs/v2-pilot/evidence/cm-step6/verification.json').read_text())
assert audit['status']==verified['status']=='passed'
assert audit['sourceCommit']==verified['sourceCommit']
assert verified['sourceStayedCleanDuringVerification']
assert all(c['exitCode']==0 for c in verified['commands'])
assert not target.exists()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
target.mkdir(parents=True)
shutil.copytree(source/'audit-final',target/'audit');shutil.copytree(source/'audit-first',target/'audit-first');shutil.copytree(source/'unified-final',target/'unified')
excluded=['cm-step6/live.json','electron-smoke/README.md','electron-smoke/cm-step4-original-result.json','electron-smoke/cm-step5-run.json','electron-smoke/verification.json']
for f in excluded:(target/'unified/docs/v2-pilot/evidence'/f).unlink()
for f in ['baseline.json','b0-capture.json','run.mjs','tasks.md','decisions.tsv','development-commands.md','type-initial.log','type.log','type-fixed.log','b0-capture.log','core-initial.log','build.log','core-fixed.log','tg-read.log','b0-final.log','audit-initial.log','audit-final.log','audit-first.log','unified-first-aborted.log','unified-first-aborted.json','copy-typecheck.log','packaging-initial.json','unified-final.log']:
    shutil.copy2(source/f,target/f)
for name in ['browser','computer']:
    src=Path(f'/private/tmp/serika-v2-round3-{name}-evidence');dest=target/name;dest.mkdir()
    for f in src.iterdir():
        if f.is_file() and (f.suffix in ['.log','.mjs'] or f.name=='herdr-sources.md' or f.suffix=='.json' and f.name!='herdr-tree.json'):shutil.copy2(f,dest/f.name)
shutil.copy2(Path(__file__),target/'package-evidence.py')
secret_pattern=re.compile(r'(?:\bsk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}|-----BEGIN [^-]*PRIVATE KEY-----)')
hits=[];whitespace=[]
for f in target.rglob('*'):
    if not f.is_file() or f.suffix not in ['.log','.json','.md','.mjs','.py','.tsv']:continue
    text=f.read_text()
    if secret_pattern.search(text):hits.append(str(f.relative_to(target)))
    whitespace += [{'file':str(f.relative_to(target)),'line':i} for i,l in enumerate(text.splitlines(),1) if l.rstrip(' \t')!=l]
assert not hits, 'Credential pattern matched; inspect locally without printing contents'
(target/'package-checks.json').write_text(json.dumps({'credentialPatternFiles':hits,'scan':'known credential formats only','preservedWhitespaceLines':whitespace},indent=2)+'\n')
lines={}
for row in audit['lineChanges']:
    count=lines.setdefault(row['kind'],[0,0]);count[0]+=row['added'];count[1]+=row['removed']
table='| 类别 | 新增 | 删除 | 净增 |\n|---|---:|---:|---:|\n'+'\n'.join(f'| {k} | {v[0]} | {v[1]} | {v[0]-v[1]:+} |' for k,v in lines.items())
rows='| 新增快照行 | 审批 |\n|---|---|\n'+'\n'.join(f'| `{key}` | '+('免逐条确认' if '/herdr_pi_read/' in key else '每次确认，不可记住')+' |' for key in audit['b0']['addedKeys'])
commands='| 命令 | 退出码 / 结果 |\n|---|---|\n| `node packages/assistant/scripts/v2-round3-verify.mjs --home /private/tmp/serika-v2-round3-audit-H --output /private/tmp/serika-v2-round3/audit-final` | 0 |'
for label,report in [('本轮审计内部',audit),('冻结统一验证内部',verified)]:
    for c in report['commands']:
        counts={}
        for k,v in c.get('counts',[]):counts[k]=counts.get(k,0)+v
        commands+='\n| '+label+' `'+ shlex.join(c['command'])+'` | '+str(c['exitCode'])+('; '+', '.join(f'{k}={v}' for k,v in counts.items()) if counts else '')+' |'
commands+='\n| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round3/unified-final node /private/tmp/serika-v2-round3/run.mjs --home /private/tmp/serika-v2-round3/unified-H node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round3/unified-H` | 0 |'
deviations='开发期间的失败均保留或明确标记缺失：初次集成 typecheck 因 client 尚未落盘和工具返回类型推断退出 2；b0 捕获在追加前按预期退出 1；Herdr Controller 测试误用非法 remember 导致等待，终止后修正测试，产品规则未变；首次审计 home 前缀不符退出 1，改命令后通过。Computer 独立树曾解析到旧依赖导出；Herdr 假脚本换行、类型穷尽与 AgentError 断言修复后重跑通过。首份通过的审计之后发现 Herdr UI 仍写读取需确认，主动中止已启动的统一验证并更正文案；首次统一运行仅记录 SIGTERM，不计为通过。最终源码重新跑审计及冻结统一验证。完整命令和失败记录见 development-commands.md、browser/herdr-sources.md 与原始日志。Computer renderer 测试首次错误 cwd 的日志被覆盖，该次只有工具退出记录，未伪称原始日志存在。首次证据打包的凭据扫描把 task- 路径内的 sk- 子串误报，退出 1；核实 10 处均为追踪文件路径后增加词边界，原始报告字节未改，重新打包退出 0。'
values={'SOURCE_COMMIT':audit['sourceCommit'],'NEW_ROWS':rows,'B0_HASH':audit['b0']['afterSha256'],'LINE_TABLE':table,'COMMAND_TABLE':commands,'UNIFIED_RESULT':'退出 0；干净源码、UTC/Asia/Shanghai 全套、离线 eval、冻结 Electron 冒烟 8/8 与 offline audit 均通过','AUDIT_HASH':sha(target/'audit/audit.json'),'UNIFIED_HASH':sha(target/'unified/docs/v2-pilot/evidence/cm-step6/verification.json'),'DEVIATIONS':deviations,'DIFF_CHECK_RESULT':'源码 `git diff f638f46 '+audit['sourceCommit']+' --check` 退出 0。原始框架日志的空行末尾空白保持原字节，具体位置见 package-checks.json。' if whitespace else '源码与证据 diff check 退出 0。'}
text=(source/'report-draft.md').read_text()
for k,v in values.items():text=text.replace(k,v)
(repo/'docs/v2-pilot/v2-round3.md').write_text(text)
files=[{'path':str(p.relative_to(target)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(target.rglob('*')) if p.is_file()]
manifest={'runId':str(uuid.uuid4()),'generatedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':audit['sourceCommit'],'auditRunId':audit['runId'],'verificationRunId':verified['runId'],'excludedInheritedFiles':excluded,'files':files}
(target/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'files':len(files),'lineCounts':lines,'manifestSha256':sha(target/'manifest.json'),'whitespaceLines':len(whitespace)}))
