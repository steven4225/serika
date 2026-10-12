import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryCardHome, MemoryCategoryFolder, MemoryUnderstanding } from "./memory-home.js";
import { memoryCategory, memoryCategoryCounts, memoryCountLabel, memoryItemTitle, memorySourcePhrase, memoryUnderstanding, memoryUpdatedLabel, type MemoryCardEntry } from "./memory-cards.js";

const now = new Date(2026, 9, 12, 15, 0, 0);
function localIso(day: number): string {
  return new Date(2026, 9, day, 12, 0, 0).toISOString();
}

function entry(partial: Partial<MemoryCardEntry> & Pick<MemoryCardEntry, "id" | "preview">): MemoryCardEntry {
  return partial;
}

it("groups saved memories into 偏好、项目 and 工作 without a health folder", () => {
  const entries = [
    entry({ id: "pref", preview: "复盘先给结论", assertion: { kind: "preference", sourceIds: [{ kind: "conversation" }] } }),
    entry({ id: "coffee", preview: "咖啡不加糖", assertion: { kind: "fact", factIdentity: { attribute: "coffee", scenario: "personal" }, sourceIds: [{ kind: "manual" }] } }),
    entry({ id: "note", preview: "## 背景\n在做桌面助手", assertion: { kind: "note", sourceIds: [{ kind: "conversation" }, { kind: "legacy" }] } }),
    entry({ id: "work", preview: "工作区在 Runloom", assertion: { kind: "fact", factIdentity: { scenario: "work" }, sourceIds: [{ kind: "conversation" }] } }),
    entry({ id: "event", preview: "上周交付了一版", assertion: { kind: "event" } }),
  ];
  assert.equal(memoryCategory(entries[0]!), "preference");
  assert.equal(memoryCategory(entries[1]!), "preference");
  assert.equal(memoryCategory(entries[2]!), "project");
  assert.equal(memoryCategory(entries[3]!), "work");
  assert.equal(memoryCategory(entries[4]!), "project");
  assert.deepEqual(memoryCategoryCounts(entries), { preference: 2, project: 2, work: 1 });
  assert.equal(memoryCountLabel(2), "2 项");
  const home = renderToStaticMarkup(createElement(MemoryCardHome, { loaded: true, entries, now, onOpenSummary: () => {}, onOpenCategory: () => {} }));
  for (const label of ["我对你的了解", "全部", "偏好", "项目", "工作", "2 项", "1 项"]) assert.ok(home.includes(label), label);
  assert.equal(home.includes("健康"), false);
  assert.match(home, /更新于 今天|更新时间未记录|还没有更新/);
});

it("shows from for one source and corroborated for several, with markdown sections in the full text", () => {
  assert.equal(memorySourcePhrase([]), "来源未附带");
  assert.equal(memorySourcePhrase([{ kind: "conversation" }]), "from 对话");
  assert.equal(memorySourcePhrase([{ kind: "manual" }]), "from 手动记录");
  assert.equal(memorySourcePhrase([{ kind: "conversation" }, { kind: "legacy" }]), "corroborated: 对话 + 旧记录");
  const project = entry({
    id: "background",
    preview: "## 教育背景\n宁波大学",
    updatedAt: localIso(9),
    assertion: { kind: "note", sourceIds: [{ kind: "conversation" }, { kind: "manual" }] },
  });
  assert.equal(memoryItemTitle(project.preview), "教育背景");
  assert.equal(memoryUpdatedLabel(project.updatedAt, now), "更新于 3 天前");
  assert.equal(memoryUpdatedLabel(localIso(11), now), "更新于 昨天");
  assert.equal(memoryUpdatedLabel(localIso(10), now), "更新于 前天");
  assert.equal(memoryUpdatedLabel(localIso(12), now), "更新于 今天");
  const folder = renderToStaticMarkup(createElement(MemoryCategoryFolder, { category: "project", entries: [project], now, onBack: () => {}, onOpen: () => {} }));
  assert.match(folder, /教育背景/);
  assert.match(folder, /corroborated: 对话 \+ 手动记录/);
  assert.equal(folder.includes(project.id), false);
  const full = renderToStaticMarkup(createElement(MemoryUnderstanding, {
    entries: [project],
    texts: { background: "## 教育背景\n- 宁波大学，计算机科学与技术" },
    now,
    onBack: () => {},
  }));
  assert.match(full, /<h2>教育背景<\/h2>/);
  assert.match(full, /corroborated: 对话 \+ 手动记录/);
  assert.match(full, /更新于 3 天前/);
  const understanding = memoryUnderstanding([project], now);
  assert.match(understanding.narrative, /教育背景/);
  assert.equal(understanding.empty, false);
});
