import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContextSummary } from "./context-compaction.js";

const deepSeekShaped = `{
  "version": 2,
  "goal": {
    "text": "在 notes/plan.md 新建一份三段计划；目标是整理 ALPHA-2026。",
    "evidenceMessageIds": ["u1", "u2"]
  },
  "constraints": [
    { "text": "只可修改 notes/ 目录", "evidenceMessageIds": ["u1"] },
    { "text": "不得写 protected/ 目录", "evidenceMessageIds": ["u1", "u2"] }
  ],
  "decisions": [
    { "text": "在 notes/plan.md 新建一份三段计划", "source": "user", "status": "confirmed" }
  ],
  "actions": [
    { "text": "写入 notes/plan.md", "status": "completed", "toolCallIds": ["write-1"] }
  ],
  "pending": [
    { "text": "补充约束并先写目标", "evidenceMessageIds": ["u2"] }
  ],
  "files": [
    { "path": "notes/plan.md", "purpose": "存放 ALPHA-2026 的三段计划" }
  ],
  "nextStep": {
    "text": "先写目标",
    "evidenceMessageIds": ["u2"]
  }
}`;

describe("parseContextSummary", () => {
  it("accepts DeepSeek-shaped JSON that omits evidence ids and file text", () => {
    const parsed = parseContextSummary(deepSeekShaped, ["u1", "u2"]);
    assert.ok(parsed);
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.decisions[0]?.evidenceMessageIds, ["u1", "u2"]);
    assert.deepEqual(parsed.actions[0]?.evidenceMessageIds, ["u1", "u2"]);
    assert.equal(parsed.files[0]?.path, "notes/plan.md");
    assert.match(parsed.files[0]?.text ?? "", /notes\/plan\.md/);
    assert.deepEqual(parsed.files[0]?.evidenceMessageIds, ["u1", "u2"]);
  });

  it("extracts a JSON object from markdown with trailing prose", () => {
    const parsed = parseContextSummary(
      `Here is the summary:\n\`\`\`json\n${deepSeekShaped}\n\`\`\`\nDone.`,
      ["u1", "u2"],
    );
    assert.ok(parsed);
    assert.equal(parsed.goal.evidenceMessageIds[0], "u1");
  });

  it("coerces version string 2", () => {
    const parsed = parseContextSummary(deepSeekShaped.replace('"version": 2', '"version": "2"'), ["u1"]);
    assert.equal(parsed?.version, 2);
  });

  it("rejects an empty goal even when fallback ids exist", () => {
    const parsed = parseContextSummary(JSON.stringify({
      version: 2,
      goal: { text: "  ", evidenceMessageIds: ["u1"] },
      constraints: [],
      decisions: [],
      actions: [],
      pending: [],
      files: [],
      nextStep: null,
    }), ["u1"]);
    assert.equal(parsed, undefined);
  });

  it("does not invent a summary when JSON is truncated", () => {
    assert.equal(parseContextSummary("{", ["u1"]), undefined);
  });
});
