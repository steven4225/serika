import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRAVE_WEB_SEARCH_URL,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_MAX_SNIPPET_LENGTH,
  WEB_SEARCH_MAX_TITLE_LENGTH,
  webSearch,
  type WebSearchResponse,
} from "./web-search.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(result: WebSearchResponse): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("webSearch", () => {
  it("queries Brave with the token and returns bounded result fields", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await webSearch(
      { query: "Runloom agents", limit: 2 },
      {
        apiKey: "test-brave-key",
        fetch: async (input, init) => {
          requestedUrl = String(input);
          requestedInit = init;
          return jsonResponse({
            web: {
              results: [
                {
                  title: ` ${"T".repeat(WEB_SEARCH_MAX_TITLE_LENGTH + 20)} `,
                  url: "https://example.com/first",
                  description: ` ${"S".repeat(WEB_SEARCH_MAX_SNIPPET_LENGTH + 20)} `,
                },
                {
                  title: "second",
                  url: "https://example.com/second",
                  description: "A second result",
                },
              ],
            },
          });
        },
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.query, "Runloom agents");
    assert.deepEqual(result.value.results[1], {
      title: "second",
      url: "https://example.com/second",
      snippet: "A second result",
    });
    assert.equal(result.value.results[0]?.title.length, WEB_SEARCH_MAX_TITLE_LENGTH);
    assert.equal(result.value.results[0]?.snippet.length, WEB_SEARCH_MAX_SNIPPET_LENGTH);
    assert.equal(result.value.truncated, false);

    const parsedUrl = new URL(requestedUrl);
    assert.equal(parsedUrl.origin + parsedUrl.pathname, BRAVE_WEB_SEARCH_URL);
    assert.equal(parsedUrl.searchParams.get("q"), "Runloom agents");
    assert.equal(parsedUrl.searchParams.get("count"), "2");
    assert.equal(requestedInit?.method, "GET");
    assert.equal(requestedInit?.redirect, "error");
    assert.equal((requestedInit?.headers as Record<string, string>)["X-Subscription-Token"], "test-brave-key");
    assert.equal((requestedInit?.headers as Record<string, string>).accept, "application/json");
  });

  it("returns an empty result set without treating it as an error", async () => {
    const emptyWeb = await webSearch(
      { query: "nothing" },
      { apiKey: "test-key", fetch: async () => jsonResponse({ web: { results: [] } }) },
    );
    assert.deepEqual(emptyWeb, {
      ok: true,
      value: { query: "nothing", results: [], truncated: false },
    });

    const omittedWeb = await webSearch(
      { query: "discussions-only" },
      {
        apiKey: "test-key",
        fetch: async () =>
          jsonResponse({
            query: { original: "discussions-only", more_results_available: false },
            discussions: { results: [{ title: "forum" }] },
          }),
      },
    );
    assert.deepEqual(omittedWeb, {
      ok: true,
      value: { query: "discussions-only", results: [], truncated: false },
    });
  });

  it("caps results, filters non-http URLs, and reports truncation", async () => {
    const results = Array.from({ length: WEB_SEARCH_MAX_RESULTS + 2 }, (_, index) => ({
      title: `result ${index}`,
      url: `https://example.com/${index}`,
      description: `description ${index}`,
    }));
    results.splice(1, 0, { title: "private", url: "ftp://example.com/private", description: "skip" });
    const result = await webSearch(
      { query: "capped", limit: WEB_SEARCH_MAX_RESULTS },
      { apiKey: "test-key", fetch: async () => jsonResponse({ web: { results } }) },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.results.length, WEB_SEARCH_MAX_RESULTS);
    assert.equal(result.value.results.some(({ url }) => url.startsWith("ftp:")), false);
    assert.equal(result.value.truncated, true);
  });

  it("uses the provider more-results flag for truncation", async () => {
    const result = await webSearch(
      { query: "more" },
      {
        apiKey: "test-key",
        fetch: async () =>
          jsonResponse({
            query: { more_results_available: true },
            web: { results: [{ title: "one", url: "https://example.com/one", description: "one" }] },
          }),
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
  });

  it("rejects invalid input and missing credentials before fetching", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse({ web: { results: [] } });
    };
    for (const input of [
      { query: "" },
      { query: "   " },
      { query: "x", limit: 0 },
      { query: "x", limit: 11 },
      { query: "x", limit: 1.5 },
      { query: "x", limit: "1" as unknown as number },
    ]) {
      const result = await webSearch(input, { apiKey: "test-key", fetch });
      assert.equal(errorCode(result), "INVALID_INPUT");
    }
    const missingKey = await webSearch({ query: "x" }, { apiKey: "", fetch });
    assert.equal(errorCode(missingKey), "AUTH_FAILED");
    assert.equal(calls, 0);
  });

  it("maps authentication and rate-limit responses", async () => {
    const unauthorized = await webSearch(
      { query: "auth" },
      { apiKey: "bad-key", fetch: async () => jsonResponse({ message: "no" }, 401) },
    );
    assert.equal(errorCode(unauthorized), "AUTH_FAILED");
    if (!unauthorized.ok) assert.equal(unauthorized.error.status, 401);

    const rateLimited = await webSearch(
      { query: "rate" },
      { apiKey: "test-key", fetch: async () => jsonResponse({ message: "slow down" }, 429) },
    );
    assert.equal(errorCode(rateLimited), "RATE_LIMITED");
    if (!rateLimited.ok) assert.equal(rateLimited.error.status, 429);
  });

  it("maps malformed responses and network errors", async () => {
    const malformed = await webSearch(
      { query: "bad-json-shape" },
      { apiKey: "test-key", fetch: async () => jsonResponse(null) },
    );
    assert.equal(errorCode(malformed), "INVALID_RESPONSE");

    const network = await webSearch(
      { query: "offline" },
      {
        apiKey: "test-key",
        fetch: async () => {
          throw new Error("connection refused");
        },
      },
    );
    assert.equal(errorCode(network), "NETWORK_ERROR");
  });

  it("maps a request deadline to TIMEOUT and forwards its signal", async () => {
    let requestSignal: AbortSignal | undefined;
    const result = await webSearch(
      { query: "slow" },
      {
        apiKey: "test-key",
        timeoutMs: 5,
        fetch: (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        },
      },
    );
    assert.equal(errorCode(result), "TIMEOUT");
    assert.equal(requestSignal?.aborted, true);
  });
});
