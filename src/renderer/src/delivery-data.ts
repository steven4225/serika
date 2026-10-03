/** Facts in this view come from a full tool output, never assistant prose. */
export interface FileToolReceipt {
  kind: "file";
  path: string;
  /** The tool's returned size. edit_file does not return the previous size. */
  bytes: number;
}

export function fileToolReceipt(toolName: string, output: unknown): FileToolReceipt | undefined {
  if (!["read_file", "write_file", "edit_file"].includes(toolName)
    || typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const result = output as { ok?: unknown; path?: unknown; bytes?: unknown; truncated?: unknown };
  if (result.ok !== true || result.truncated === true || typeof result.path !== "string" || result.path.trim().length === 0
    || typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes < 0) return undefined;
  return { kind: "file", path: result.path, bytes: result.bytes };
}

export interface AssistantWarning {
  title: string;
  text: string;
}

export type AssistantReplyPresentation =
  | { kind: "plain"; text: string }
  | { kind: "delivery"; conclusion: string; warnings: AssistantWarning[]; original: string };

const warningTitles = new Set(["待核对", "未核对", "尚未核对", "待验证", "未验证", "未完成", "尚未完成"]);
const conclusionTitles = new Set(["结论", "结果", "交付结果"]);
const explanationTitles = new Set(["核对说明", "验证说明", "执行详情"]);

interface Boundary {
  start: number;
  bodyStart: number;
  level: number;
  title: string;
  paragraph: boolean;
}

function titleText(value: string): string {
  return value.trim().replace(/^\*\*(.*?)\*\*$/, "$1").replace(/[:：]$/, "").trim();
}

/**
 * Locate explicit, top-level labels only. Quoted/code examples are not the
 * assistant's own warnings. This changes reading order, not execution state.
 */
function boundaries(text: string): Boundary[] {
  const found: Boundary[] = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let fence: { char: string; length: number } | undefined;
  let quotedParagraph = false;
  let listContentIndent: number | undefined;
  let previousBlank = true;
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, "");
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceLine?.[1]?.[0] === fence.char && fenceLine[1].length >= fence.length && !fenceLine[2]?.trim()) fence = undefined;
    } else if (fenceLine?.[1]) {
      fence = { char: fenceLine[1][0]!, length: fenceLine[1].length };
    } else if (!line.trim()) {
      quotedParagraph = false;
    } else if (/^ {0,3}>/.test(line)) {
      quotedParagraph = true;
    } else if (!quotedParagraph && !/^(?: {4}|\t)/.test(line)) {
      const listMarker = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
      const indentation = /^ */.exec(line)![0].length;
      const nestedListContent = listMarker !== null || (listContentIndent !== undefined && indentation >= listContentIndent);
      if (listMarker) listContentIndent = listMarker[0].length;
      else if (!nestedListContent) listContentIndent = undefined;
      if (nestedListContent) {
        previousBlank = false;
        offset += raw.length;
        continue;
      }
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      const boldHeading = /^ {0,3}\*\*(.+?)\*\*[:：]?\s*$/.exec(line);
      const plainHeading = /^ {0,3}(核对说明|验证说明|执行详情|待核对|未核对|尚未核对|待验证|未验证|未完成|尚未完成|结论|结果|交付结果)[:：]\s*$/.exec(line);
      if (heading?.[1] && heading[2]) {
        found.push({ start: offset, bodyStart: offset + raw.length, level: heading[1].length, title: titleText(heading[2]), paragraph: false });
      } else if ((boldHeading?.[1] || plainHeading?.[1]) && previousBlank) {
        found.push({ start: offset, bodyStart: offset + raw.length, level: 2, title: titleText(boldHeading?.[1] ?? plainHeading![1]!), paragraph: false });
      } else if (previousBlank) {
        const prefix = /^ {0,3}(?:\*\*)?(待核对|未核对|尚未核对|待验证|未验证|未完成|尚未完成)(?:\*\*)?[:：](?:\*\*)?\s*/.exec(line);
        if (prefix?.[1]) {
          found.push({ start: offset, bodyStart: offset + prefix[0].length, level: 7, title: prefix[1], paragraph: true });
        }
      }
    }
    previousBlank = !line.trim();
    offset += raw.length;
  }
  return found;
}

