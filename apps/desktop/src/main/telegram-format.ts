import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { readRecurrence, reminderSubject, reminderWhen } from "@aisdk-agent/example-cli/dist/reminder-speech.js";

const parser = unified().use(remarkParse).use(remarkGfm);
interface MarkdownNode {
  type: string; value?: string | undefined; url?: string | undefined; alt?: string | null | undefined;
  ordered?: boolean | null | undefined; start?: number | null | undefined; children?: MarkdownNode[] | undefined;
}
interface Span { text: string; open: string; close: string }
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Keep the existing channel journal bound, but never silently cut a reply or a surrogate pair. */
export function telegramBoundedText(text: string, limit = 32_000): string {
  if (text.length <= limit) return text;
  const notice = "\n[内容超过通道上限，后续未发送；完整内容请看桌面执行记录。]";
  let prefix = text.slice(0, limit - notice.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + notice;
}

/** Small allowlist renderer over the existing Markdown parser. Raw HTML is always text. */
export function telegramParts(text: string, markdown = true): string[] {
  const spans: Span[] = [];
  const append = (text: string, open = "", close = "") => { if (text) spans.push({ text, open, close }); };
  const plain = (node: MarkdownNode): string => node.value ?? node.alt ?? (node.children ?? []).map(plain).join("");
  const visit = (node: MarkdownNode, open = "", close = "") => {
    const children = () => { for (const child of node.children ?? []) visit(child, open, close); };
    const wrap = (tag: string) => { for (const child of node.children ?? []) visit(child, open + `<${tag}>`, `</${tag}>` + close); };
    switch (node.type) {
      case "root": children(); break;
      case "text": case "html": append(node.value ?? "", open, close); break;
      case "inlineCode": append(node.value ?? "", "<code>", "</code>"); break;
      case "code": append(node.value ?? "", "<pre>", "</pre>"); append("\n\n"); break;
      case "strong": case "heading": wrap("b"); if (node.type === "heading") append("\n\n"); break;
      case "emphasis": wrap("i"); break;
      case "delete": wrap("s"); break;
      case "link": {
        let url: URL | undefined;
        try { url = new URL(node.url ?? ""); } catch { /* Unsafe/relative links stay literal labels. */ }
        if (url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 1024) {
          for (const child of node.children ?? []) visit(child, open + `<a href="${escape(url.href)}">`, "</a>" + close);
        } else children();
        break;
      }
      case "paragraph": children(); append("\n\n"); break;
      case "break": append("\n"); break;
      case "thematicBreak": append("——\n\n"); break;
      case "list":
        (node.children ?? []).forEach((item, i) => { append(node.ordered ? `${(node.start ?? 1) + i}. ` : "• "); visit(item); });
        break;
      case "table": {
        const [header, ...rows] = node.children ?? [];
        const labels = (header?.children ?? []).map(plain);
        for (const row of rows) {
          (row.children ?? []).forEach((cell, i) => { append(`${labels[i] ?? `第 ${i + 1} 列`}：${plain(cell)}\n`); });
          append("\n");
        }
        break;
      }
      case "image": append(`[图片：${node.alt ?? "图片"}]`, open, close); break;
      default: children();
    }
  };
  if (markdown) visit(parser.parse(text)); else append(text);
  // Remove only renderer-added trailing separators, not whitespace inside code.
  while (spans.at(-1)?.text === "\n\n" || spans.at(-1)?.text === "\n") spans.pop();
  const pieces: string[] = [];
  let current = "";
  for (const span of spans) {
    if (span.text === "\n\n" && current.length >= 2000) {
      pieces.push(current + "\n\n"); current = ""; continue;
    }
    // Every segment closes its own tags; entity and Unicode boundaries cannot straddle parts.
    // Bound nesting/markup overhead as well as visible text, conservatively below 4096.
    const open = span.open.length + span.close.length < 1600 ? span.open : "";
    const close = open ? span.close : "";
    let buffer = "";
    const flush = () => { if (buffer) { current += open + buffer + close; buffer = ""; } };
    for (const point of span.text) {
      const encoded = escape(point);
      if (current.length + open.length + buffer.length + encoded.length + close.length > 3800) {
        flush(); if (current) pieces.push(current); current = "";
      }
      buffer += encoded;
    }
    flush();
  }
  if (current) pieces.push(current);
  if (markdown && pieces.length > 128) return telegramParts(text, false);
  if (!pieces.length) pieces.push("这次没有可显示的回复，请查看桌面执行记录。");
  return pieces.length === 1 ? pieces : pieces.map((piece, i) => `${i + 1}/${pieces.length}\n${piece}`);
}

export function telegramApprovalText(tool: string, input?: unknown, now = new Date()): string {
  const names: Record<string, string> = { task_create: "创建提醒", task_repeat_create: "创建周期安排", task_reschedule: "调整提醒时间",
    read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件", shell_exec: "执行命令", web_search: "联网搜索", web_fetch: "读取网页",
    feed_read: "读取订阅源", recipe_list: "查看命令配方", recipe_save: "登记命令配方", recipe_run: "运行命令配方", recipe_manage: "管理命令配方", computer_check: "检查 CUA 连接" };
  const arrangement = ["task_create", "task_repeat_create"].includes(tool);
  const request = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  const summary = (value: unknown, limit = 300) => {
    if (typeof value !== "string" || !value.trim()) return "未提供，请查看详情";
    const text = value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ");
    if (text.length <= limit) return text;
    return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "") + "…（已省略，请先查看详情）";
  };
  const footer = "仅限本次，5 分钟内确认。详情：/details";
  const declaration = request?.arrangement as { kind?: unknown } | undefined;
  if (arrangement && declaration?.kind === "reminder" && typeof request?.prompt === "string") {
    const recurrence = readRecurrence(request.recurrence);
    const spoken = reminderWhen({ ...(typeof request.runAt === "string" ? { runAt: request.runAt } : {}),
      ...(recurrence ? { recurrence } : {}), clock: { now, timeZone: "Asia/Shanghai" } });
    const subject = reminderSubject(request.prompt);
    const zone = recurrence && recurrence.utcOffset !== "+08:00" ? `固定 UTC${recurrence.utcOffset}；非北京时间` : "北京时间";
    return [`需要你确认 · ${names[tool]}`, `事项：${subject.length > 300 ? subject.slice(0, 300).replace(/[\uD800-\uDBFF]$/, "") + "…（/details 查看完整内容）" : subject}`,
      `时间：${spoken.time}（${zone}）`, `重复：${spoken.repeat}`, "结果将发送到当前 TG 私聊。",
      "确认后保存，并按需启用后台提醒。", "", footer].join("\n");
  }
  // Channel copy comes from typed arguments; the shared terminal preview stays in /details.
  let lines: string[];
  switch (tool) {
    case "web_fetch": case "feed_read":
      lines = [summary(request?.url, 500), "读取公开内容并交给模型处理。"];
      break;
    case "web_search": lines = [`搜索：${summary(request?.query)}`]; break;
    case "read_file": lines = [`文件：${summary(request?.path)}`, "读取内容并交给模型处理。"];
      break;
    case "write_file": case "edit_file":
      lines = [`文件：${summary(request?.path)}`, "将修改文件内容；具体改动见 /details。"];
      break;
    case "shell_exec":
      lines = [`命令摘要：${summary(request?.command, 400)}`,
        `目录：${request?.cwd === undefined ? "当前工作区" : summary(request.cwd)}`, "命令可能修改文件或访问外部服务，请核对后允许。"];
      break;
    default:
      lines = [`操作：${summary(tool, 80)}`, "请先发送 /details 查看完整操作内容。"];
  }
  return [`需要你确认 · ${names[tool] ?? "执行操作"}`, "", ...lines,
    ...(arrangement ? ["结果将发送到当前 TG 私聊。确认后保存，并按需启用后台服务。"] : []),
    "", footer].join("\n");
}
