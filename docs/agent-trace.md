# Desktop Agent Trace

## User outcome

- Before: execution history showed tool receipts, but not the model steps leading to them; those runtime events disappeared after process exit.
- After: open **执行记录**, select a Run, inspect a compact timeline, expand nodes for details, and reopen the same persisted Run after restart. A Run-bound tool row in the current conversation also links to its tool node. Returning to the conversation preserves it and its input.
- Five-minute demo: in the normal Serika desktop, ask for a single `read_file` of a specified workspace path, confirm only that call, and click **查看本次执行追踪**. Check model steps, tool status, duration and expanded input/result. Exit while idle with drafts saved, reopen the same Thread, and select that Run in **执行记录**. A missing path must remain a failed result, not a successful task.

## Data and authority

The existing `execution-records.json` v1 gains optional bounded `trace` metadata. The adapter persists step start/return, planned model retries and host completion checks; message deltas, prompts and internal reasoning are excluded. The local confirmation hook does not emit Core's `tool.call.approval_required`, so the Controller separately captures real pending creation as `approvalRequestedAt` on the matching active Thread/Run/tool receipt. A preview refresh does not create another wait. Auto-approved tools do not get a fabricated human-wait span.

Tool dispatch barriers and unknown-effect recovery remain unchanged. Metadata failures do not grant execution or cause a tool retry; the next successful receipt mutation marks known metadata gaps. A process crash may leave unrecorded display events: incomplete model steps are not repaired or marked completed. Restart's interrupted timestamp is the time interruption was discovered, not a measured actual stopping time.

The same local journal retains at most 50 Runs within 256 KiB. Each trace retains at most 128 events / 24 KiB, and display metadata yields to tool receipts under global byte pressure. Truncation is visible. This is bounded inspection history, not permanent trace archival or Durable execution state.

## UI behavior

- Selecting a Run replaces the list with its timeline; **返回执行列表** and **回到对话** are separate actions.
- Nodes start collapsed. A direct tool link opens, highlights and focuses that tool. Historical tool IDs are not guessed to belong to the latest Run.
- While the panel is open, non-text events coalesce receipt refreshes; no background polling or per-token reads. Superseded requests cannot replace a different Run selection, and unmount/Thread changes invalidate requests.
- A returned `ok:false` or failed Shell exit is visibly failed, even though its call lifecycle is completed. Unknown effects stay review-required and cannot be replayed here.
- Model-step duration includes step preparation and model retries, not later tool execution. Run duration includes approval waits. Missing usage says **未报告**; cost is not estimated. Planned retries do not prove the next request happened.
- Prepared memory version references, when present, are preparation evidence only. There are no invented historical compaction, provider cache-hit, reasoning or authorization-restoration nodes.
- Legacy records remain readable and explicitly say that model/confirmation history was not recorded.

## Verification boundaries

Automated checks cover receipt reopen, legacy parsing, bounded metadata, write-failure gaps, dispatch fail-closed behavior, real Controller confirmation capture, timeline projection, escaped/collapsed details, failure display and Run-bound tool links.

The normal daily desktop was used for a real-model missing-file read: the user sent it, and its two model steps, usage and failed receipt were inspected after full process restart. The final confirmation timestamp addition was checked with the real Controller and scripted model; a new paid-model confirmation/cancellation/retry demonstration on the final installed build is not claimed by that evidence.
