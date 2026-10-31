import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

root = Path('/Users/a1-6/Code/agents/serika-chat-run-target')
source = Path('/private/tmp/s197-tg-authorized-01nov-c')
dest = root / 'docs/v2-pilot/evidence/chat-run-target/stage1-telegram-d4eb0665'
assert not dest.exists()
dest.mkdir()
manifest = []
def copy_file(src, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, target)
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    assert digest == hashlib.sha256(target.read_bytes()).hexdigest()
    manifest.append({'path': str(target.relative_to(dest)), 'source': str(src), 'bytes': src.stat().st_size, 'sha256': digest})
for folder in ['real-live', 'live', 'reconciliation', 'reconciliation-2', 'reconciliation-3', 'offline-gate', 'inbound-evidence']:
    for f in sorted((source / folder).iterdir()):
        if f.is_file():
            prefix = '' if folder == 'real-live' else ('prestart-2639473b' if folder == 'live' else folder)
            copy_file(f, dest / prefix / f.name)
for name in ['inbound.log', 'offline-gate.log', 'unused-scene-cleanup.json', 'tasks.md', 'archive.py']:
    copy_file(source / name, dest / 'preparation' / name)
r = json.loads((dest / 'result.json').read_text())
a = json.loads((dest / 'stop-audit.json').read_text())
q = json.loads((dest / 'request-3.json').read_text())
c = r['cases'][0]
receipt = c['receiptAfterShutdown']
tools = [x['function']['name'] for x in q['tools']]
system = '\n'.join(m['content'] for m in q['messages'] if m['role'] == 'system')
target_text = system.split('Current Run Pi target after host selection: ', 1)[1]
target, _ = json.JSONDecoder().raw_decode(target_text)
chunks = [json.loads(line[6:]) for line in (dest / 'response-3.txt').read_text().splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
content = ''.join(ch['delta'].get('content', '') for x in chunks for ch in x.get('choices', []))
calls = [call for x in chunks for ch in x.get('choices', []) for call in ch.get('delta', {}).get('tool_calls', [])]
decisions = c['hostDecisions']
checks = {
    'original_failed_result_unchanged': hashlib.sha256((dest/'result.json').read_bytes()).hexdigest() == a['sourceResultSha256'],
    'three_returned_serika_calls_no_pi_calls': len(r['calls']) == 3 and all(x['caller'] == 'serika' and x['status'] == 'returned' for x in r['calls']),
    'one_same_run_for_all_decisions': a['taskRuns'] == 1 and all(x['runId'] == c['runId'] for x in decisions),
    'two_original_callback_approvals_accepted': len([d for d in decisions if d['kind'] == 'approval' and d['response']['accepted'] and d['telegramInbound'].get('callback')]) == 2,
    'one_original_selection_accepted': len([d for d in decisions if d['kind'] == 'selection' and d['response']['accepted']]) == 1,
    'adopted_target_version_one_in_actual_system': target['adoptedTarget']['target']['paneId'] == 'w1:p1' and target['selectionVersion'] == 1,
    'discover_absent_from_request_tools': 'herdr_pi_discover' not in tools,
    'response_calls_removed_discover': any(x.get('function', {}).get('name') == 'herdr_pi_discover' for x in calls),
    'failed_without_control_dispatch': receipt['status'] == 'failed' and receipt['errorPreview'] == 'Tool is not registered: herdr_pi_discover' and not any(x['toolName'] == 'herdr_pi_control' for x in receipt['tools']),
    'removed_discover_not_started': receipt['tools'][-1]['toolName'] == 'herdr_pi_discover' and receipt['tools'][-1]['status'] == 'not_started',
    'no_unknown_tool_receipts': not any(x['status'] == 'unknown' for x in receipt['tools']),
    'host_and_transport_stopped_lease_released': bool(r['isolatedHostStoppedAt'] and r['isolatedTelegramStoppedAt'] and r['testProfile']['leaseReleasedAt']) and not a['shutdownErrors'],
    'test_profile_disabled_binding_retained': r['testProfile']['final']['enabled'] is False and r['bindingAfterShutdown']['owner'] == r['bindingBeforeShutdown']['owner'],
    'cursor_confirmed_without_later_updates': r['transportCursorHandoff']['confirmed'] and r['transportCursorHandoff']['returnedUpdates'] == 0,
    'zero_unresolved_reserve': r['unresolvedReservedUsd'] == 0,
}
assert all(checks.values()), checks
rates = r['pricePerMillionUsd']
cost = sum(((Decimal(x['usage']['input'])-Decimal(x['usage']['cacheRead']))*Decimal(str(rates['input']))+Decimal(x['usage']['cacheRead'])*Decimal(str(rates['cacheRead']))+Decimal(x['usage']['output'])*Decimal(str(rates['output'])))/Decimal(1000000) for x in r['calls'])
assert cost == Decimal(str(r['costUsd']))
summary = {
    'verifiedAt': datetime.now(timezone.utc).isoformat(), 'acceptance': 'failed-after-accepted-same-run-selection',
    'batchId': r['batchId'], 'runId': c['runId'], 'checks': checks,
    'request3ToolNames': tools, 'request3AdoptedState': target,
    'response3Text': content, 'response3ToolCallDeltas': calls,
    'inputCaveat': 'General host capability registration still lists discover, and historical tool result has adoptedTarget=null/version=0. Current system suffix has adoptedTarget/version=1 and effective tools exclude discover. No causal conclusion about model behavior.',
    'receiptTools': [{'toolName': t['toolName'], 'status': t['status']} for t in receipt['tools']],
    'amountUsd': float(cost), 'amountBasis': 'Returned usage at frozen script rates, not invoice verified',
    'usage': {k: sum(x['usage'][k] for x in r['calls']) for k in ['input','output','cacheRead']},
    'noPostFailureHerdrInspectionOrCleanup': True,
    'retainedScene': {k: v for k,v in json.loads((dest/'herdr-state.json').read_text()).items() if k in ['root','session','serverPid','phase','unknown']},
    'resultDeliveryAtShutdown': [{'key': d['key'], 'state': d['state']} for d in r['telegramStoreAfterShutdown']['deliveries'] if d['key'].startswith('result:')],
    'excludedFromArchive': 'Scene snapshots, sockets, external env/profile credentials and unrelated daily data. Selected preparation result/script/log originals are included.',
    'verificationScope': 'Offline artifact audit only; no network, models, Herdr commands, tool replay, product changes or acceptance rerun.',
}
(dest/'verification.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
patterns = {'telegram_token': rb'\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b', 'api_key_prefix': rb'\bsk-[A-Za-z0-9_-]{20,}\b', 'authorization_bearer': rb'(?i)authorization[\x22\x27\s:]+bearer\s+[A-Za-z0-9._-]{20,}'}
hits = []
for f in dest.rglob('*'):
    if f.is_file():
        for name, pattern in patterns.items():
            if re.search(pattern, f.read_bytes()): hits.append({'path': str(f.relative_to(dest)), 'pattern':name})
assert not hits, hits
(dest/'archive-summary.json').write_text(json.dumps({'status':'passed','originalFiles':manifest,'originalFilesHashMatched':True,'credentialPatternMatches':hits,'credentialScanScope':list(patterns),'verificationSha256':hashlib.sha256((dest/'verification.json').read_bytes()).hexdigest()},ensure_ascii=False,indent=2)+'\n')
ledger_path = root/'docs/v2-pilot/evidence/cost-ledger.json'
ledger = json.loads(ledger_path.read_text())
assert not any(e.get('runId') == r['batchId'] for e in ledger['entries'])
ledger['entries'].append({'step':'chat-run-target-stage1-telegram','runId':r['batchId'],'hostRunId':c['runId'],'realModelRequests':3,'taskRuns':1,'amount':float(cost),'amountBasis':'Returned model usage at frozen batch script rates; not invoice verified','authorizedBatchCapUsd':0.25,'authorizedBatchMaxRequests':24,'authorizedBatchMaxRuns':1,'unresolvedCalls':0,'unresolvedReservedUsd':0,'evidence':'chat-run-target/stage1-telegram-d4eb0665/result.json','evidenceSha256':hashlib.sha256((dest/'result.json').read_bytes()).hexdigest(),'acceptance':'failed-model-called-discover-absent-from-effective-tools-after-adoption','audit':'chat-run-target/stage1-telegram-d4eb0665/stop-audit.json'})
known = Decimal(str(ledger['openingBalance']['amount']))+sum(Decimal(str(e['amount'])) for e in ledger['entries'])
reserved = sum(Decimal(str(e.get('unresolvedReservedUsd',0))) for e in ledger['entries'])
ledger['knownTotal'] = float(known)
ledger['total'] = float(known+reserved)
ledger_path.write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'archivedOriginalFiles':len(manifest),'checks':len(checks),'allChecksPassed':True,'amountUsd':float(cost),'credentialPatternMatches':len(hits),'ledgerEntriesForBatch':1},ensure_ascii=False))
