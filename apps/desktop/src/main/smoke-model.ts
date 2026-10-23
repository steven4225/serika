import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

/** Offline provider for the opt-in Electron smoke; tool execution stays in the real host. */
export function createDesktopSmokeModel() {
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    let lastUser = prompt.length - 1;
    while (lastUser >= 0 && prompt[lastUser]?.role !== "user") lastUser--;
    const user = prompt[lastUser];
    const text = user?.role === "user" ? user.content.find(part => part.type === "text")?.text ?? "" : "";
    let input: Record<string, unknown> | undefined;
    let toolName = "memory_write";
    if (!prompt.slice(lastUser + 1).some(message => message.role === "tool")) {
      if (text.startsWith("S1 shell ")) { input = { command: text.slice(9) }; toolName = "shell_exec"; }
      if (text.startsWith("记住 ")) input = { operation: "add", text: text.slice(3), category: "preference", sourceQuote: text, identity: { subject: "user", attribute: "smoke_preference", value: text.slice(3) } };
      if (text === "撤销刚才记住的内容") {
        const results = prompt.flatMap(message => message.role === "tool" ? message.content : []);
        for (const result of [...results].reverse()) {
          if (result.type !== "tool-result" || result.toolName !== "memory_write" || result.output.type !== "json") continue;
          const output = result.output.value as { ok?: boolean; value?: { id: string; revision: number }[] };
          const entry = output.ok && output.value?.[0];
          if (entry) { input = { operation: "retract", id: entry.id, expectedRevision: entry.revision, sourceQuote: text }; break; }
        }
        if (!input) throw new Error("Smoke provider has no saved memory receipt");
      }
    }
    const chunks = input ? [{ type: "tool-call" as const, toolCallId: toolName === "memory_write" ? "smoke-memory" : "s1-shell", toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "离线冒烟回复完成。" }, { type: "text-end" as const, id: "answer" },
    ];
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, ...chunks,
      { type: "finish" as const, finishReason: { unified: input ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
    ] }) };
  } });
}
