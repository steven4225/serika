# Development command outcomes

All executable test/typecheck commands below were prefixed by `node /private/tmp/serika-v2-round3/run.mjs --home HOME`. The wrapper supplies the temporary HOME/SERIKA_HOME/RUNLOOM_HOME to descendants. Source cwd is `/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework`.

| Suffix | Home | Exit | Log |
|---|---|---:|---|
| `pnpm typecheck` before shared client integration | `…/type-H` | 2 | type-initial.log |
| `pnpm typecheck` after client integration | `…/type-H` | 2 | type.log |
| `pnpm typecheck` after async return inference correction | `…/type-H` | 0 | type-fixed.log |
| `node --test packages/assistant/dist/permission-boundary.test.js` with SERIKA_B0_CAPTURE | `…/b0-H` | 1 | b0-capture.log; expected capture before appending approved 20 rows |
| `node --test packages/assistant/dist/herdr.test.js packages/assistant/dist/herdr-control.test.js packages/assistant/dist/terminal-control.test.js packages/assistant/dist/modules/computer-module.test.js` | `…/core-H` | 1 | core-initial.log; harness passed an illegal remember flag and waited; test child terminated with SIGTERM |
| `pnpm build:runtime` | `…/core-H` | 0 | build.log |
| Same four-file core command after harness correction | `…/core-H` | 0; 27/27 | core-fixed.log |
| `pnpm --filter @serika/desktop exec tsx --test --test-name-pattern 'fixed-target Herdr' src/main/telegram-gateway.test.ts` | `…/tg-H` | 0; 1/1 | tg-read.log |
| `node --test packages/assistant/dist/permission-boundary.test.js` | `…/b0-final-H` | 0; 1/1 | b0-final.log |
| `node packages/assistant/scripts/v2-round3-verify.mjs --home /private/tmp/serika-v2-round3/audit-H --output /private/tmp/serika-v2-round3/audit-final` | `…/audit-H` | 1 | audit-initial.log; new audit requires `/private/tmp/serika-v2-round3-` prefix |

`…` above expands to `/private/tmp/serika-v2-round3`. Final audit/unified commands and subprocess exits are in their structured JSON reports.

The first attempted cherry-pick of the client was refused because integration edits were staged. No files changed; edits were stashed, the client was cherry-picked, and the stash restored. Computer integration had one api.ts conflict; both intended export groups were retained. The first b0 append probe compared historical policy fields before the existing approved projection and exited 1; no snapshot write occurred. The corrected append preserves the raw 89 historical rows and adds only the approved 20 new rows.

Delegated attempts are retained in the computer and browser evidence directories. The Computer renderer test's initial file creation used an incorrect cwd and exited 1; its log was overwritten by the later success, so no original bytes are claimed for that attempt. Herdr protocol inspection attempts that failed are described in browser/herdr-sources.md; downloaded upstream source is not packaged.

The first round3 audit on 4ca32b5 passed (110 core and 159 desktop). A later source review found stale Herdr approval text in settings/TG, so the first unified verification on that source was deliberately terminated during UTC tests with SIGTERM. Its observed prefix log and explicit abort receipt are preserved; no completion report was produced or claimed. Corrected UI/TG text and assertions are committed; final audit/unified runs target the corrected source. `pnpm typecheck` under `--home /private/tmp/serika-v2-round3/type-copy-H` exited 0 (copy-typecheck.log).

Initial evidence packaging exited 1 because its credential pattern matched sk- within tracked task- file paths in the frozen report. All 10 matches were classified by JSON field and tracked-path location without printing values. Adding a word boundary fixes the scanner; original report bytes remain unchanged. See packaging-initial.json.
