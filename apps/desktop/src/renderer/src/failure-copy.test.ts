import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { presentFailure } from "./failure-copy.js";
import { ErrorBanner, FailureAlert } from "./failure-notice.js";
import { memoryCandidateEmptyCopy, savedMemoryEmptyCopy, savedMemoryNoticeText } from "./memory-copy.js";
import { MemorySavedNotice } from "./memory-saved-notice.js";

it("failure copy never leaves a bare skill or memory code as the only message", () => {
  for (const raw of ["SKILL_EXECUTION_FAILED", "MEMORY_COMMIT_UNCERTAIN", "Automatic Skill failed: SKILL_EXECUTION_FAILED: Run failed"]) {
    const view = presentFailure(raw);
    assert.doesNotMatch(view.summary, /SKILL_|MEMORY_/);
    assert.match(view.detail ?? "", /SKILL_|MEMORY_/);
  }
  assert.equal(presentFailure("SKILL_EXECUTION_FAILED").summary, "这次没有做完。");
  assert.equal(presentFailure("MEMORY_CANDIDATE_STALE: Candidate is stale").summary, "内容已经变了，请重新看过再决定。");
  assert.equal(presentFailure("记忆整理已开始。").summary, "记忆整理已开始。");
  assert.equal(presentFailure("记忆整理已开始。").detail, null);
  assert.equal(presentFailure("IPC_FAILED: 候选读取未确认，请刷新核对").summary, "候选读取未确认，请刷新核对");
  const html = renderToStaticMarkup(createElement(ErrorBanner, { message: "SKILL_EXECUTION_FAILED" }));
  assert.match(html, /这次没有做完/);
  assert.match(html, /<summary>详情<\/summary>/);
  assert.ok(html.indexOf("这次没有做完") < html.indexOf("<details"));
  assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /SKILL_EXECUTION_FAILED/);
  const alert = renderToStaticMarkup(createElement(FailureAlert, { text: "MEMORY_FILE_INVALID: corrupt" }));
  assert.match(alert, /记忆暂时读不出来/);
  assert.doesNotMatch(alert.slice(0, alert.indexOf("<details")), /MEMORY_FILE_INVALID/);
});

it("memory notices name what was remembered and empty states stay plain", () => {
  assert.equal(savedMemoryNoticeText("已记住", "咖啡不加糖"), "已记住：咖啡不加糖");
  assert.equal(savedMemoryNoticeText("已更新", null), "已更新");
  assert.doesNotMatch(savedMemoryNoticeText("已记住", "短报告"), /memory-|revision/);
  const html = renderToStaticMarkup(createElement(MemorySavedNotice, { primary: "已记住：咖啡不加糖", detail: "记忆 memory-1 · 版本 2" }));
  assert.match(html, /已记住：咖啡不加糖/);
  assert.ok(html.indexOf("已记住：咖啡不加糖") < html.indexOf("<details"));
  assert.doesNotMatch(html.slice(0, html.indexOf("<details")), /memory-1/);
  assert.equal(savedMemoryEmptyCopy(), "还没有记住的内容。聊天时说出你的偏好，会记在这里。");
  assert.match(memoryCandidateEmptyCopy("pending", "automatic"), /已经记住的，在「已保存」/);
  assert.equal(memoryCandidateEmptyCopy("pending", "review"), "还没有需要你确认的内容。");
  assert.doesNotMatch([
    savedMemoryEmptyCopy(),
    memoryCandidateEmptyCopy("pending", "review"),
    memoryCandidateEmptyCopy("accepted", "automatic"),
    memoryCandidateEmptyCopy("rejected", "automatic"),
    memoryCandidateEmptyCopy("stale", "automatic"),
  ].join("\n"), /候选|正式记忆|断言|revision/);
});
