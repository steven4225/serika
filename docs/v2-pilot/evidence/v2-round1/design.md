# Round 1 design
A: add channel-specific runner and separate correction dispatch journal. Rejected: duplicates permission/execution ownership and creates a second recovery path.
B: reuse foreground Run snapshot + existing SeatbeltShellRunner; TelegramStore records only input-to-Run/Steer association and suspension. Chosen: execution records remain authoritative, startup reconciles only exact receipts.
Caller: trusted gateway writes {steerId,runId,taskId,state:reserved}, calls current.steer once, records resolution. No successful extra reply. Parent remains active result-delivery source.
Suspension: optional autonomyPaused in the existing channel journal plus in-memory immediate latch; stop calls cancel immediately and persists suspension; resume only clears suspension, never creates a config grant. Desktop explicit enable also clears suspension after trusted config update. Matching full identity still required at every new Run.
Boundaries: resident owns monotonic revision; renderer owns stale async-read generation and visibility refresh. No authority comes from state sync. One writer per worktree.
