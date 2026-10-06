import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskResultLink, taskResultLink, taskResultWorkspaceKey } from "./task-result-link.js";

test("notification links contain only a bounded id and workspace digest, with no authority", () => {
  const link = taskResultLink("/private/tmp/private-project", "task-1");
  assert.deepEqual(parseTaskResultLink(link), { taskId: "task-1", workspaceKey: taskResultWorkspaceKey("/private/tmp/private-project") });
  assert.ok(!link.includes("private-project"));
  for (const value of [link + "&run=1", link + "#execute", link.replace("task-1", "../file"),
    link.replace("serika:", "https:"), link.replace("task-result", "user@task-result"), link + "&workspace=bad"]) {
    assert.equal(parseTaskResultLink(value), null);
  }
  assert.throws(() => taskResultLink("/private/tmp/work", "-open https://evil"));
  assert.throws(() => taskResultWorkspaceKey("relative"));
});
