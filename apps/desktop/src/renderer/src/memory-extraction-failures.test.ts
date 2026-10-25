import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryMaintenance } from "@serika/assistant";
import { MemoryExtractionFailures } from "./memory-extraction-failures.js";

it("shows persisted failure reason and scoped diagnostic details in memory", () => {
  const maintenance: MemoryMaintenance = { stored: 0, disabled: 0, capacity: { entries: 512, bytes: 16 * 1024 * 1024 },
    consolidation: { enabled: true, state: "idle" }, failures: [{ version: 1, stage: "validate", code: "MEMORY_SOURCE_INVALID",
      message: "抽取来源越界", threadId: "thread-a", projectId: "personal", at: "2026-10-25T03:01:17.057Z" }] };
  maintenance.storageError = { code: "MEMORY_FILE_INVALID", message: "Invalid Memory JSON" };
  maintenance.stored = null; maintenance.disabled = null;
  const html = renderToStaticMarkup(React.createElement(MemoryExtractionFailures, { maintenance }));
  for (const text of ["记忆整理失败记录（1）", "校验失败", "抽取来源越界", "MEMORY_SOURCE_INVALID", "thread-a", "personal", "诊断详情", "条目数量未知", "MEMORY_FILE_INVALID"]) assert.ok(html.includes(text), text);
});
