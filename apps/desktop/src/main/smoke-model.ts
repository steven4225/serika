import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

/** Offline provider for the opt-in Electron smoke; tool execution stays in the real host. */
export function createDesktopSmokeModel() {
  return new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
    const text = prompt.flatMap(message => message.role === "system" ? [message.content] : message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");
    const eligible = /Eligible user IDs: (\[[^\n]*\])/.exec(text)?.[1];
    const ids: string[] = eligible ? JSON.parse(eligible) : [];
    const response = process.env.RUNLOOM_SMOKE_EXTRACTION_FAILURE === "1" ? "SMOKE_INVALID_EXTRACTION_JSON"
      : eligible ? JSON.stringify({ proposals: [], outcomes: ids.map(messageId => ({ messageId, status: "no_memory" })) }) : JSON.stringify({ merge: null });
    return { content: [{ type: "text", text: response }], finishReason: { unified: "stop", raw: undefined }, warnings: [],
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } };
  }, doStream: async ({ prompt, tools }) => {
    let lastUser = prompt.length - 1;
    while (lastUser >= 0 && prompt[lastUser]?.role !== "user") lastUser--;
    const user = prompt[lastUser];
    const text = user?.role === "user" ? user.content.find(part => part.type === "text")?.text ?? "" : "";
    let input: Record<string, unknown> | undefined;
    let toolName = "memory_write";
    let piAnswer: string | undefined;
    if (text.startsWith("S2 pi ")) {
      const results = prompt.slice(lastUser + 1).flatMap(message => message.role === "tool" ? message.content : []);
      const failed = results.some(result => result.type === "tool-result" && (result.output.type === "error-text" || result.output.type === "error-json" || result.output.type === "json" &&
        typeof result.output.value === "object" && result.output.value !== null && "ok" in result.output.value && result.output.value.ok === false));
      const names = results.flatMap(result => result.type === "tool-result" ? [result.toolName] : []);
      if (!failed) {
        const discoveryAvailable = tools?.some(tool => tool.name === "herdr_pi_discover") ?? false;
        if (discoveryAvailable === names.includes("herdr_pi_discover")) throw new Error("Smoke Pi discovery contract does not match Run adoption");
      }
      if (failed) piAnswer = "S2_PI_STOPPED";
      else if (!names.includes("herdr_pi_discover")) { toolName = "herdr_pi_discover"; input = {}; }
      else if (!names.includes("herdr_pi_control")) { toolName = "herdr_pi_control"; input = { action: "prompt", text }; }
      else if (!names.includes("herdr_pi_read")) { toolName = "herdr_pi_read"; input = { action: "read" }; }
      else if (!names.includes("read_file")) { toolName = "read_file"; input = { path: "answer.json" }; }
      else piAnswer = "S2_PI_DONE";
    }
    if (!text.startsWith("S2 pi ") && !prompt.slice(lastUser + 1).some(message => message.role === "tool")) {
      if (text.startsWith("S1 shell ")) { input = { command: text.slice(9) }; toolName = "shell_exec"; }
      if (text.startsWith("记住 ")) input = { operation: "add", text: text.slice(3), category: "preference", scope: "user", sourceQuote: text, identity: { subject: "user", attribute: "smoke_preference", value: text.slice(3) } };
      if (text.startsWith("记住项目 ")) input = { operation: "add", text: text.slice(5), category: "note", scope: "project", sourceQuote: text, identity: { subject: "project", attribute: "smoke_note", value: text.slice(5) } };
      if (text.startsWith("读取记忆 ")) { input = JSON.parse(text.slice(5)); toolName = "memory_read"; }
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
    const context = prompt.flatMap(message => message.role === "system" ? [] : message.content.flatMap(part => {
      if (part.type !== "text") return [];
      const marker = "Host context captured with this message:\n", suffix = part.text.indexOf(marker);
      return /^(?:Fixed Memory snapshot:|Memory document index \(read with memory_read\):|Memory updates supersede the fixed snapshot:)/u.test(part.text) ? [part.text] : suffix >= 0 ? [part.text.slice(suffix + marker.length)] : [];
    }));
    const answer = piAnswer ?? (text.startsWith("检查项目上下文") ? "SMOKE_CONTEXT:" + JSON.stringify(context) : "离线冒烟回复完成。");
    const chunks = input ? [{ type: "tool-call" as const, toolCallId: toolName === "memory_write" ? "smoke-memory" : text.startsWith("S2 pi ") ? `s2-${toolName}` : "s1-shell", toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: answer }, { type: "text-end" as const, id: "answer" },
    ];
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, ...chunks,
      { type: "finish" as const, finishReason: { unified: input ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
    ] }) };
  } });
}
