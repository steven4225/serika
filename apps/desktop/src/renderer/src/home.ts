/**
 * Groom the runtime's read-only Home text for a small panel.
 *
 * `renderHome` in the CLI package prints identity lines (model, workspace,
 * thread, transcript directory, temporary notices) followed by sections such
 * as 项目进度 / 本地任务 / Git and an entry list. The header already shows the
 * identity, and the command chips already show the entries, so this parser
 * keeps only the sections and turns their indented lines into items. Lines it
 * does not recognise are kept verbatim so nothing the runtime says is lost.
 */

export interface HomeItem {
  kind: "item" | "note";
  text: string;
}

export interface HomeSection {
  title: string;
  summary: string;
  items: HomeItem[];
}

export interface HomeView {
  time: string | null;
  sections: HomeSection[];
  unparsed: string[];
}

const IDENTITY_PREFIXES = ["Serika Home", "模型：", "Workspace：", "Thread：", "Transcript 目录：", "注意："];
const SECTION_HEADS = ["项目进度：", "本地任务：", "Git："];
const ENTRY_HEAD = "可用入口：";

function splitHead(line: string, head: string): { title: string; summary: string } {
  return { title: head.replace(/：$/, ""), summary: line.slice(head.length).trim() };
}

export function parseHome(text: string): HomeView {
  const view: HomeView = { time: null, sections: [], unparsed: [] };
  let current: HomeSection | null = null;
  let skippingEntries = false;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().length === 0) continue;

    if (line.startsWith("时间：")) {
      view.time = line.slice("时间：".length).trim();
      current = null;
      continue;
    }
    if (IDENTITY_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      current = null;
      continue;
    }
    if (line.startsWith(ENTRY_HEAD)) {
      skippingEntries = true;
      current = null;
      continue;
    }
    if (skippingEntries && /^\s+\//.test(line)) continue;
    skippingEntries = false;

    const head = SECTION_HEADS.find((candidate) => line.startsWith(candidate));
    if (head !== undefined) {
      current = { ...splitHead(line, head), items: [] };
      view.sections.push(current);
      continue;
    }

    if (current !== null && /^\s+/.test(line)) {
      const body = line.trim();
      const isBullet = body.startsWith("- ");
      const isNote = !isBullet && /^(completed 只表示|另有 |未确认终态记录|最近创建的)/.test(body);
      current.items.push({
        kind: isBullet ? "item" : isNote ? "note" : "item",
        text: isBullet ? body.slice(2) : body,
      });
      continue;
    }

    current = null;
    view.unparsed.push(line);
  }
  return view;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
