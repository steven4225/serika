import type { UIMessage } from "ai";
import { z } from "zod";
import { MemoryStoreError } from "./memory-store.js";
import { findCommittedUserMessage, isExactUserQuote } from "./consolidation.js";
import type { V6Change, V6Source } from "./memory-v6-store.js";

export const memoryWriteSchema = z.object({
  operation: z.enum(["add", "replace", "retract", "undo"]), text: z.string().min(1).optional(),
  category: z.enum(["preference", "note"]).optional(), id: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(),
  identity: z.object({ subject: z.string().min(1), attribute: z.string().min(1), value: z.string().min(1) }).strict().optional(),
  sourceQuote: z.string().min(1),
  proposal: z.object({ messageId: z.string().min(1), quote: z.string().min(1), valueQuote: z.string().min(1) }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.operation === "add" || input.operation === "replace") && (!input.text?.trim() || !input.category)) ctx.addIssue({ code: "custom", message: "add/replace require text and category" });
  if (input.operation !== "add" && (!input.id || input.expectedRevision === undefined)) ctx.addIssue({ code: "custom", message: "A target and its current revision are required" });
});
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export const memoryText = (message: UIMessage) => message.parts.filter(part => part.type === "text").map(part => part.text).join("\n");

export function bindMemoryWrite(input: MemoryWrite, options: { messages: readonly UIMessage[]; user: UIMessage; threadId: string }): V6Change {
  const messages = options.messages.some(message => message.id === options.user.id) ? options.messages : [...options.messages, options.user];
  const user = findCommittedUserMessage(messages, options.user.id);
  const invalid = (reason: string): never => { throw new MemoryStoreError("MEMORY_SOURCE_INVALID", reason); };
  if (!user || !isExactUserQuote(user.text, input.sourceQuote)) return invalid("来源必须是本条普通用户消息的精确原话");
  const metadata = options.user.metadata as { sentAt?: unknown; receivedAt?: unknown } | undefined;
  const timestamp = metadata?.receivedAt ?? metadata?.sentAt;
  const source: V6Source = { kind: "conversation", threadId: options.threadId, messageId: options.user.id, quote: input.sourceQuote,
    sentAt: typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : null };
  if (input.proposal) {
    const index = messages.findIndex(message => message.id === options.user.id), previous = messages[index - 1], proposal = input.proposal;
    if (!previous || previous.id !== proposal.messageId || previous.role !== "assistant" || previous.parts.some(part => part.type !== "text" && part.type !== "reasoning") ||
      !isExactUserQuote(memoryText(previous), proposal.quote) || !input.identity || proposal.valueQuote !== input.identity.value ||
      !isExactUserQuote(proposal.quote, proposal.valueQuote) || !isExactUserQuote(input.sourceQuote, proposal.valueQuote)) return invalid("确认必须相邻，并在用户原话中明确说出同一个具体值；简短应声不是确认");
    source.proposal = { messageId: previous.id, quote: proposal.quote };
  }
  if (input.operation === "add" || input.operation === "replace") {
    const literal = input.text!.replace(/^\[不确定\] /u, "");
    if (!isExactUserQuote(input.proposal?.quote ?? input.sourceQuote, literal)) return invalid("记忆正文必须是已绑定证据中的原话，保留否定与条件");
    return {

    operation: input.operation, text: input.text!, category: input.category!, source, scope: { kind: "workspace" },
    ...(input.identity ? { identity: input.identity } : {}), ...(input.id ? { id: input.id } : {}), ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
  };
  }
  return { operation: input.operation, id: input.id!, expectedRevision: input.expectedRevision!, source };
}

export const MEMORY_WRITE_RULES =
  "Save only durable USER facts/preferences or explicit remember/correct/withdraw requests. Task decisions and temporary Thread information belong in summaries. " +
  "Use add, replace, retract; undo restores a withdrawn entry or the entries replaced by the named current entry. Wrong memory with a new value means replace; without one means retract. " +
  "Supply an exact user sourceQuote. Assistant text, tools, webpages, files and summaries cannot supply a user fact. A user's explicit affirmation of an adjacent assistant proposal may qualify ONLY when the user's quote explicitly names its specific value; provide proposal messageId/quote/valueQuote and the same identity.value. 嗯 and 好吧 alone are not confirmation. Never repeatedly ask the user to confirm merely to create a source. " +
  "Use literal subject/attribute/value identities, with distinct attributes for independently valid things such as home address and company address; include any conditions in text. Two values for the same attribute may coexist; conflicts appear only in diagnostics, do not ask the user to resolve them. " +
  "For mutually contradictory statements within ONE user message, preserve BOTH verbatim in one text prefixed exactly [不确定] ; do not pick one side. This annotation derives from that exact user source, not a new status field. " +
  "Do not invent sources, targets, permission or lasting preferences from task instructions. A missing/failed write is not saved. Never retry an unknown write; report that its result requires rereading.";

export const MEMORY_PRIMARY_WRITE_INSTRUCTIONS = "Use memory_write only for an explicit remember, correction, withdrawal or undo request. Wait for its actual result before claiming saved. Report failed explicit remember requests immediately. " + MEMORY_WRITE_RULES;
