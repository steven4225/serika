import { v6Conflicts } from "./memory-v6-store.js";
import type { RuntimeAutomation } from "./automation-execution.js";
import type { ControllerKernel } from "./controller-kernel.js";
import type { MemoryLibraryAction, MemoryLibraryDocument, MemoryLibraryView } from "./memory-library.js";
import type { MemoryResult } from "./memory-candidates.js";
import { formalMemory, memoryPage, validMemoryEdit, visibleMemory, type FormalMemory, type MemoryEditInput, type MemoryListInput, type MemoryPage } from "./memory-management.js";
import type { MemoryReferenceSnapshot } from "./memory-snapshot.js";
import { memoryActionPreview, memoryCapacity, memoryControlFailure, memoryHistoryPage, temporalMemoryStore, validateMemoryAction, validateMemoryHistoryInput, type MemoryAction, type MemoryActionPreview, type MemoryHistoryInput, type MemoryHistoryPage, type MemoryMaintenance, type MemoryTemporalInput } from "./memory-controls.js";
import type { MemoryTemporalView } from "./memory-store.js";
import { memoryConsolidationBacklog } from "./memory-consolidation.js";
import { readMemoryFactReceipts, type MemoryFactReceipt } from "./memory-factual-receipts.js";

/** Formal memory, its documents, history and consolidation status. */
export interface AssistantMemoryControls {
  getReceipts(): Promise<MemoryResult<MemoryFactReceipt[]>>;
  getLibrary(): Promise<MemoryResult<MemoryLibraryView>>;
  readDocument(id: string): Promise<MemoryResult<MemoryLibraryDocument>>;
  changeLibrary(input: MemoryLibraryAction): Promise<MemoryResult<MemoryLibraryView>>;
  list(input?: MemoryListInput): Promise<MemoryResult<MemoryPage>>;
  get(id: string): Promise<MemoryResult<FormalMemory>>;
  update(input: MemoryEditInput): Promise<MemoryResult<FormalMemory>>;
  getHistory(input: MemoryHistoryInput): Promise<MemoryResult<MemoryHistoryPage>>;
  query(input: MemoryTemporalInput): Promise<MemoryResult<MemoryTemporalView>>;
  previewAction(input: MemoryAction): Promise<MemoryResult<MemoryActionPreview>>;
  applyAction(input: MemoryAction): Promise<MemoryResult<FormalMemory | null>>;
  getMaintenance(): Promise<MemoryResult<MemoryMaintenance>>;
  getReferences(): (MemoryReferenceSnapshot & { runId: string }) | null;
}

/** Consolidation state is written by the Run engine; memory controls only report it. */
export interface ConsolidationStatus {
  running: boolean;
  failure: string | undefined;
  lastAttempt: MemoryMaintenance["consolidation"]["lastAttempt"];
  lastSkippedReason: string | undefined;
}

