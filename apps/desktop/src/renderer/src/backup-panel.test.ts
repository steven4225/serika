import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";

it("a failed workspace read says so and keeps 返回原工作区 reachable", async () => {
  const source = await readFile(new URL("./backup-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.catch\(\(\) => \{\}\)/, "a swallowed read leaves the recovery workspace entry silently missing");
  assert.match(source, /setWorkspaceError\("工作区状态读取失败/);
  assert.match(source, /onClick=\{\(\) => void readWorkspace\(\)\}>重新读取/);
});
