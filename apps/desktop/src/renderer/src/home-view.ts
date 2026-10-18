import type { HomeSnapshot, HomeTask } from "@serika/assistant/browser";

/**
 * The Home panel view, built directly from the runtime's structured Home
 * snapshot (architecture-v2 §4.4 step 3). It replaces the old text parser:
 * the header already shows the identity and the command chips the entries,
 * so the panel keeps only the time and the sections.
 */
export interface HomeItem {
  kind: "item" | "note";
  text: string;
  /** Structured task line (本地任务 section); the panel shows it as a reminder. */
  task?: HomeTask;
  taskList?: "inbox" | "pending";
}

export interface HomeSection {
  title: string;
  summary: string;
  items: HomeItem[];
}

export interface HomeView {
  time: string | null;
  sections: HomeSection[];
}

export const EMPTY_HOME_VIEW: HomeView = { time: null, sections: [] };

export function homeView(snapshot: HomeSnapshot | null): HomeView {
  if (snapshot === null) return EMPTY_HOME_VIEW;
  return {
    time: snapshot.time,
    sections: snapshot.sections.map((section) => ({
      title: section.title,
      summary: section.summary,
      items: section.items.map((item) => ({
        kind: item.kind,
        text: item.text,
        ...(item.task ? { task: item.task } : {}),
        ...(item.taskList ? { taskList: item.taskList } : {}),
      })),
    })),
  };
}
