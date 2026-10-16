import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryFolders, readMemoryFile } from "./memory-library.js";
import { MemoryPanel } from "./memory.js";
it("shows saved custom folders with actual active document counts, including unfiled memory", () => {
  const html = renderToStaticMarkup(createElement(MemoryFolders, { onOpen: () => {}, library: { revision: 8,
    folders: [{ id: "character", name: "Serika 的角色设定" }, { id: "learning", name: "Learning" }],
    documents: [{ id: "doc", title: "Character", folderId: "character", preview: "温暖直接", active: true, missing: false, updatedAt: null, scope: { kind: "workspace" } },
      { id: "inactive", title: "old", folderId: "learning", preview: "", active: false, missing: false, updatedAt: null, scope: { kind: "workspace" } }] } }));
  assert.match(html, /Serika 的角色设定/); assert.match(html, /Learning/); assert.match(html, /未归档/);
  assert.equal((html.match(/1 篇/g) ?? []).length, 1); assert.equal((html.match(/0 篇/g) ?? []).length, 2);
  assert.doesNotMatch(html, /偏好|工作|项目|待审核|revision/);
});
it("requires a host that supports real memory documents", () => {
  const html = renderToStaticMarkup(createElement(MemoryPanel, { memory: { enabled: true, autoConsolidate: true }, temporaryThread: false, controllerIdle: true, refreshToken: 0 }));
  assert.match(html, /宿主需要更新/); assert.doesNotMatch(html, /新建文件夹|memory-category-card/);
});
it("imports exact UTF-8 Markdown and rejects oversized, binary and invalid UTF-8 files", async () => {
  const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as File);
  const text = "# Character\r\n\r\n温暖直接。👩🏽‍💻\n";
  assert.deepEqual(await readMemoryFile(file("Character.md", new TextEncoder().encode(text))), { title: "Character", text });
  await assert.rejects(readMemoryFile(file("wrong.png", new Uint8Array([1]))), /TXT/);
  await assert.rejects(readMemoryFile(file("huge.md", new Uint8Array(65537))), /64 KiB/);
  await assert.rejects(readMemoryFile(file("binary.txt", new Uint8Array([97, 0, 98]))), /UTF-8/);
  await assert.rejects(readMemoryFile(file("invalid.txt", new Uint8Array([255]))));
});
