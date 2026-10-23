# Herdr client protocol references

Primary upstream: `herdrdev/herdr`, commit `6b526626f66e22c08962a7f39a83fc9ac2ebda62`.

- [Agent input and AgentInfo schema](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/api/schema/agents.rs): prompt accepts target/text/wait; send-keys accepts target/keys. Neither includes an expected terminal identity. AgentInfo uses agent, agent_status, terminal_id, pane_id and state_change_seq.
- [Response variants](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/api/schema/response.rs): pane_info contains pane, agent_info and agent_prompted contain agent, successful send-keys returns ok.
- [CLI response rendering](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/cli.rs): print_read_response prints result.read.text directly rather than JSON.
- [Agent CLI parser](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/cli/agent/bindings.rs): Clap positional target/text parsing. The client uses the end-of-options marker before prompt text and refuses option-like pane targets.
- [Wait response](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/api/wait.rs): agent_wait_success returns agent_info; wait pins the resolved occupant on the server.
- [Agent handlers](https://github.com/herdrdev/herdr/blob/6b526626f66e22c08962a7f39a83fc9ac2ebda62/src/app/api/agents.rs): prompt/input resolve a live agent target, but the client cannot atomically bind the request to the earlier selected terminal_id.

Remaining limit: pane preflight and a sending operation are separate CLI calls. A replacement between those calls remains possible. Read output is withheld until a second pane/agent identity check; this reduces accidental disclosure but cannot prove that no replacement occurred and reverted between observations. No socket client or retry path was added.

Only bounded selected fields are returned. Terminal text and titles redact common credential forms; stderr and raw protocol errors never enter tool errors. This is pattern redaction, not a guarantee to recognize every possible secret representation. Test logs contain no fixture credential values.

Inspection failures: initial unquoted API URL triggered zsh globbing; unauthenticated curl API access returned 403, followed by a missing-file read. Authenticated gh API and the official raw source succeeded. Two gh contents transfers ended early; successful needed schema/handler/wait files were used. The first CLI fixture encoded a newline incorrectly, causing subprocess syntax failures and a waiting cancellation test. The fixture was fixed and cancellation polling bounded. A standalone tsc invocation initially omitted --types node; a read-action enum object also required literal discriminated variants for exhaustive narrowing. Two subsequent failing assertions used AgentError.code instead of the existing AgentError.data.code; corrected to the actual API.
