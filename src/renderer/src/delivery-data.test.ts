import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { fileToolReceipt, presentAssistantReply } from "./delivery-data.js";
import { AssistantReply } from "./delivery.js";

describe("full file tool receipts", () => {
  it("shows the real path and returned bytes, without inventing a previous size", () => {
    for (const name of ["read_file", "write_file", "edit_file"]) {
      assert.deepEqual(fileToolReceipt(name, { ok: true, path: "notes/next-actions.md", bytes: 3838, content: "not displayed" }),
        { kind: "file", path: "notes/next-actions.md", bytes: 3838 });
    }
    assert.deepEqual(fileToolReceipt("write_file", { ok: true, path: "empty.md", bytes: 0 }), { kind: "file", path: "empty.md", bytes: 0 });
  });

  it("does not turn a claim, failure, wrong tool or invalid shape into a receipt", () => {
    for (const output of ["ok:true; wrote 3838 bytes", { ok: false, path: "a.md", bytes: 3838 },
      { path: "a.md", bytes: 3838 }, { ok: true, path: "", bytes: 3838 }, { ok: true, path: "a.md", bytes: "3838" },
      { ok: true, path: "a.md", bytes: -1 }, { ok: true, path: "a.md", bytes: 1.5 }, { ok: true, path: "a.md", bytes: Infinity },
      { ok: true, path: "a.md", bytes: 3838, truncated: true }]) {
      assert.equal(fileToolReceipt("edit_file", output), undefined);
    }
    assert.equal(fileToolReceipt("shell_exec", { ok: true, path: "a.md", bytes: 1, exitCode: 7 }), undefined);
    assert.equal(fileToolReceipt("memory_add", { ok: true, path: "a.md", bytes: 1 }), undefined);
  });
});

