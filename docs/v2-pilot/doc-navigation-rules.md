# 文档导航与执行规则整理（2026-10-26）

## 改了什么

新增 [文档索引](../INDEX.md)，四份批次文档移至 `docs/legacy/batches/`，正文不变。将 [PR #188](https://github.com/steven4225/serika/pull/188) 尚未合入 main 的 [第二批保留审查](doc-cleanup-batch2.md) 纳入本轮，并修正四个相对链接；保留原审查基线和结论。修复模块接入指南中已删除的 `index.ts` 链接，指向实际装配入口 `app.ts`。

AGENTS 与现行架构／计划统一为默认开分支、PR 到 main、用户合并、不直接推 main、不强推。[记忆计划 §4.1](../context-memory-refactor-plan.md) 补后续架构第 6／7 步前提，原目标保留。

## 逐条对照验收项

| 要求 | 结果 |
|---|---|
| 索引四类、evidence 单列 | 已做，当前文档、功能专题、开发验证和历史批次分区；evidence 标明不作日常导航 |
| 四份文档 `git mv`、正文逐字节不变 | 已做，与基线 `db59edf` 逐份比较原始字节及 SHA-256；均相等 |
| 引用与相对链接 | 已做，审查记录四个链接改为归档位置；全仓 tracked Markdown 加本轮新增文件扫描，路径和 Markdown 标题锚点无悬空 |
| 第 6 步前提 | 已做，保留工具、自动／宿主校验、7 → 4 和定时合并目标；不依赖 SQLite，沿用现有 home／项目／记忆作用域，状态映射与合并方案实施前另开草案 |
| 第 7 步约束及现状 | 已做，标明已生效约束、现有实现和未做部分；新 dreaming 方法暂停、后台无工具统一排队、来源／撤回／评测口径沿用 |
| 本轮范围 | 仅文档／规则。未实施架构第 6／7 步、S2／S3；未迁移 eval、未拆 assistant 源码；真实模型调用 0 |

## 前后数字

四份归档合计 314 行，原字节保留；产品和测试代码变化均为 0 行。README、ADR、runbook、发布记录及 evidence 的路径和正文不变。

## 实际检查与结果

- 原始字节／SHA-256 对照、受保护文档 diff 检查：退出码 0。
- 下面的全仓本地链接扫描：110 份 Markdown、283 个本地链接，退出码 0，悬空路径及 Markdown 锚点 0；跳过网络 URL 和代码示例，不发网络请求。
- `git diff --check` 和提交范围检查：退出码 0。
- 按记忆计划 §5／§6 的文档提交豁免，不运行产品测试、Electron、真实模型或 `pnpm verify:cm6`。

## 与计划不符的地方及理由

无目标变更。保留审查原在未合并的 PR #188，本轮将其纳入以保证此 PR 独立可合入。另修复扫描发现的一处现有本地断链，未调整模块行为。

## 复跑本地链接扫描

在仓库根目录运行。输出扫描文件数、本地链接数和全部失败项；存在失败时退出非零。

```sh
python3 - <<'PY'
import json
import re
import subprocess
import unicodedata
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path.cwd()
files = [Path(p) for p in subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0') if p.endswith('.md') and Path(p).is_file()]

def prose(text):
    return re.sub(r'^(`{3,}|~{3,}).*?^\1[^\n]*$', '', text, flags=re.M | re.S)

def anchors(path):
    text = prose(path.read_text())
    result = set(re.findall(r'<(?:a|h[1-6])\b[^>]*\b(?:id|name)=[\"\']([^\"\']+)', text))
    duplicates = {}
    for line in text.splitlines():
        heading = re.match(r'^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$', line)
        if not heading:
            continue
        title = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', heading[1]).lower()
        slug = ''.join(c for c in title if c in ' _-' or unicodedata.category(c)[0] in 'LNM').replace(' ', '-')
        n = duplicates.get(slug, 0)
        duplicates[slug] = n + 1
        result.add(slug + (f'-{n}' if n else ''))
    return result

failures = []
links = 0
for path in files:
    text = re.sub(r'(`+).*?\1', '', prose(path.read_text()), flags=re.S)
    targets = re.findall(r'!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)', text)
    targets += re.findall(r'^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)', text, re.M)
    targets += re.findall(r'<[^>]*\b(?:href|src)=[\"\']([^\"\']+)', text)
    for target in targets:
        target = target.strip('<>')
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        links += 1
        destination = (root / unquote(parsed.path).lstrip('/') if parsed.path.startswith('/') else path.parent / unquote(parsed.path)) if parsed.path else path
        if not destination.exists():
            failures.append({'from': str(path), 'target': target, 'reason': 'missing path'})
        elif parsed.fragment and destination.suffix == '.md' and unquote(parsed.fragment) not in anchors(destination):
            failures.append({'from': str(path), 'target': target, 'reason': 'missing anchor'})
print(json.dumps({'markdown_files': len(files), 'local_links': links, 'dangling': len(failures), 'failures': failures}, ensure_ascii=False, indent=2))
raise SystemExit(bool(failures))
PY
```
