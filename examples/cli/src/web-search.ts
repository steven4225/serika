import { z } from "zod";

/** Public, keyless Exa hosted MCP endpoint used by web_search. */
export const EXA_MCP_SEARCH_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
export const WEB_SEARCH_TIMEOUT_MS = 10_000;
export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_MAX_QUERY_LENGTH = 500;
export const WEB_SEARCH_MAX_TITLE_LENGTH = 300;
export const WEB_SEARCH_MAX_SNIPPET_LENGTH = 2_000;

export const webSearchErrorCodes = [
  "INVALID_INPUT",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "UPSTREAM_ERROR",
  "INVALID_RESPONSE",
] as const;

export type WebSearchErrorCode = (typeof webSearchErrorCodes)[number];

export interface WebSearchInput {
  query: string;
  limit?: number | undefined;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchSuccess {
  ok: true;
  value: {
    query: string;
    results: WebSearchResultItem[];
    truncated: boolean;
  };
}

export interface WebSearchFailure {
  ok: false;
  error: {
    code: WebSearchErrorCode;
    message: string;
    status?: number;
  };
}

export type WebSearchResponse = WebSearchSuccess | WebSearchFailure;
/** Alias used by callers that refer to the tool result rather than the HTTP response. */
export type WebSearchResult = WebSearchResponse;

export const webSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(WEB_SEARCH_MAX_QUERY_LENGTH),
    limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  })
  .strict();

export const webSearchResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      query: z.string(),
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          snippet: z.string(),
        }),
      ),
      truncated: z.boolean(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(webSearchErrorCodes),
      message: z.string(),
      status: z.number().int().optional(),
    }),
  }),
]);

export interface WebSearchOptions {
  /** Injected in tests; production uses the global fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Tool-owned cancellation signal. Caller cancellation is propagated, not converted to a result. */
  signal?: AbortSignal;
  /** Test-only override; production uses the 10 second request deadline. */
  timeoutMs?: number;
}

const neverAborted = new AbortController().signal;

function failure(
  code: WebSearchErrorCode,
  message: string,
  status?: number,
): WebSearchFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(status === undefined ? {} : { status }),
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    typeof error === "object" && error !== null &&
      "name" in error && error.name === "AbortError"
  );
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  return text.slice(0, maxLength);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function parseMcpEnvelope(body: string): unknown {
  const payloads = body.includes("\ndata:") || body.startsWith("data:")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [body];
  for (const payload of payloads) {
    try {
      const value: unknown = JSON.parse(payload);
      if (typeof value === "object" && value !== null && ("result" in value || "error" in value)) {
        return value;
      }
    } catch {
      // Ignore non-JSON SSE messages and keep looking for the RPC result.
    }
  }
  return null;
}

function parseMcpResults(text: string, limit: number): WebSearchResponse {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim() !== "");
  const results: WebSearchResultItem[] = [];
  for (const block of blocks) {
    const title = cleanText(block.match(/^Title: (.+)$/m)?.[1], WEB_SEARCH_MAX_TITLE_LENGTH);
    const url = block.match(/^URL: (.+)$/m)?.[1]?.trim();
    if (title === undefined || !isHttpUrl(url)) continue;
    const content = block.match(/\n(?:Highlights|Text):\s*\n?([\s\S]*)/i)?.[1] ?? "";
    const snippet = cleanText(content.replace(/\n---\s*$/, "").replace(/\s+/g, " "), WEB_SEARCH_MAX_SNIPPET_LENGTH) ?? "";
    results.push({ title, url, snippet });
  }
  if (blocks.length > 0 && results.length === 0) {
    return failure("INVALID_RESPONSE", "Exa MCP returned no valid search results");
  }
  return { ok: true, value: { query: "", results: results.slice(0, limit), truncated: results.length > limit } };
}

function parseResults(body: string, limit: number): WebSearchResponse {
  const envelope = parseMcpEnvelope(body);
  if (typeof envelope !== "object" || envelope === null) {
    return failure("INVALID_RESPONSE", "Exa MCP returned an invalid response");
  }
  const rpc = envelope as { result?: unknown; error?: unknown };
  if (rpc.error !== undefined) {
    const error = rpc.error as { message?: unknown };
    const message = cleanText(error?.message, 300) ?? "Unknown MCP error";
    return failure("UPSTREAM_ERROR", `Exa MCP error: ${message}`);
  }
  if (typeof rpc.result !== "object" || rpc.result === null) {
    return failure("INVALID_RESPONSE", "Exa MCP returned no result");
  }
  const result = rpc.result as { content?: unknown; isError?: unknown };
  const items = Array.isArray(result.content) ? result.content : [];
  const text = items.find((item): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")?.text;
  if (result.isError === true) {
    return failure("UPSTREAM_ERROR", `Exa MCP error: ${cleanText(text, 300) ?? "Unknown tool error"}`);
  }
  if (text === undefined) {
    return failure("INVALID_RESPONSE", "Exa MCP returned no text content");
  }
  return parseMcpResults(text, limit);
}

/**
 * Search the public web through Exa's keyless hosted MCP search tool.
 *
 * Search results are discovery data only. Callers should open selected URLs
 * with `web_fetch` before treating a result as a verified source.
 */
export async function webSearch(
  input: WebSearchInput,
  options: WebSearchOptions,
): Promise<WebSearchResponse> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit = input.limit ?? WEB_SEARCH_DEFAULT_LIMIT;
  if (
    query.length === 0 ||
    query.length > WEB_SEARCH_MAX_QUERY_LENGTH ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > WEB_SEARCH_MAX_RESULTS
  ) {
    return failure("INVALID_INPUT", "query must be non-empty and limit must be between 1 and 10");
  }
  const callerSignal = options.signal ?? neverAborted;
  if (callerSignal.aborted) throw abortReason(callerSignal);

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS));
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort(new DOMException("Web search request timed out", "TimeoutError"));
  }, timeoutMs);
  const requestSignal = AbortSignal.any([callerSignal, timeoutController.signal]);

  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(EXA_MCP_SEARCH_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-exa-source": "runloom",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: limit } },
      }),
      signal: requestSignal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return failure("AUTH_FAILED", "Exa MCP rejected the request", response.status);
      }
      if (response.status === 429) {
        return failure("RATE_LIMITED", "Exa MCP rate limit exceeded", response.status);
      }
      return failure("UPSTREAM_ERROR", `Exa MCP returned HTTP ${response.status}`, response.status);
    }
    const parsed = parseResults(await response.text(), limit);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: { ...parsed.value, query },
    };
  } catch (error) {
    if (callerSignal.aborted) throw abortReason(callerSignal);
    if (timeoutController.signal.aborted || isAbortError(error)) {
      return failure("TIMEOUT", `Web search exceeded the ${timeoutMs}ms request deadline`);
    }
    return failure("NETWORK_ERROR", "Unable to reach Exa MCP");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Compatibility name used by the web module registration. */
export const searchWeb = webSearch;
