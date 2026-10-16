# Desktop memory folders and documents

## User outcome

Before: the memory homepage groups independent records into inferred fixed categories. Users cannot persist their own folder names, document titles or a whole imported Markdown document.

After: the homepage contains real named folder cards plus 未归档. A folder opens titled document cards; opening a document shows the whole body with a direct Edit action. The menu offers Import file, New document and New folder. Routine automatic memory remains quiet; low-frequency source/history/review controls remain in Settings → 记忆设置 → 管理记录.

## Five-minute check

Use an updated desktop host with memory enabled and no foreground Run. In a disposable workspace:

1. Open 记忆 → … → 新建文件夹; name and save it.
2. In that folder, import a UTF-8 `.md` or `.txt` file (at most 64 KiB).
3. Check the title, folder and full body; save the document.
4. Open Edit, change the body and save. The body updates and Edit remains available.
5. Restart the same host, reopen the folder and document. Name, title, membership and edited body must remain.

A failed read is an error, not an empty library. A save conflict retains the draft. An uncertain save blocks another mutation until explicit reread; no automatic resend occurs.

## Storage and compatibility

`.runloom/memory.json` remains the only fact source. Library metadata holds folder names, document titles, scope and ordered existing assertion-record IDs. There is no duplicate body or separate Markdown truth, no filesystem watcher and no model tool that reorganizes folders. A long document is split at Unicode boundaries into at most 2 KiB per record and assembled unchanged for display. The global 512-record capacity and existing model reference budgets still apply; displaying a whole document does not imply the whole document is injected on every model turn.

Existing records are represented read-only as individual 未归档 documents until explicitly organized. New automatic records likewise appear there; a normal record update remains attached to its existing document. Imports and edits have manual provenance; edits preserve assertion history and scope. Shortening a document disables surplus chunks without deleting their history. Permanent record deletion makes a document visibly incomplete and blocks saving the incomplete body.

Only a successful explicit library action writes Memory v5. Reads and ordinary v4 writes do not migrate a workspace. V5 keeps v4 assertions and adds library metadata; every later write preserves both. Older binaries reject v5 rather than silently drop folder/title metadata. Upgrade all readers/writers sharing the workspace before using the library in production. Never change the version number to force a downgrade or restore an old snapshot over newer writes.

## Verification boundary

Tests cover exact Unicode round trips, edit/reopen, stale metadata/body rejection, scope isolation, invalid input, atomic failure boundaries, host admission and real resident socket transport. The native isolated Electron check covers creating a Chinese folder, native MD picker import, editing, saving and reopening. These are separate from the user's daily-instance acceptance and from real-model semantic retrieval quality.
