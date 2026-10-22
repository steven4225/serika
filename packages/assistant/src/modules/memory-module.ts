import { z } from "zod";
import type { TranscriptAccess } from "../transcript-access.js";
import { memoryText } from "../memory-write.js";
import { AgentError } from "@serika/core";
import { tool, type UIMessage } from "ai";
import type { AgentModule } from "../module-host.js";
import type { WorkspaceMemoryStore } from "../memory-types.js";
import { MEMORY_READ_INSTRUCTIONS, type MemoryWritePolicy } from "../memory-instructions.js";
import { bindMemoryWrite, memoryWriteSchema, MEMORY_PRIMARY_WRITE_INSTRUCTIONS } from "../memory-write.js";
export type { MemoryEntry, WorkspaceMemoryStore } from "../memory-types.js";
export type ConsolidationGetMessages = (signal: AbortSignal) => Promise<UIMessage[]>;
export interface MemoryModuleOptions {
  transcript?: TranscriptAccess;
  threadId?: string; getCurrentUserMessage?: () => UIMessage | undefined; now?: () => Date;
  workspaceRoot?: string; writePolicy?: MemoryWritePolicy;
}

/** C04: one host-bound writer, registered only on ordinary primary chat. */
export function createMemoryModule(store: WorkspaceMemoryStore, getMessages?: ConsolidationGetMessages, options: MemoryModuleOptions = {}): AgentModule {
  return { id: "memory", instructionPlacement: { section: "body", rank: 600 }, setup(ctx) {
    ctx.addInstructions(run => MEMORY_READ_INSTRUCTIONS + (run.autonomous ? "" :
      MEMORY_PRIMARY_WRITE_INSTRUCTIONS));
    ctx.registerTool({ metadata: { name: "memory_write", version: "1", risk: "write", timeoutMs: 1000, idempotent: false },
      tool: tool({ description: "Save, replace or withdraw a user-sourced memory; undo a withdrawal or replacement. No per-call confirmation. Ordinary chat only.", inputSchema: z.union([memoryWriteSchema, z.object({ operation: z.literal("exclude"), messageId: z.string().min(1),
        reason: z.enum(["privacy", "user_requested"]), sourceQuote: z.string().min(1) }).strict()]),
        execute: async (input, { abortSignal }) => {
          const signal = abortSignal ?? new AbortController().signal, user = options.getCurrentUserMessage?.();
          if (!user || !options.threadId || !store.writeV6) return { ok: false, error: { code: "MEMORY_SOURCE_INVALID", message: "当前普通用户来源不可用，未保存" } };
          try {
            if (input.operation === "exclude") {
              if (!options.transcript || !memoryText(user).includes(input.sourceQuote)) throw new Error("排除要求必须来自当前用户原话");
              return await options.transcript.exclude(input);
            }
            const change = bindMemoryWrite(input, { messages: await getMessages?.(signal) ?? [], user, threadId: options.threadId });
            const result = await store.writeV6([change], signal, options.now ? { now: options.now() } : {});
            if (!result.ok) try { ctx.notify(result.error.code === "MEMORY_COMMIT_UNCERTAIN" ? "记忆写入结果未确认，请先核对，勿重复写入" : `记忆未保存：${result.error.message}`); } catch { /* display only */ }
            if (!result.ok && result.error.code === "MEMORY_COMMIT_UNCERTAIN") throw new AgentError({ code: "TOOL_OUTCOME_UNKNOWN", message: "Memory commit may already have applied; reread before deciding, never resend automatically", retryable: false, phase: "tool" });
            if (result.ok && result.value.length === 0) return { ok: false, error: { code: "MEMORY_SOURCE_INVALID", message: "该来源的这条记忆已删除，未重新保存" } };
            if (result.ok) try { ctx.notify(input.operation === "add" ? "记忆已保存" : input.operation === "replace" ? "记忆已取代，可撤销" : input.operation === "retract" ? "记忆已撤回，可撤销" : "记忆操作已撤销"); } catch { /* display only */ }
            return result;
          } catch (error) {
            if (error instanceof AgentError) throw error;
            signal.throwIfAborted();
            return { ok: false, error: { code: "MEMORY_SOURCE_INVALID", message: error instanceof Error ? error.message : "来源校验失败，未保存" } };
          }
        } }),
    }, { defaults: { approvalAgents: ["calculator"], remember: "never" } });
  } };
}
