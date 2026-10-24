import type { UIMessage } from "ai";
import { z } from "zod";
import { MemoryStoreError } from "./memory-types.js";
import { findCommittedUserMessage, isExactUserQuote } from "./consolidation.js";
import type { V7Change, V7Source } from "./memory-v7-store.js";

export const memoryWriteSchema = z.object({
  operation: z.enum(["add", "replace", "retract", "undo"]), text: z.string().min(1).optional(),
  uncertain: z.boolean().optional(), category: z.enum(["preference", "note"]).optional(), id: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(),
  identity: z.object({ subject: z.string().min(1), attribute: z.string().min(1), value: z.string().min(1) }).strict().optional(),
  scope: z.enum(["user", "project"]).optional().describe("Required for add/replace. user means a clearly cross-project personal fact/preference; project means a note or preference for the source message project. Ambiguous ownership must be deferred, never default user."),
  sourceQuote: z.string().min(1),
  proposal: z.object({ messageId: z.string().min(1), quote: z.string().min(1), valueQuote: z.string().min(1) }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.operation === "add" || input.operation === "replace") && (!input.text?.trim() || !input.category || !input.identity || !input.scope)) ctx.addIssue({ code: "custom", message: "add/replace require text, category, identity and explicit scope" });
  if (input.operation !== "add" && (!input.id || input.expectedRevision === undefined)) ctx.addIssue({ code: "custom", message: "A target and its current revision are required" });
});
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export const memoryText = (message: UIMessage) => message.parts.filter(part => part.type === "text").map(part => part.text).join("\n");

export interface MemoryWriteValidationFailure {
  reasonCode: "QUOTE_VALUE_MISSING" | "SOURCE_VALUE_MISSING" | "BODY_VALUE_MISSING" | "NUMBER_UNIT_MISMATCH" | "CONDITION_CLAUSE_MISSING";
  field: "user.text" | "proposal.quote" | "sourceQuote" | "text";
  fieldLength: number;
  valueLength: number;
}
export class MemoryWriteValidationError extends MemoryStoreError {
  constructor(readonly validationFailure: MemoryWriteValidationFailure) {
    const messages = { QUOTE_VALUE_MISSING: "记忆关键值未出现在证据原话中", SOURCE_VALUE_MISSING: "记忆关键值未出现在来源摘录中",
      BODY_VALUE_MISSING: "记忆关键值未出现在正文中", NUMBER_UNIT_MISMATCH: "记忆数字及单位必须与绑定原话一致",
      CONDITION_CLAUSE_MISSING: "记忆否定或条件无法逐字对应，请保留完整原句" };
    super("MEMORY_SOURCE_INVALID", messages[validationFailure.reasonCode]);
  }
}

export function bindMemoryWrite(input: MemoryWrite, options: { messages: readonly UIMessage[]; user: UIMessage; threadId: string }): V7Change {
  const messages = options.messages.some(message => message.id === options.user.id) ? options.messages : [...options.messages, options.user];
  const user = findCommittedUserMessage(messages, options.user.id);
  const invalid = (reason: string): never => { throw new MemoryStoreError("MEMORY_SOURCE_INVALID", reason); };
  if (!user || !isExactUserQuote(user.text, input.sourceQuote)) return invalid("来源必须是本条普通用户消息的精确原话");
  const value = input.identity?.value ?? "";
  const rejectValue = (reasonCode: MemoryWriteValidationFailure["reasonCode"], field: MemoryWriteValidationFailure["field"], body: string): never => {
    throw new MemoryWriteValidationError({ reasonCode, field, fieldLength: Array.from(body).length, valueLength: Array.from(value).length });
  };
  const metadata = options.user.metadata as { sentAt?: unknown; receivedAt?: unknown } | undefined;
  const timestamp = metadata?.receivedAt ?? metadata?.sentAt;
  const source: V7Source = { kind: "conversation", threadId: options.threadId, messageId: options.user.id, quote: input.sourceQuote,
    sentAt: typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : null };
  if (input.proposal) {
    const index = messages.findIndex(message => message.id === options.user.id), previous = messages[index - 1], proposal = input.proposal;
    if (!previous || previous.id !== proposal.messageId || previous.role !== "assistant" || previous.parts.some(part => part.type !== "text" && part.type !== "reasoning") ||
      !isExactUserQuote(memoryText(previous), proposal.quote) || !input.identity || proposal.valueQuote !== input.identity.value) return invalid("确认必须相邻，并在用户原话中明确说出同一个具体值；简短应声不是确认");
    if (!isExactUserQuote(proposal.quote, proposal.valueQuote)) return rejectValue("QUOTE_VALUE_MISSING", "proposal.quote", proposal.quote);
    if (!isExactUserQuote(input.sourceQuote, proposal.valueQuote)) return rejectValue("SOURCE_VALUE_MISSING", "sourceQuote", input.sourceQuote);
    source.proposal = { messageId: previous.id, quote: proposal.quote };
  }
  if (input.operation === "add" || input.operation === "replace") {
    const text = input.uncertain ? input.sourceQuote : input.text!, quote = input.uncertain ? input.sourceQuote : input.proposal?.quote ?? input.sourceQuote;
    if (!value || !isExactUserQuote(input.proposal?.quote ?? user.text, value)) return rejectValue("QUOTE_VALUE_MISSING", input.proposal ? "proposal.quote" : "user.text", input.proposal?.quote ?? user.text);
    if (!isExactUserQuote(input.sourceQuote, value)) return rejectValue("SOURCE_VALUE_MISSING", "sourceQuote", input.sourceQuote);
    if (!isExactUserQuote(text, value)) return rejectValue("BODY_VALUE_MISSING", "text", text);
    const numbers = (body: string) => [...new Set(body.match(/(?:[-+]?\d+(?:[.,]\d+)*|[零〇一二两三四五六七八九十百千万亿]+)(?:[%％]|[\p{L}]+)?/gu) ?? [])].sort();
    if (JSON.stringify(numbers(text)) !== JSON.stringify(numbers(quote))) return rejectValue("NUMBER_UNIT_MISMATCH", "text", text);
    const clauses = (body: string) => body.split(/[。！？；;，,\n]/u).map(clause => clause.trim().replace(/^(?:我(?:的)?|用户(?:的)?|本人(?:的)?)\s*/u, ""));
    const guardedClauses = (body: string) => clauses(body).filter(clause => /不|没|无|非|勿|禁止|除外|仅|只|除非|如果|若|当|时|\b(?:not|never|no|without|unless|except|only|if|when|cannot|can't|don't)\b/iu.test(clause));
    const normalizedQuote = clauses(quote).join("，"), normalizedText = clauses(text).join("，");
    if (guardedClauses(quote).some(clause => !normalizedText.includes(clause)) || guardedClauses(text).some(clause => !normalizedQuote.includes(clause))) return rejectValue("CONDITION_CLAUSE_MISSING", "text", text);
    const sourceProject = (options.user.metadata as { memoryProjectId?: unknown } | undefined)?.memoryProjectId;
    if (input.scope === "project" && typeof sourceProject !== "string") return invalid("项目归属缺少宿主来源，请明确项目后重新提出");
    const scope = input.scope === "user" ? { kind: "user" as const } : typeof sourceProject === "string" ? { kind: "project" as const, projectId: sourceProject } : invalid("项目归属缺少宿主来源");
    return {
      scope, operation: input.operation, text, uncertain: input.uncertain ?? false, category: input.category!, source,
      identity: input.identity!, ...(input.id ? { id: input.id } : {}), ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
    };
  }
  return { operation: input.operation, id: input.id!, expectedRevision: input.expectedRevision!, source };
}

