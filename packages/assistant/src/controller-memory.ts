import { v7Conflicts } from "./memory-v7-store.js";
import type { ControllerKernel } from "./controller-kernel.js";
import type { MemoryLibraryAction, MemoryLibraryDocument, MemoryLibraryView } from "./memory-library.js";
import type { MemoryResult } from "./memory-types.js";
import { formalMemory, memoryPage, validMemoryEdit, type FormalMemory, type MemoryEditInput, type MemoryListInput, type MemoryPage } from "./memory-management.js";
import type { MemoryReferenceSnapshot } from "./memory-snapshot.js";
import { memoryCapacity, memoryControlFailure, validateMemoryAction, type MemoryAction, type MemoryMaintenance } from "./memory-controls.js";
import { readMemoryFactReceipts, type MemoryFactReceipt } from "./memory-factual-receipts.js";

/** Formal memory, its documents and extraction status. */
export interface AssistantMemoryControls {
  getReceipts(): Promise<MemoryResult<MemoryFactReceipt[]>>;
  getLibrary(): Promise<MemoryResult<MemoryLibraryView>>;
  readDocument(id: string): Promise<MemoryResult<MemoryLibraryDocument>>;
  changeLibrary(input: MemoryLibraryAction): Promise<MemoryResult<MemoryLibraryView>>;
  list(input?: MemoryListInput): Promise<MemoryResult<MemoryPage>>;
  get(id: string): Promise<MemoryResult<FormalMemory>>;
  update(input: MemoryEditInput): Promise<MemoryResult<FormalMemory>>;
  applyAction(input: MemoryAction): Promise<MemoryResult<FormalMemory | null>>;
  getMaintenance(): Promise<MemoryResult<MemoryMaintenance>>;
  getReferences(): (MemoryReferenceSnapshot & { runId: string }) | null;
}

export function createMemoryControls(k: ControllerKernel): AssistantMemoryControls {
  const { app } = k;
  return {
    getReceipts: async () => {
      await k.recovered();
      return readMemoryFactReceipts(app.memoryStore, app.threadId);
    },
    getReferences: () => k.primaryReference(app.getMemoryReferences?.()),
    getLibrary: async () => {
      if (!app.memoryStore?.getLibrary || k.isClosed()) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      return app.memoryStore.getLibrary();
    },
    readDocument: async (id) => {
      if (!app.memoryStore?.readLibraryDocument || k.isClosed()) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      if (typeof id !== "string" || !id || id.length > 256) return memoryControlFailure("INVALID_INPUT", "文档标识无效");
      return app.memoryStore.readLibraryDocument(id);
    },
    changeLibrary: async (input) => {
      if (!app.memoryStore?.changeLibrary) return memoryControlFailure("MEMORY_DISABLED", "记忆文档未就绪");
      if (k.isClosed() || !k.isIdle()) return memoryControlFailure("BUSY", "请等当前处理结束后再保存记忆文档");
      return k.exclusive("memory-document", async (signal): Promise<MemoryResult<MemoryLibraryView>> => {
        try {
          await k.ensureRecovered();
          const result = await app.memoryStore!.changeLibrary!(input, signal);
          if (result.ok) k.emit({ type: "memory-updated", reason: "write" });
          return result;
        } catch { return memoryControlFailure("WRITE_FAILED", "保存结果未确认，请重新读取核对，不要直接重复保存"); }
      });
    },
    list: async (input) => {
      if (!app.memoryStore || k.isClosed()) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.list();
      return result.ok ? memoryPage(result.entries, input) : result;
    },
    get: async (id) => {
      if (!app.memoryStore || k.isClosed()) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.get(id);
      if (!result.ok) return result;
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
          const updated = await app.memoryStore!.update(id, edit, signal);
          const result: MemoryResult<FormalMemory> = updated.ok ? { ok: true, value: formalMemory(updated.entry) } : updated;
          if (result.ok) k.emit({ type: "memory-updated", reason: "write" });
          return result;
        } catch (error) {
          return { ok: false, error: { code: "WRITE_FAILED", message: String(error) } };
        }
      });
    },
    applyAction: async (input) => {
      const validated = validateMemoryAction(input);
      if (!validated.ok) return validated;
      const store = app.memoryStore;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      if (k.isClosed() || !k.isIdle()) return memoryControlFailure("BUSY", "Memory editing requires an idle controller");
      return k.exclusive("memory-action", async (signal): Promise<MemoryResult<FormalMemory | null>> => {
        try {
          await k.ensureRecovered();
          const { operation: action, id, expectedRevision } = validated.value;
          let result: MemoryResult<FormalMemory | null>;
          if (action === "delete") {
            const deleted = await store.deleteMemory({ id, expectedRevision }, signal);
            result = deleted.ok ? { ok: true, value: null } : deleted;
          } else if (action === "retract" || action === "undo") {
            if (!store.writeV7) return memoryControlFailure("MEMORY_DISABLED", "Memory is unavailable");
            const updated = await store.writeV7([{ operation: action, id, expectedRevision, source: { kind: "manual" } }], signal);
            result = updated.ok ? { ok: true, value: formalMemory(updated.value.at(-1)!) } : updated;
          } else {
            const input = validated.value;
            const updated = await store.update(id, input.operation === "correct" ? { expectedRevision, text: input.text } : { expectedRevision, ...(input.operation === "metadata" ? { ...(input.pinned === undefined ? {} : { pinned: input.pinned }), ...(input.status === undefined ? {} : { status: input.status }) } : {}) }, signal);
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
      const store = app.memoryStore;
      if (!store || k.isClosed()) return memoryControlFailure("MEMORY_DISABLED", "Memory is unavailable");
      const listed = await store.list();
      if (!listed.ok) return listed;
      const enabled = app.memoryExtraction !== undefined;
      let backlogCount: number | undefined, backlogError: string | undefined;
      if (enabled) {
        try { backlogCount = await app.memoryExtraction!.backlog(); }
        catch (error) { backlogError = String(error); }
      }
      const material = await store.readV7?.();
      const conflicts = material?.ok ? v7Conflicts(material.value.entries) : [];
      const extraction = app.memoryExtraction?.diagnostics();
      const error = extraction?.error ?? backlogError;
      const consolidation: MemoryMaintenance["consolidation"] = {
        enabled, state: extraction?.running ? "running" : error ? "failed" : !enabled ? "off" : (backlogCount ?? 0) > 0 ? "backlog" : "idle",
        ...(error === undefined ? {} : { error }), ...(backlogCount === undefined ? {} : { backlogCount }),
      };
      return { ok: true, value: { stored: listed.entries.length, disabled: listed.entries.filter(entry => !entry.enabled).length, capacity: { ...memoryCapacity }, consolidation, conflicts, ...(extraction ? { extraction } : {}) } };
    },
  };
}
