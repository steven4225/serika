import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import type { AfterToolCall } from "@serika/core";

export interface NoProgressToolInfo { risk?: string; idempotent?: boolean }

// Exact built-in registration names only. Task/feed polling and write tools are
// deliberately excluded; this guard never grants permission or retries tools.
const guardedTools = new Set(["read_file", "list_directory", "search_files", "web_fetch", "web_search"]);
// Six read observations cover three repetitions of a one/two-call cycle.
const window = 6;

function fingerprint(toolName: string, input: unknown, output: unknown, info: NoProgressToolInfo | undefined): string | undefined {
  if (!guardedTools.has(toolName) || info?.risk !== "read" || !info.idempotent) return undefined;
  // web_fetch owns this transport sampling timestamp. Do not strip arbitrary
  // timestamps/IDs: mtime, scheduled times and business versions mean progress.
  let businessOutput = output;
  if (toolName === "web_fetch" && output && typeof output === "object" && "value" in output &&
    output.value && typeof output.value === "object" && !Array.isArray(output.value)) {
    const { fetchedAt: _fetchedAt, ...value } = output.value as Record<string, unknown>;
    businessOutput = { ...output, value };
  }
  try {
    const canonical = JSON.stringify([toolName, input, businessOutput], (_key, value: unknown) => {
      if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
        typeof value === "number" && !Number.isFinite(value)) throw new Error("Not a JSON tool observation");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
      }
      return value;
    });
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    // Unsupported/circular outputs are not a false observation of unchanged state.
    return undefined;
  }
}

/**
 * The newest consecutive guarded read observations of this Run, oldest first.
 * A steer (user message), a denied/invalid/failed/superseded call, polling or a
 * write breaks continuity.
 */
function trailingObservations(runMessages: UIMessage[], toolInfo: (name: string) => NoProgressToolInfo | undefined): string[] {
  const observations: string[] = [];
  for (let m = runMessages.length - 1; m >= 0; m -= 1) {
    const message = runMessages[m]!;
    if (message.role === "user") return observations.reverse();
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part = message.parts[p]!;
      if (part.type !== "dynamic-tool") continue;
      const value = part.state === "output-available" ? fingerprint(part.toolName, part.input, part.output, toolInfo(part.toolName)) : undefined;
      if (value === undefined) return observations.reverse();
      observations.push(value);
      if (observations.length === window) return observations.reverse();
    }
  }
  return observations.reverse();
}

/** Warns once, then stops a Run whose read-only lookups repeat without any change in result. */
export function createNoProgressGuard(toolInfo: (name: string) => NoProgressToolInfo | undefined): AfterToolCall {
  return ({ toolName, runMessages }) => {
    const observations = trailingObservations(runMessages, toolInfo);
    let count = 1, period = 1;
    for (const size of [1, 2]) {
      const length = observations.length;
      if (length < size * 2) continue;
      const last = observations.slice(-size);
      const equals = (start: number) => last.every((value, offset) => observations[start + offset] === value);
      if (!equals(length - size * 2)) continue;
      period = size;
      count = length >= size * 3 && equals(length - size * 3) ? 3 : 2;
      break;
    }
    const cycle = period === 2 ? " 等两步循环" : "";
    if (count >= 3) {
      return { kind: "stop", message: `重复查询 ${toolName}${cycle} 三次没有新进展，已停止本次执行。请换个查询方式或补充信息；已执行的工具不会自动重跑。` };
    }
    if (count === 2) {
      return { kind: "feedback", text: `Program guard NO_PROGRESS (not user facts or tool permission): ${toolName}${cycle} 相同参数的查询结果没有变化。请换个方法，不要继续重复同一查询；第三次无进展会停止。不要把这条内部反馈作为对用户的回复。` };
    }
    return undefined;
  };
}