export const MEMORY_WRITE_RULES =
  "Save only durable USER facts/preferences or explicit remember/correct/withdraw requests. Task decisions and temporary Thread information belong in summaries. " +
  "Use add, replace, retract; undo restores a withdrawn entry or the entries replaced by the named current entry. Wrong memory with a new value means replace; without one means retract. " +
  "Supply an exact user sourceQuote. Assistant text, tools, webpages, files and summaries cannot supply a user fact. A complete value explicitly stated in the user's quote can bind directly without an assistant proposal. When using an adjacent assistant proposal as confirmation context, provide proposal messageId/quote/valueQuote and the same identity.value; the user's quote must still explicitly name that value. 嗯 and 好吧 alone are not confirmation. Never repeatedly ask the user to confirm merely to create a source. " +
  "Every add/replace MUST include explicit scope user or project. user is only for clearly cross-project personal preferences/facts; project binds the original message host project. Uncertain ownership must be deferred, never treated as user. Every add/replace MUST include identity {subject,attribute,value}. Use literal values and distinct attributes for independently valid things such as home address and company address. The body may normalize its subject/framing; identity.value MUST occur VERBATIM in both the exact user sourceQuote and text. Do not translate or paraphrase places, numbers or units. Choose one tight statement quote; all its numbers/units must remain in the body, with no extra numbers. Preserve entire negated/conditional/exception clauses verbatim (only the initial 我/用户 subject may normalize); when unsure, copy the complete quoted statement as text. Example: sourceQuote=我家地址是上海市甲路18号, text=用户家庭地址：上海市甲路18号, identity.value=上海市甲路18号. For 我喝咖啡不加糖，低血糖时除外, retain BOTH clauses in text; never save a bare 加糖 or omit the exception. Two values for the same attribute may coexist; conflicts appear only in diagnostics, do not ask the user to resolve them. " +
  "For mutually contradictory statements within ONE user message, quote BOTH sides in sourceQuote and set uncertain:true. The host uses this exact user sourceQuote as the body, replacing your text. Otherwise set uncertain:false. The flag derives only from contradiction within that exact user source. " +
  "Do not invent sources, targets, permission or lasting preferences from task instructions. A missing/failed write is not saved. Never retry an unknown write; report that its result requires rereading.";

export const MEMORY_PRIMARY_WRITE_INSTRUCTIONS = "For an explicit privacy/delete-this-message request, use memory_write operation exclude with messageId, reason privacy or user_requested and exact current sourceQuote; this excludes the numbered message from all model readers, keeps the original visible in chat and removes its derived memory. Do not exclude a whole message when merely changing or deleting one memory. Use memory_write only for an explicit remember, correction, withdrawal or undo request. Wait for its actual result before claiming saved. Report failed explicit remember requests immediately. " + MEMORY_WRITE_RULES;
