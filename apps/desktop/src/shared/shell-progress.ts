import type { ShellProgressChunk } from "./ui-contract.js";

/** Matches the Shell module's display window. First limit reached wins. */
export const SHELL_PROGRESS_MAX_BYTES = 64 * 1024;
export const SHELL_PROGRESS_MAX_EVENTS = 256;

const utf8 = new TextEncoder();
const utf8Text = new TextDecoder("utf-8", { fatal: false });

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
}

export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return text;
  return utf8Text.decode(bytes.subarray(0, maxBytes));
}

export interface ShellProgressView {
  toolCallId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** No further text is appended (empty truncated marker or cap). */
  stopped: boolean;
}

function emptyView(toolCallId: string): ShellProgressView {
  return {
    toolCallId,
    stdout: "",
    stderr: "",
    truncated: false,
    stopped: false,
  };
}

function rebuildView(toolCallId: string, chunks: readonly ShellProgressChunk[]): ShellProgressView {
  const ordered = [...chunks].sort((left, right) => left.sequence - right.sequence);
  const view = emptyView(toolCallId);
  let byteLength = 0;
  let events = 0;
  for (const chunk of ordered) {
    if (view.stopped) break;
    events += 1;
    if (chunk.truncated && chunk.text === "") {
      view.truncated = true;
      view.stopped = true;
      break;
    }
    const remainingBytes = SHELL_PROGRESS_MAX_BYTES - byteLength;
    const remainingEvents = SHELL_PROGRESS_MAX_EVENTS - events + 1;
    if (remainingBytes <= 0 || remainingEvents <= 0) {
      view.truncated = true;
      view.stopped = true;
      break;
    }
    let text = chunk.text;
    let truncated = chunk.truncated;
    const size = utf8ByteLength(text);
    if (size > remainingBytes) {
      text = utf8Prefix(text, remainingBytes);
      truncated = true;
      view.stopped = true;
    }
    if (chunk.stream === "stdout") view.stdout += text;
    else view.stderr += text;
    byteLength += utf8ByteLength(text);
    view.truncated = view.truncated || truncated;
    if (events >= SHELL_PROGRESS_MAX_EVENTS) {
      view.truncated = true;
      view.stopped = true;
    }
  }
  return view;
}

/**
 * Process-local Shell display buffer. Reloads replay `snapshot()`; the
 * controller does not keep live stdout/stderr in `getSnapshot()`.
 */
export class ShellProgressBuffer {
  readonly #chunks = new Map<string, Map<number, ShellProgressChunk>>();
  readonly #order: string[] = [];

  clear(): void {
    this.#chunks.clear();
    this.#order.length = 0;
  }

  apply(chunk: ShellProgressChunk): ShellProgressView {
    let bySequence = this.#chunks.get(chunk.toolCallId);
    if (bySequence === undefined) {
      bySequence = new Map();
      this.#chunks.set(chunk.toolCallId, bySequence);
      this.#order.push(chunk.toolCallId);
    }
    const existing = bySequence.get(chunk.sequence);
    if (existing === undefined) bySequence.set(chunk.sequence, chunk);
    return this.view(chunk.toolCallId) ?? emptyView(chunk.toolCallId);
  }

  view(toolCallId: string): ShellProgressView | undefined {
    const bySequence = this.#chunks.get(toolCallId);
    if (bySequence === undefined) return undefined;
    return rebuildView(toolCallId, [...bySequence.values()]);
  }

  snapshot(): ShellProgressChunk[] {
    const chunks: ShellProgressChunk[] = [];
    for (const toolCallId of this.#order) {
      const bySequence = this.#chunks.get(toolCallId);
      if (bySequence === undefined) continue;
      const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
      chunks.push(...ordered);
    }
    return chunks;
  }
}
