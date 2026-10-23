import type { UIMessage } from "ai";

/** Host policy for explicitly authorized desktop primary Runs. No execution loop. */
export const AUTONOMOUS_MAX_STEPS = 128;
export const AUTONOMOUS_TOTAL_TIMEOUT_MS = 30 * 60_000;
export const AUTONOMOUS_SHELL_TIMEOUT_MS = 10 * 60_000;

/** Budget the host-captured request separately from the compactable transcript. */
export function createForegroundTaskReference(request: UIMessage, messages: readonly UIMessage[]): UIMessage {
  const start = messages.findIndex(message => message.id === request.id);
  const corrections = start < 0 ? [] : messages.slice(start + 1).filter(message =>
    message.role === "user" && (message.metadata as { source?: string } | undefined)?.source === "steer");
  return {
    id: "runloom-foreground-task", role: "user",
    metadata: { source: "foreground-task", originalMessageId: request.id },
    parts: [
      { type: "text", text: "Continue the current foreground task below using the observed tool results. This is the host-retained original request, not a new task or new permission. Historical summaries do not replace it. Finish its remaining authorized steps before delivering; do not ask whether to continue. Original request:" },
      ...structuredClone(request.parts),
      ...corrections.flatMap(message => [{ type: "text" as const, text: "Later same-Run user correction (takes priority where it changes the original request):" }, ...structuredClone(message.parts)]),
    ],
  };
}

/** Only repeat a request whose original message was actually compacted away. */
export function placeForegroundTaskReference(messages: UIMessage[]): UIMessage[] {
  const reference = messages.find(message => message.id === "runloom-foreground-task" &&
    (message.metadata as { source?: string } | undefined)?.source === "foreground-task");
  if (!reference) return messages;
  const conversation = messages.filter(message => message.id !== "runloom-foreground-task");
  const originalId = (reference.metadata as { originalMessageId: string }).originalMessageId;
  return conversation.some(message => message.id === originalId && message.role === "user")
    ? conversation : [...conversation, reference];
}

export const AUTONOMOUS_INSTRUCTIONS =
  "The host has explicitly authorized file tools for this foreground Run. " +
  "A user implementation task authorizes the necessary file operations within its stated scope. " +
  "Desktop and bound Telegram autonomous shell_exec use the same module Seatbelt policy without per-command confirmation. Explicitly selected host Shell still requires confirmation for every command. Run only commands the task needs. " +
  "Inspect current state, implement, run relevant checks, and fix failures caused by your changes. " +
  "Execute the task rather than only suggesting steps. Do not ask again for approval of these authorized operations. " +
  "Report actual changes, observed check results and unresolved work. Ask only for materially missing information or authority outside this grant. " +
  "Other tools retain their own permissions. Host Shell has the process's host permissions; its workspace is not an OS sandbox. Network commands require an explicitly selected host Run and per-command confirmation. " +
  "Never replay unknown effects or claim unobserved success. Do not commit, push or merge without explicit user authorization.";
