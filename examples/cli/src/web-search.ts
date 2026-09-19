import { z } from "zod";

/** Brave Web Search API endpoint used by the R3b search tool. */
export const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
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
  /** Brave subscription token. It is never included in a result or error message. */
  apiKey: string;
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

function parseResults(body: unknown, limit: number): WebSearchResponse {
  if (typeof body !== "object" || body === null) {
    return failure("INVALID_RESPONSE", "Search provider returned an invalid response");
  }
  const root = body as { web?: unknown; query?: unknown };
  const webResults =
    typeof root.web === "object" && root.web !== null
      ? (root.web as { results?: unknown }).results
      : undefined;
  const providerItems = Array.isArray(webResults) ? webResults : [];

  const results: WebSearchResultItem[] = [];
  for (const candidate of providerItems) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const item = candidate as { title?: unknown; url?: unknown; description?: unknown; snippet?: unknown };
    if (!isHttpUrl(item.url)) continue;
    const title = cleanText(item.title, WEB_SEARCH_MAX_TITLE_LENGTH);
    const snippet = cleanText(item.description ?? item.snippet, WEB_SEARCH_MAX_SNIPPET_LENGTH) ?? "";
    if (title === undefined) continue;
    results.push({ title, url: item.url, snippet });
    if (results.length >= limit) break;
  }

  const providerQuery =
    typeof root.query === "object" && root.query !== null
      ? (root.query as { more_results_available?: unknown }).more_results_available
      : undefined;
  const providerHasMore = providerQuery === true;
  return {
    ok: true,
    value: {
      query: "",
      results,
      truncated: providerHasMore || providerItems.length > limit,
    },
  };
}

/**
 * Search the public web through Brave's Web Search API.
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
  if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
    return failure("AUTH_FAILED", "Brave Search API credentials are unavailable");
  }

  const callerSignal = options.signal ?? neverAborted;
  if (callerSignal.aborted) throw abortReason(callerSignal);

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS));
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort(new DOMException("Web search request timed out", "TimeoutError"));
  }, timeoutMs);
  const requestSignal = AbortSignal.any([callerSignal, timeoutController.signal]);

  const url = new URL(BRAVE_WEB_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));

  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "X-Subscription-Token": options.apiKey,
      },
      signal: requestSignal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return failure("AUTH_FAILED", "Brave Search API rejected the credentials", response.status);
      }
      if (response.status === 429) {
        return failure("RATE_LIMITED", "Brave Search API rate limit exceeded", response.status);
      }
      return failure("UPSTREAM_ERROR", `Brave Search API returned HTTP ${response.status}`, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure("INVALID_RESPONSE", "Search provider returned invalid JSON");
    }
    const parsed = parseResults(body, limit);
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
    return failure("NETWORK_ERROR", "Unable to reach the Brave Search API");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Compatibility name used by the web module registration. */
export const searchWeb = webSearch;
