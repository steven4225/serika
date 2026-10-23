import hashlib
import json
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
source = Path('/private/tmp/serika-v2-round2')
target = repo / 'docs/v2-pilot/evidence/v2-round2'
audit = json.loads((source / 'audit-final/audit.json').read_text())
verification = json.loads((source / 'unified-final/docs/v2-pilot/evidence/cm-step6/verification.json').read_text())
assert audit['status'] == verification['status'] == 'passed'
assert audit['sourceCommit'] == verification['sourceCommit']
assert verification['sourceStayedCleanDuringVerification'] is True
assert all(row['exitCode'] == 0 for row in verification['commands'])
assert not target.exists()
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
target.mkdir(parents=True)
shutil.copytree(source / 'audit-final', target / 'audit')
shutil.copytree(source / 'audit-first', target / 'audit-first')
shutil.copytree(source / 'unified-first-failure', target / 'unified-first-failure')
shutil.copytree(source / 'unified-final', target / 'unified')
inherited_files = ['cm-step6/live.json', 'electron-smoke/README.md',
    'electron-smoke/cm-step4-original-result.json', 'electron-smoke/cm-step5-run.json', 'electron-smoke/verification.json']
for name in inherited_files:
    (target / 'unified/docs/v2-pilot/evidence' / name).unlink()
for name in ['baseline.json', 'b0-capture.json', 'run.mjs', 'audit-final.log', 'unified-final.log',
             'unified-first-failure.log', 'audit-first.log', 'config-fix.log', 'development-commands.md', 'permission-capture.log', 'core-tests.log', 'core-tests2.log', 'core-tests3.log', 'core-tests4.log', 'build-core.log']:
    shutil.copy2(source / name, target / name)
for category, directory in [('tg', Path('/private/tmp/serika-v2-round2-tg-evidence')), ('desktop', Path('/private/tmp/serika-v2-round2-desktop-evidence'))]:
    (target / category).mkdir()
    for path in directory.iterdir():
        if path.is_file() and path.suffix in ['.log', '.mjs']:
            shutil.copy2(path, target / category / path.name)
shutil.copy2(Path(__file__), target / 'package-evidence.py')

whitespace = []
for path in target.rglob('*'):
    if path.is_file() and path.suffix in ['.log', '.json', '.mjs', '.py']:
        for index, line in enumerate(path.read_text().splitlines(), 1):
            if line.rstrip(' \t') != line:
                whitespace.append({'path': str(path.relative_to(target)), 'line': index})
code_check = subprocess.run(['git', 'diff', audit['baseline'], audit['sourceCommit'], '--check'], cwd=repo, capture_output=True, text=True)
assert code_check.returncode == 0
scan = []
pattern = re.compile(rb'(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|[0-9]{8,12}:AA[A-Za-z0-9_-]{25,})(?![A-Za-z0-9_-])')
for path in target.rglob('*'):
    if path.is_file() and path.suffix != '.png' and pattern.search(path.read_bytes()):
        scan.append(str(path.relative_to(target)))
assert not scan, f'Credential-shaped token detected in {scan}'
package_run = {'runId': str(uuid.uuid4()), 'generatedAt': datetime.now(timezone.utc).isoformat(),
    'sourceCommit': audit['sourceCommit'], 'sourceDiffCheckExitCode': code_check.returncode,
    'credentialPatternMatches': scan, 'trailingWhitespace': whitespace}
(target / 'package-checks.json').write_text(json.dumps(package_run, indent=2) + '\n')

table = '| 类别 | 新增 | 删除 | 净行数 |\n|---|---:|---:|---:|'
for kind, label in [('product', '产品'), ('tests-verification', '测试/验证'), ('snapshot', 'b0 快照，单列')]:
    rows = [row for row in audit['lineChanges'] if row['kind'] == kind]
    added, removed = sum(row['added'] for row in rows), sum(row['removed'] for row in rows)
    table += f'\n| {label} | +{added} | -{removed} | {added-removed:+} |'
commands = '| 实际命令 | 退出码与结果 |\n|---|---|'
commands += '\n| `node packages/assistant/scripts/v2-round2-verify.mjs --home /private/tmp/serika-v2-round2-audit2-H --output /private/tmp/serika-v2-round2/audit-final` | 0，类型检查/构建、核心定向 81/81、桌面/TG 定向 148/148 |'
commands += '\n| `node /private/tmp/serika-v2-round2-tg-evidence/run.mjs --home <temporary> ...`，TG 回归红→绿→完整 gateway | 1 → 0 → 0；红 3 pass/12 fail，绿 15/15，完整 80/80 |'
commands += '\n| `node /private/tmp/serika-v2-round2/run.mjs --home <temporary> /bin/sh -c ...`，root 核心开发测试 | core-tests、core-tests2 退出 1；core-tests3 退出 0，25/25+30/30；core-tests4 退出 0，26/26。完整命令见开发记录 |'
commands += '\n| 首次统一验证，源码 `e4aa769` | 1，UTC runtime 1136 pass/2 fail/7 skip；最终修正前的失败，整体未通过 |'
commands += '\n| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round2/unified-final node /private/tmp/serika-v2-round2/run.mjs --home /private/tmp/serika-v2-round2/unified2-H node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round2/unified2-H` | 0，统一验证通过 |'
for row in verification['commands']:
    command = ' '.join(row['command'])
    totals = {key: sum(value for name, value in row['counts'] if name == key) for key in ['tests', 'pass', 'fail', 'skipped']}
    counts = ', '.join(f'{key}={value}' for key, value in totals.items()) if row['counts'] else ''
    commands += f'\n| 统一内部 `{command}` | {row["exitCode"]}' + (f'，{counts}' if counts else '') + ' |'
text = (source / 'report-draft.md').read_text()
values = {'SOURCE_COMMIT': audit['sourceCommit'], 'OLD_ROWS': str(audit['b0']['existingRows']), 'LINE_TABLE': table, 'COMMAND_TABLE': commands,
    'UNIFIED_RESULT': '已做，退出 0；源码干净，UTC/Asia Shanghai 全套、离线 eval、真实 Electron 冻结冒烟 8/8、offline audit 通过',
    'AUDIT_HASH': sha(target / 'audit/audit.json'), 'UNIFIED_HASH': sha(target / 'unified/docs/v2-pilot/evidence/cm-step6/verification.json'),
    'B0_HASH': audit['b0']['afterSha256'], 'DIFF_CHECK_RESULT': '源码 `git diff 68dcda6 SOURCE --check` 退出 0。原始失败日志有框架输出的行尾空白，保留字节与 SHA；具体位置见 package-checks.json，不清洗错误记录。' if whitespace else '源码与证据 diff check 无行尾空白。'}
for key, value in values.items(): text = text.replace(key, value)
text = text.replace('68dcda6 SOURCE --check', f'68dcda6 {audit["sourceCommit"][:7]} --check')
(repo / 'docs/v2-pilot/v2-round2.md').write_text(text)
files = []
for path in sorted(target.rglob('*')):
    if path.is_file(): files.append({'path': str(path.relative_to(target)), 'bytes': path.stat().st_size, 'sha256': sha(path)})
manifest = {'runId': str(uuid.uuid4()), 'generatedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': audit['sourceCommit'],
    'auditRunId': audit['runId'], 'verificationRunId': verification['runId'], 'excludedInheritedFiles': inherited_files, 'files': files}
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sourceCommit': audit['sourceCommit'], 'files': len(files), 'manifestSha256': sha(target / 'manifest.json'), 'whitespaceLines': len(whitespace)}))