describe("assistant delivery reading order", () => {
  const text = "已在 `notes/next-actions.md` 末尾追加本次重启记录。\n\n## 待核对\n\n修改后尚未再次读盘检查。\n\n## 核对说明\n\n工具返回了实际结果，记录仍可展开查看。\n\n> 文件原句：下一步先核对。";

  it("separates an existing conclusion and explicit assistant warning while retaining the exact original", () => {
    const view = presentAssistantReply(text, { delivered: true });
    assert.equal(view.kind, "delivery");
    if (view.kind === "delivery") {
      assert.equal(view.conclusion, "已在 `notes/next-actions.md` 末尾追加本次重启记录。");
      assert.deepEqual(view.warnings, [{ title: "待核对", text: "修改后尚未再次读盘检查。" }]);
      assert.equal(view.original, text);
    }
    const html = renderToStaticMarkup(createElement(AssistantReply, { text, delivered: true }));
    assert.match(html, /待核对 · 助手说明/);
    assert.match(html, /<details class="delivery-explanation">/);
    assert.doesNotMatch(html, /<details[^>]*\bopen/);
    assert.match(html, /文件原句/);
    assert.doesNotMatch(html, /status-ok|已验收|程序验证成功/);
  });

  it("retains short replies, normal long answers and streaming text without a fabricated synopsis", () => {
    const normalAnswer = "下面解释这几个概念。\n\n" + "知识与证据的边界需要分开说明。".repeat(80);
    for (const candidate of [text, normalAnswer]) {
      assert.deepEqual(presentAssistantReply(candidate), { kind: "plain", text: candidate });
      assert.deepEqual(presentAssistantReply(candidate, { delivered: true, streaming: true }), { kind: "plain", text: candidate });
    }
    assert.deepEqual(presentAssistantReply(normalAnswer, { delivered: true }), { kind: "plain", text: normalAnswer });
    assert.deepEqual(presentAssistantReply("已写入文件。", { delivered: true }), { kind: "plain", text: "已写入文件。" });
    assert.deepEqual(presentAssistantReply("## 原理\n\n" + "原理说明。".repeat(150), { delivered: true }),
      { kind: "plain", text: "## 原理\n\n" + "原理说明。".repeat(150) });
  });

  it("accepts explicit Markdown labels, but does not interpret arbitrary success wording", () => {
    for (const label of ["**待核对**\n\n尚未读取。", "待核对：尚未读取。", "**待核对：**尚未读取。", "**待核对**：尚未读取。", "### 未验证\n\n尚未读取。"] ) {
      const view = presentAssistantReply(`已编辑文件。\n\n${label}\n\n**核对说明**\n\n完整说明。`, { delivered: true });
      assert.equal(view.kind, "delivery", label);
      if (view.kind === "delivery") assert.equal(view.warnings[0]?.text, "尚未读取。", label);
    }
    const claim = "已编辑文件。\n\n这不是通过验收，没有检查业务成功。";
    assert.deepEqual(presentAssistantReply(claim, { delivered: true }), { kind: "plain", text: claim });
  });

  it("does not promote code samples or quoted file content into warnings", () => {
    const examples = [
      "```md\n待核对：这是代码示例。\n```",
      "~~~~md\n## 待核对\n\n这是代码示例。\n~~~~",
      "> 待核对：这是文件原句。",
      "> 引用的一段\n待核对：这是懒续行，不是助手提示。",
      "    待核对：缩进代码。",
      "- 文件中有这个标题：\n  ## 待核对\n\n  这是列表里的示例。",
      "- 列表项：\n\n  **待核对**\n\n  这是列表里的示例。",
      "文中提到待核对：这个词并不是一个独立提示。",
    ];
    for (const example of examples) {
      const source = `已编辑文件。\n\n${example}\n\n## 核对说明\n\n可查看完整回复。`;
      const view = presentAssistantReply(source, { delivered: true });
      assert.deepEqual(view, { kind: "plain", text: source }, example);
    }
  });

  it("does not collapse a tool-assisted long report without explicit sections and preserves Markdown safety", () => {
    const source = "已追加记录。\n\n" + "核对过程的说明。".repeat(90) + '\n\n<script>alert(1)</script> [危险](javascript:alert)';
    const view = presentAssistantReply(source, { delivered: true });
    assert.deepEqual(view, { kind: "plain", text: source });
    const html = renderToStaticMarkup(createElement(AssistantReply, { text: source, delivered: true }));
    assert.doesNotMatch(html, /<script>|href="javascript:/);
    assert.match(html, /核对过程的说明/);
  });

  it("reads an explicit conclusion heading without hiding a warning behind it", () => {
    const source = "## 结论\n\n已追加记录。\n\n未完成：没有运行测试。\n\n## 执行详情\n\n完整记录。";
    const view = presentAssistantReply(source, { delivered: true });
    assert.equal(view.kind, "delivery");
    if (view.kind === "delivery") {
      assert.equal(view.conclusion, "已追加记录。");
      assert.deepEqual(view.warnings, [{ title: "未完成", text: "没有运行测试。" }]);
      assert.equal(view.original, source);
    }
  });

  it("keeps substantive next steps and report sections visible instead of folding them as verification notes", () => {
    const source = "## 结论\n\n已整理文件。\n\n## 下一步计划\n\n1. 对照文件。\n2. 完成测试。\n3. 提交修改。\n\n## 待核对\n\n尚未运行测试。\n\n## 核对说明\n\n已读取原文件。";
    assert.deepEqual(presentAssistantReply(source, { delivered: true }), { kind: "plain", text: source });
    const html = renderToStaticMarkup(createElement(AssistantReply, { text: source, delivered: true }));
    assert.doesNotMatch(html, /delivery-explanation/);
    assert.match(html, /<h2>下一步计划<\/h2>/);
    for (const heading of ["## 正式报告", "**建议事项**"]) {
      const mixed = `已整理内容。\n\n${heading}\n\n这是用户要求的完整内容。\n\n未验证：尚未测试。`;
      assert.deepEqual(presentAssistantReply(mixed, { delivered: true }), { kind: "plain", text: mixed });
    }
  });

  it("keeps an unlabelled plan or report before an explicit warning visible", () => {
    for (const body of [
      "1. 对照文件。\n2. 完成测试。\n3. 提交修改。",
      "这是用户要求的报告正文。这里包含必须交付的分析结果，不是核对过程。",
      "```ts\nexport const actualDeliverable = 1;\n```",
      "> 这是用户要求保留的文件原句。",
    ]) {
      const source = `已整理文件。\n\n${body}\n\n未验证：尚未运行测试。\n\n## 核对说明\n\n已读取原文件。`;
      assert.deepEqual(presentAssistantReply(source, { delivered: true }), { kind: "plain", text: source });
      const html = renderToStaticMarkup(createElement(AssistantReply, { text: source, delivered: true }));
      assert.doesNotMatch(html, /delivery-explanation/);
    }
  });

  it("does not let a warning paragraph hide unlabelled next steps that follow it", () => {
    for (const suffix of ["", "\n\n## 核对说明\n\n工具已返回。", "\n\n未完成：还没提交。"] ) {
      const source = `已写入文件。\n\n未核对：尚未运行测试。\n\n下一步请先完成这两件事：\n1. 运行测试。\n2. 核对文件。${suffix}`;
      assert.deepEqual(presentAssistantReply(source, { delivered: true }), { kind: "plain", text: source });
      const html = renderToStaticMarkup(createElement(AssistantReply, { text: source, delivered: true }));
      assert.doesNotMatch(html, /delivery-explanation/);
      assert.match(html, /下一步请先完成这两件事/);
    }
    const explicit = "已写入文件。\n\n未核对：尚未运行测试。\n\n## 核对说明\n\n完整说明。";
    assert.equal(presentAssistantReply(explicit, { delivered: true }).kind, "delivery");
  });
});
