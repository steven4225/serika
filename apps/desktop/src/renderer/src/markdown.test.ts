import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownUrl, MessageContent } from "./markdown.js";

it("renders readable headings, lists, code and GFM tables", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { text: "## 结论\n\n**明确**的结论。\n\n- 步骤一\n- 步骤二\n\n```ts\nconst a = 1;\n```\n\n| 项目 | 状态 |\n|---|---|\n|测试|通过|" }));
  assert.match(html, /<h2>结论<\/h2>/);
  assert.match(html, /<strong>明确<\/strong>/);
  assert.match(html, /<li>步骤一<\/li>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /class="table-scroll"><table>/);
});

it("does not execute HTML, load images, or create local/executable links", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { text: '<script>alert(1)</script>\n\n[坏链接](javascript:alert) [本地](file:///secret) [正常](https://example.com)\n\n![私密](https://example.com/tracker.png)' }));
  assert.doesNotMatch(html, /<script|<img|javascript:|file:\/\/\/|src=/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /noopener noreferrer/);
  for (const url of ["data:text/html,x", "command:run", "file:///secret", "/local", "//example.com"]) assert.equal(markdownUrl(url), "");
});
