from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import shutil
import subprocess
import uuid

root = Path(__file__).resolve().parent
repo = next(path for path in root.parents if (path / '.git').exists())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
summary_path = root / 'summary.json'
summary = json.loads(summary_path.read_text())
for name, expected in summary['files'].items():
    assert digest(root / name) == expected, name

trail = Path('/private/tmp/serika-197-stage1-trail/decisions.tsv')
if trail.exists():
    shutil.copy2(trail, root / 'decisions.tsv')

screenshots = 0
for directory in ['feature-first-failed', 'feature-r2', 'standard']:
    raw = json.loads((root / directory / 'result.json').read_text())
    for row in raw['screenshots']:
        assert digest(root / directory / row['file']) == row['sha256']
        screenshots += 1
assert json.loads((root / 'feature-first-failed/result.json').read_text())['status'] == 'failed'
assert json.loads((root / 'feature-r2/result.json').read_text())['status'] == 'passed'

counts = {'product': {'added': 0, 'deleted': 0}, 'test': {'added': 0, 'deleted': 0}}
diff = subprocess.check_output(['git', 'diff', '71f9c3d', '--numstat'], cwd=repo, text=True)
for line in diff.splitlines():
    added, deleted, name = line.split('\t')
    if name.startswith('docs/'):
        continue
    kind = 'product' if name.endswith(('.ts', '.tsx')) and '.test.' not in name and not name.endswith('smoke-model.ts') else 'test'
    counts[kind]['added'] += int(added)
    counts[kind]['deleted'] += int(deleted)

patterns = [r'\bsk-[A-Za-z0-9_-]{20,}', r'\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}', r'\bAIza[A-Za-z0-9_-]{30,}', r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
hits = []
for path in root.rglob('*'):
    if not path.is_file() or path.suffix == '.png' or path == Path(__file__).resolve():
        continue
    content = path.read_text(errors='replace')
    if any(re.search(pattern, content) for pattern in patterns):
        hits.append(str(path.relative_to(root)))
assert not hits, 'Credential prefix scan matched files: ' + ', '.join(hits)

summary['counts'] = counts
summary['sourceDiffAfterFullTests'] = subprocess.check_output(
    ['git', 'diff', '--stat', summary['offline']['sourceCommit']], cwd=repo, text=True)
summary['files'] = {str(path.relative_to(root)): digest(path) for path in sorted(root.rglob('*'))
                    if path.is_file() and path.name not in ['summary.json', 'verification.json']}
summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
verification = {
    'id': str(uuid.uuid4()), 'createdAt': datetime.now(timezone.utc).isoformat(),
    'verification': 'evidence-integrity-and-common-credential-prefix-scan',
    'status': 'passed', 'screenshotHashesVerified': screenshots,
    'rawResultsUnchanged': True, 'originalFailurePreserved': True,
    'credentialScan': 'common-prefix-only; no real credential values read',
    'counts': counts,
    'files': {str(path.relative_to(root)): digest(path) for path in sorted(root.rglob('*'))
              if path.is_file() and path.name != 'verification.json'},
}
(root / 'verification.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: verification[key] for key in ['status', 'screenshotHashesVerified', 'counts']}))
