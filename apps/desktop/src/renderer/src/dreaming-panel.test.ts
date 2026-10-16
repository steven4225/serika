import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("uses the existing workspace and host receipts, distinguishes errors from no skills, and guards identity/version changes", async () => {
  const panel = await readFile(new URL("./dreaming-panel.tsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("./skills-panel.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<DreamingPanel busy=\{busy\} identity=\{identity\}/);
  assert.match(panel, /captured !== context\.current \|\| request !== generation\.current/);
  assert.match(panel, /expectedRevision: skill\.revision/);
  assert.match(panel, /restoreRevision: version\.revision/);
  assert.match(panel, /getLearnedSkillReferences\(\)/);
  assert.match(panel, /不是模型自报/);
  assert.match(panel, /不代表没有经验/);
  assert.match(panel, /failed: "失败，未算作已处理"/);
  assert.match(panel, /cancelled: "已打断，未算作已处理"/);
  assert.match(panel, /uncertain: "保存结果未确认，请刷新核对"/);
  assert.match(panel, /className="memory-detail memory-technical"/);
  assert.match(panel, /expectedEnabled: view\.enabled/);
  assert.match(panel, /至少两条独立/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});