export function createMemoryControls(k: ControllerKernel, deps: {
  automation: RuntimeAutomation;
  consolidationStatus(): ConsolidationStatus;
}): AssistantMemoryControls {
  const { app } = k;
  const { automation } = deps;
  return {
    getReceipts: async () => {
      await k.recovered();
      return readMemoryFactReceipts(app.memoryStore, app.threadId);
    },
    getReferences: () => k.primaryReference(app.getMemoryReferences?.()),
    getLibrary: async () => {
      if (!app.memoryStore?.getLibrary || k.isClosed()) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      return app.memoryStore.getLibrary(app.threadId);
    },
    readDocument: async (id) => {
      if (!app.memoryStore?.readLibraryDocument || k.isClosed()) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      if (typeof id !== "string" || !id || id.length > 256) return memoryControlFailure("INVALID_INPUT", "文档标识无效");
      return app.memoryStore.readLibraryDocument(id, app.threadId);
    },
    changeLibrary: async (input) => {
      if (!app.memoryStore?.changeLibrary) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      if (k.isClosed() || !k.isIdle()) return memoryControlFailure("BUSY", "请等当前处理结束后再保存记忆文档");
      return k.exclusive("memory-document", async (signal): Promise<MemoryResult<MemoryLibraryView>> => {
        try {
          await k.ensureRecovered();
          const result = await app.memoryStore!.changeLibrary!(input, app.threadId, signal);
          if (result.ok) k.emit({ type: "memory-updated", reason: "write" });
          return result;
        } catch { return memoryControlFailure("WRITE_FAILED", "保存结果未确认，请重新读取核对，不要直接重复保存"); }
      });
    },
    list: async (input) => {
      if (!app.memoryStore || k.isClosed()) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.list();
      return result.ok ? memoryPage(result.entries, app.threadId, input) : result;
    },
    get: async (id) => {
      if (!app.memoryStore || k.isClosed()) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.get(id);
      if (!result.ok) return result;
      if (!visibleMemory(result.entry, app.threadId)) return { ok: false, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Memory not found" } };
      return { ok: true, value: formalMemory(result.entry) };
    },
    update: async (input) => {
      if (!app.memoryStore) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      if (!validMemoryEdit(input)) return { ok: false, error: { code: "INVALID_INPUT", message: "Only explicit text, pin and disable edits with a current revision are allowed" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "Memory editing requires an idle controller" } };
      return k.exclusive("memory-edit", async (signal): Promise<MemoryResult<FormalMemory>> => {
        try {
          await k.ensureRecovered();
          const { id, ...edit } = input;
          const updated = await app.memoryStore!.update(id, edit, signal, { boundThreadId: app.threadId });
          const result: MemoryResult<FormalMemory> = updated.ok ? { ok: true, value: formalMemory(updated.entry) } : updated;
          if (result.ok) k.emit({ type: "memory-updated", reason: "write" });
          return result;
        } catch (error) {
          return { ok: false, error: { code: "WRITE_FAILED", message: String(error) } };
        }
      });
    },
    getHistory: async (input) => {
      if (!validateMemoryHistoryInput(input)) return memoryControlFailure("INVALID_INPUT", "History requires id, offset >=0 and limit 1..10");
      const store = app.memoryStore && !k.isClosed() ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const record = await store.inspectMemory(input.id, undefined, { boundThreadId: app.threadId });
      return record.ok ? memoryHistoryPage(record.value, input) : record;
    },
    query: async (input) => {
      const store = app.memoryStore && !k.isClosed() ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !input.id || input.id.length > 256 || Object.keys(input).some(key => !["id", "validAt", "knownAt", "includeDisabled"].includes(key))) return memoryControlFailure("INVALID_INPUT", "Invalid temporal Memory query");
      const { id, ...query } = input;
      const result = await store.queryMemory(id, query, undefined, { boundThreadId: app.threadId });
      return result.ok && Buffer.byteLength(JSON.stringify(result.value), "utf8") > 64 * 1024
        ? memoryControlFailure("MEMORY_CONTEXT_TOO_LARGE", "Temporal Memory view exceeds 64 KiB") : result;
    },
    previewAction: async (input) => {
      const validated = validateMemoryAction(input);
      if (!validated.ok) return validated;
      const store = app.memoryStore && !k.isClosed() ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const preview = await store.previewMemoryMutation(validated.value, undefined, { boundThreadId: app.threadId });
      return preview.ok ? memoryActionPreview(validated.value, preview.value) : preview;
    },
    applyAction: async (input) => {
      const validated = validateMemoryAction(input);
      if (!validated.ok) return validated;
      const store = app.memoryStore ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      if (k.isClosed() || !k.isIdle()) return memoryControlFailure("BUSY", "Memory editing requires an idle controller");
      return k.exclusive("memory-action", async (signal): Promise<MemoryResult<FormalMemory | null>> => {
        try {
          await k.ensureRecovered();
          const { operation: action, id, ...fields } = validated.value;
          const options = { boundThreadId: app.threadId };
          let result: MemoryResult<FormalMemory | null>;
          if (action === "delete") {
            const deleted = await store.deleteMemory({ id, expectedRevision: fields.expectedRevision }, signal, options);
            result = deleted.ok ? { ok: true, value: null } : deleted;
          } else {
            const updated = action === "restore"
              ? await store.restoreMemory({ id, ...fields } as Extract<MemoryAction, { operation: "restore" }>, signal, options)
              : action === "metadata"
                ? await store.update(id, fields, signal, options)
                : await store.reviseMemory({ id, operation: action, ...fields }, signal, options);
            result = updated.ok ? { ok: true, value: formalMemory(updated.entry) } : updated;
          }
          if (result.ok) k.emit({ type: "memory-updated", reason: "write" });
          return result;
        } catch (error) {
          return memoryControlFailure("WRITE_FAILED", String(error));
        }
      });
    },
    getMaintenance: async () => {
      const store = app.memoryStore && !k.isClosed() ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const counts = await store.inspectMemoryMaintenance(undefined, { boundThreadId: app.threadId });
      if (!counts.ok) return counts;
      const enabled = app.memoryExtraction !== undefined;
      let backlogCount: number | undefined, backlogError: string | undefined;
      if (enabled) {
        try { backlogCount = await app.memoryExtraction!.backlog(); }
        catch (error) { backlogError = String(error); }
      }
      const material = await store.readV6?.();
      const conflicts = material?.ok ? v6Conflicts(material.value.entries.filter(entry => entry.scope.kind === "workspace" || entry.scope.threadId === app.threadId)) : [];
      const extraction = app.memoryExtraction?.diagnostics();
      const status = deps.consolidationStatus();
      const running = extraction?.running ?? status.running;
      const error = extraction?.error ?? status.failure ?? backlogError;
      const consolidation: MemoryMaintenance["consolidation"] = {
        enabled,
        state: running ? "running" : error ? "failed" : app.memoryConsolidation?.reviewQueue !== false && counts.value.pending > 0 ? "awaiting_review" : !enabled ? "off" : (backlogCount ?? 0) > 0 ? "backlog" : "idle",
        ...(error === undefined ? {} : { error }), ...(backlogCount === undefined ? {} : { backlogCount }),
        ...(status.lastAttempt === undefined ? {} : { lastAttempt: structuredClone(status.lastAttempt) }),
        ...(status.lastSkippedReason === undefined ? {} : { lastSkippedReason: status.lastSkippedReason }),
      };
      return { ok: true, value: { ...counts.value, capacity: { ...memoryCapacity }, consolidation, conflicts, ...(extraction ? { extraction } : {}) } };
    },
  };
}
