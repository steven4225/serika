import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
source = Path('/private/tmp/serika-v2-round1')
target = repo / 'docs/v2-pilot/evidence/v2-round1'
audit = json.loads((source / 'audit-final/audit.json').read_text())
verification = json.loads((source / 'unified-final/docs/v2-pilot/evidence/cm-step6/verification.json').read_text())
assert audit['status'] == verification['status'] == 'passed'
assert audit['sourceCommit'] == verification['sourceCommit']
assert verification['sourceStayedCleanDuringVerification'] is True
assert all(row['exitCode'] == 0 for row in verification['commands'])
assert not target.exists()
target.mkdir(parents=True)
shutil.copytree(source / 'audit-final', target / 'audit')
shutil.copytree(source / 'unified-final', target / 'unified')
inherited_files = ['cm-step6/live.json', 'electron-smoke/README.md',
    'electron-smoke/cm-step4-original-result.json', 'electron-smoke/cm-step5-run.json',
    'electron-smoke/verification.json']
for name in inherited_files:
    (target / 'unified/docs/v2-pilot/evidence' / name).unlink()
logs = ['audit-final.log', 'unified-final.log', 'sync-final.log', 'targeted.log',
        'steer.log', 'final-targeted.log', 'sync-integrated.log', 'unified.log',
        'interrupted-verification.json', 'frozen.sha256', 'design.md']
for name in logs:
    shutil.copy2(source / name, target / name)
for color in ['red', 'green']:
    shutil.copy2(Path(f'/private/tmp/serika-v2-round1-sync-regressions-{color}.log'), target / f'sync-regressions-{color}.log')
shutil.copy2(Path('/private/tmp/serika-v2-round1-sync-run.mjs'), target / 'sync-run.mjs')
regression_command = ['node', '/private/tmp/serika-v2-round1-sync-run.mjs', '--home',
                      '/private/tmp/serika-v2-round1-sync-H', str(repo / 'apps/desktop/node_modules/.bin/tsx'), '--test']
regressions = {'cwd': '/private/tmp/serika-v2-round1-sync',
    'red': {'productCommit': '4045b454544d3718d99eb93b7e640efcfe11e3cb', 'testsCommit': 'dd818653622c17c42ece0273c50155bd8e4b02f0',
            'command': regression_command + ['--test-name-pattern=same-Run snapshot repairs|Steer hydration survives', 'apps/desktop/src/renderer/src/runtime-store.test.ts'],
            'testProcessExitCode': 1, 'fileRestoreWrapperExitCode': 0, 'passed': 0, 'tests': 2, 'log': 'sync-regressions-red.log'},
    'green': {'sourceCommit': 'dd818653622c17c42ece0273c50155bd8e4b02f0',
              'command': regression_command + ['apps/desktop/src/renderer/src/runtime-store.test.ts'],
              'exitCode': 0, 'passed': 42, 'tests': 42, 'log': 'sync-regressions-green.log'}}
(target / 'sync-regressions.json').write_text(json.dumps(regressions, indent=2) + '\n')
shutil.copy2(Path(__file__), target / 'package-evidence.py')
table = '| 类别 | 新增 | 删除 | 净行数 |\n|---|---:|---:|---:|'
for kind, label in [('product', '产品'), ('tests-verification', '测试/验证')]:
    rows = [row for row in audit['lineChanges'] if row['kind'] == kind]
    added = sum(row['added'] for row in rows)
    removed = sum(row['removed'] for row in rows)
    table += f'\n| {label} | +{added} | -{removed} | +{added-removed} |'
table += '\n| b0 快照，单列 | +4 | -10 | -6 |'
commands = '| 实际命令 | 退出码与结果 |\n|---|---|'
commands += '\n| `node packages/assistant/scripts/v2-round1-verify.mjs --home /private/tmp/serika-s1-round1-final2/H --output /private/tmp/serika-v2-round1/audit-final` | 0，类型检查、TG 真工具路径 6/6、原生 Seatbelt 全过 |'
commands += '\n| `/bin/sh -c "pnpm typecheck && pnpm --filter @serika/desktop exec tsx --test src/main/resident-transport.test.ts src/main/ipc.test.ts src/renderer/src/runtime-store.test.ts" --home /private/tmp/serika-v2-round1/final-sync-H` | 0，52/52。`ipc.test.ts` 不存在，tsx 未收集该文件；真正 `ipc-forwards.test.ts` 由统一测试覆盖 |'
commands += '\n| renderer 两条回归，修复前产品 | 1，0/2，见 `sync-regressions-red.log` |'
commands += '\n| renderer runtime-store 全套，修复后 | 0，42/42，见 `sync-regressions-green.log`；web TypeScript 0 |'
commands += '\n| 首轮统一验证，源码 `080d703` | 143，UTC 全套 1771 pass/0 fail/7 skip 后主动终止，整体未通过 |'
commands += '\n| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round1/unified-final node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round1/verify-final-H` | 0，最终统一验证通过 |'
for row in verification['commands']:
    command = ' '.join(row['command'])
    totals = {key: sum(value for name, value in row['counts'] if name == key) for key in ['tests', 'pass', 'fail', 'skipped']}
    counts = ', '.join(f'{key}={value}' for key, value in totals.items()) if row['counts'] else ''
    commands += f'\n| 统一内部 `{command}` | {row["exitCode"]}' + (f'，{counts}' if counts else '') + ' |'
text = (source / 'report-draft.md').read_text()
text = text.replace('FINAL_RESULT', f'退出 0；源码 `{verification["sourceCommit"]}` 干净。UTC 与 Asia/Shanghai 全套、离线 eval、真实 Electron 冻结冒烟 8/8、offline audit 均通过')
text = text.replace('FINAL_LINE_TABLE', table).replace('FINAL_COMMAND_TABLE', commands)
text = text.replace('最终复核发现同 Run', '最终定向命令误写一个不存在的 IPC 测试路径，已如实列出；统一全套覆盖实际 IPC 测试。最终复核发现同 Run')
text = text.replace('- 开发首次', '- `git diff 86b518a HEAD --check` 对源码退出 0；证据加入后 `git diff --cached --check` 退出 2，仅红测试原始日志第 17/19/36/38 行含 Node 测试框架输出的空白。保留原始字节与 SHA，不清洗日志。统一输出中继承的旧 `live.json` 和 step4/5 记录未重复打包，避免被误认成本轮结果。\n- 开发首次')
(repo / 'docs/v2-pilot/v2-round1.md').write_text(text)
files = []
for path in sorted(target.rglob('*')):
    if path.is_file():
        data = path.read_bytes()
        files.append({'path': str(path.relative_to(target)), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
manifest = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': audit['sourceCommit'],
            'auditRunId': audit['runId'], 'verificationRunId': verification['runId'],
            'excludedInheritedFiles': inherited_files, 'files': files}
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sourceCommit': audit['sourceCommit'], 'files': len(files), 'manifestSha256': hashlib.sha256((target/'manifest.json').read_bytes()).hexdigest()}))