function paragraphEnd(text: string, start: number): number {
  const blank = /\r?\n[ \t]*\r?\n/.exec(text.slice(start));
  return blank ? start + blank.index : text.length;
}

/**
 * Only the final, tool-backed reply is eligible (the caller supplies delivered).
 * A normal answer and live deltas keep their original Markdown. No synopsis is
 * generated: the conclusion is an existing first paragraph, and the complete
 * source remains available in the disclosure.
 */
export function presentAssistantReply(
  text: string,
  { delivered = false, streaming = false }: { delivered?: boolean; streaming?: boolean } = {},
): AssistantReplyPresentation {
  const plain: AssistantReplyPresentation = { kind: "plain", text };
  if (!delivered || streaming || !text.trim()) return plain;
  const sections = boundaries(text);
  // A next-step plan/report is part of the requested artifact, not verification
  // detail. Keep the whole reply visible if it contains any other section.
  if (sections.some(section => !conclusionTitles.has(section.title)
    && !warningTitles.has(section.title) && !explanationTitles.has(section.title))) return plain;
  const start = text.search(/\S/);
  const firstHeading = sections.find(section => section.start <= start && !section.paragraph);
  let conclusionStart = start;
  if (firstHeading) {
    if (!conclusionTitles.has(firstHeading.title)) return plain;
    conclusionStart = firstHeading.bodyStart;
    while (conclusionStart < text.length && /\s/.test(text[conclusionStart]!)) conclusionStart += 1;
  }
  const conclusionEnd = Math.min(paragraphEnd(text, conclusionStart), sections.find(section => section.start > conclusionStart)?.start ?? text.length);
  const conclusion = text.slice(conclusionStart, conclusionEnd).trim();
  // A table, list, quote, code sample or heading is not a one-paragraph result.
  if (!conclusion || conclusion.length > 480 || /^(?:#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s|\|)/.test(conclusion)) return plain;

  const firstDetail = sections.find(section => section.start >= conclusionEnd
    && (warningTitles.has(section.title) || explanationTitles.has(section.title)));
  // Unlabelled plans, paragraphs, quotes and code may be the real deliverable.
  // Never hide them just because a verification label appears further down.
  if (!firstDetail || text.slice(conclusionEnd, firstDetail.start).trim()) return plain;

  const warnings: AssistantWarning[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    if (!warningTitles.has(section.title) || section.start < conclusionEnd) continue;
    if (section.paragraph) {
      const nextSectionStart = sections[index + 1]?.start ?? text.length;
      const paragraphStop = Math.min(paragraphEnd(text, section.bodyStart), nextSectionStart);
      // A labelled warning paragraph does not label the unmarked paragraphs
      // that follow it. Keep later plans/artifacts visible unless a new explicit
      // section actually identifies them as verification explanation.
      if (text.slice(paragraphStop, nextSectionStart).trim()) return plain;
    }
    const following = sections.slice(index + 1).find(next => !next.paragraph && next.level <= section.level);
    const end = section.paragraph ? Math.min(paragraphEnd(text, section.bodyStart), following?.start ?? text.length) : following?.start ?? text.length;
    const body = text.slice(section.bodyStart, end).trim();
    if (body) warnings.push({ title: section.title, text: body });
  }
  const explicitExplanation = sections.some(section => explanationTitles.has(section.title) && section.start >= conclusionEnd);
  // A long report may itself be the requested artifact. Length or the mere
  // presence of tools never turns its body into a hidden verification note.
  if (!explicitExplanation && warnings.length === 0) return plain;
  return { kind: "delivery", conclusion, warnings, original: text };
}
