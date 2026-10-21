import type { ReferenceSource } from "./context-assembler.js";
import { createMemorySnapshotMessage, memorySnapshot } from "./memory-snapshot.js";
import { memoryLibraryDocuments } from "./memory-library.js";
import type { WorkspaceMemoryStore } from "./memory-store.js";

export function createMemoryReferenceSource(options: { store: WorkspaceMemoryStore | undefined; threadId: string }): ReferenceSource {
  return { name: "memory", slots: ["memory"], collect: async ({ signal, now }) => {
    if (!options.store) return {};
    const material = await options.store.readReferenceMaterial?.(signal, now);
    if (!material?.ok) throw new Error(material ? `${material.error.code}: ${material.error.message}` : "Memory reference material unavailable");
    const selection = memorySnapshot(material.value.entries, { now, library: material.value.library });
    const message = createMemorySnapshotMessage(selection);
    message.parts.push({ type: "text", text: "Memory document index (read with memory_read):\n" +
      JSON.stringify({ folders: material.value.library.folders, documents: memoryLibraryDocuments(material.value.library, material.value.entries, options.threadId, now)
        .filter(item => item.active && item.scope.kind === "workspace" && !item.id.startsWith("memory:"))
        .map(({ id, title, folderId }) => ({ id, title, folderId })) }) });
    return { messages: { memory: message } };
  } };
}
