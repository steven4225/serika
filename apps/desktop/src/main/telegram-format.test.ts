import assert from "node:assert/strict";
import { it } from "node:test";
import { telegramParts, telegramApprovalText, telegramBoundedText } from "./telegram-format.js";

it("renders Markdown as escaped Telegram HTML, not model-supplied tags", () => {
  const [html] = telegramParts('# 结论\n\n**可以**，用 `a < b`。\n\n[文档](https://example.com/?a=1&b=2)\n\n<script>坏内容</script>\n\n[危险](javascript:alert(1))');
  assert.ok(html!.includes("<b>结论</b>"));
  assert.ok(html!.includes("<b>可以</b>"));
  assert.ok(html!.includes("<code>a &lt; b</code>"));
  assert.ok(html!.includes('href="https://example.com/?a=1&amp;b=2"'));
  assert.ok(html!.includes("&lt;script&gt;"));
  assert.ok(!html!.includes('href="javascript:'));
});

it("turns GFM tables into mobile rows and preserves code literally", () => {
  const html = telegramParts('| 项目 | 状态 |\n| --- | --- |\n| 记忆 | 通过 |\n\n```ts\nconst a = "**literal**";\n```').join("");
  assert.ok(html.includes("项目：记忆"));
  assert.ok(html.includes("状态：通过"));
  assert.ok(!html.includes("| ---"));
  assert.ok(html.includes('<pre>const a = &quot;**literal**&quot;;</pre>'));
});

it("splits long Unicode/code replies without losing text or breaking HTML entities", () => {
  const source = '水😀<&'.repeat(2100);
  const parts = telegramParts('```\n' + source + '\n```');
  assert.ok(parts.length > 1);
  let restored = "";
  for (const [i, html] of parts.entries()) {
    assert.ok(html.startsWith(`${i + 1}/${parts.length}\n`));
    assert.ok(html.length <= 4096);
    assert.match(html, /<pre>.*<\/pre>$/s);
    const body = html.replace(/^\d+\/\d+\n/, "").replace(/<\/?pre>/g, "");
    assert.ok(!/&(?!(?:lt|gt|amp|quot);)/.test(body));
    restored += body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  assert.equal(restored, source);
});

it("host previews are literal and primary approval copy uses buttons without shortcodes", () => {
  assert.deepEqual(telegramParts('**不是模型排版** <b>参数</b>', false), ['**不是模型排版** &lt;b&gt;参数&lt;/b&gt;']);
  const text = telegramApprovalText('task_create');
  assert.match(text, /需要你确认 · 创建提醒/);
  assert.doesNotMatch(text, /允许 [A-F0-9]+|拒绝 [A-F0-9]+/);
  assert.match(text, /\/details/);
  assert.match(text, /5 分钟/);
  assert.match(text, /确认后保存，并按需启用后台服务/);
});

it("phone reminder previews show the actual time zone and hide internal task payloads", () => {
  const once = telegramApprovalText("task_create", {
    prompt: "喝水", runAt: "2027-01-02T01:00:00Z", arrangement: { kind: "reminder" },
  }, new Date("2027-01-02T00:00:00Z"));
  assert.match(once, /时间：今天 9:00（北京时间）/);
  assert.match(once, /重复：不重复/);
  assert.doesNotMatch(once, /内部调用信息|declarationVersion|runAt/);
  const recurring = telegramApprovalText("task_repeat_create", {
    prompt: "跨时区提醒", recurrence: { kind: "weekly", time: "09:00", weekday: 1, utcOffset: "+00:00" }, arrangement: { kind: "reminder" },
  });
  assert.match(recurring, /固定 UTC\+00:00；非北京时间/);
  assert.match(recurring, /每周一/);
});

it("phone web approval shows the exact target without terminal prompts or control codes", () => {
  const url = "https://www.anthropic.com/engineering/harness-design-long-running-apps";
  const text = telegramApprovalText("web_fetch", { url });
  assert.match(text, /需要你确认 · 读取网页/);
  assert.ok(text.includes(url));
  assert.match(text, /读取公开内容并交给模型处理/);
  assert.match(text, /仅限本次，5 分钟/);
  assert.doesNotMatch(text, /Tool:|web_fetch|Allow this call|\[y\/n\]|允许 [A-F0-9]+|拒绝 [A-F0-9]+/);
  assert.ok(text.length < 250);
});

it("phone summaries keep effect targets and mark omissions instead of dumping tool payloads", () => {
  const write = telegramApprovalText("write_file", { path: "report.md", content: "private body".repeat(1000) });
  assert.match(write, /文件：report.md/);
  assert.match(write, /将修改文件内容/);
  assert.doesNotMatch(write, /private body/);
  const shell = telegramApprovalText("shell_exec", { command: "echo 😀".repeat(100), cwd: "/workspace" });
  assert.match(shell, /命令摘要：/);
  assert.match(shell, /已省略，请先查看详情/);
  assert.match(shell, /目录：\/workspace/);
  assert.match(shell, /可能修改文件或访问外部服务/);
  assert.ok(shell.length < 700);
  const unknown = telegramApprovalText("external_tool", { payload: "private body" });
  assert.match(unknown, /先发送 \/details/);
  assert.doesNotMatch(unknown, /private body/);
});

it("oversized replies retain an explicit bound notice and never cut a Unicode pair", () => {
  const body = telegramBoundedText('😀'.repeat(20_000));
  assert.ok(body.length <= 32_000);
  assert.ok(body.includes('后续未发送'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body));
  assert.equal(telegramBoundedText('短回复'), '短回复');
});
