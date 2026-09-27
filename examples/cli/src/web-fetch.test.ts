import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WEB_FETCH_MAX_TEXT_BYTES,
  fetchFeedDocument,
  fetchWebPage,
  validatePublicFeedItemUrl,
  validatePublicWebUrl,
  type ResolveWebHost,
} from "./web-fetch.js";

const NOW = new Date("2026-09-19T04:00:00.000Z");

function safeResolver(address = "93.184.216.34"): ResolveWebHost {
  return async () => [{ address, family: 4 }];
}

function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

describe("fetchWebPage", () => {
  it("fetches one public URL with GET and returns provenance", async () => {
    let requested: { url: string; init: RequestInit | undefined } | undefined;
    const result = await fetchWebPage(
      { url: "https://example.com/article" },
      {
        now: () => NOW,
        resolveHost: safeResolver(),
        fetch: (async (url, init) => {
          requested = { url: String(url), init };
          return response("hello world");
        }) as typeof globalThis.fetch,
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      status: 200,
      contentType: "text/plain",
      fetchedAt: NOW.toISOString(),
      text: "hello world",
      truncated: false,
    });
    assert.equal(requested?.url, "https://example.com/article");
    assert.equal(requested?.init?.method, "GET");
    assert.equal(requested?.init?.redirect, "manual");
  });

  it("rejects private, localhost, credentials, and non-http targets before fetching", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return response("must not be fetched");
    }) as typeof globalThis.fetch;
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://metadata.google.internal/computeMetadata/v1",
      "http://10.0.0.2/private",
      "https://user:password@example.com/",
      "file:///tmp/secret.txt",
    ]) {
      const result = await fetchWebPage({ url }, { fetch, resolveHost: safeResolver() });
      assert.equal(result.ok, false, url);
      if (!result.ok) assert.equal(result.error.code, url.startsWith("https://user") || url.startsWith("file:") ? "INVALID_URL" : "TARGET_BLOCKED");
    }
    assert.equal(calls, 0);
  });

  it("rejects a hostname resolving to a private address", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://public-looking.example/" },
      {
        resolveHost: safeResolver("192.168.1.20"),
        fetch: (async () => {
          calls += 1;
          return response("must not be fetched");
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TARGET_BLOCKED");
    assert.equal(calls, 0);
  });

  it("allows a public hostname whose DNS answer is Clash fake-ip", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://nodejs.org/api/documentation.html" },
      {
        resolveHost: safeResolver("198.18.0.24"),
        fetch: (async () => {
          calls += 1;
          return response("Node.js documentation");
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    if (result.ok) {
      assert.equal(result.value.finalUrl, "https://nodejs.org/api/documentation.html");
      assert.equal(result.value.text, "Node.js documentation");
    }
  });

  it("allows a public hostname whose IPv4-mapped DNS answer is Clash fake-ip", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://nodejs.org/api/documentation.html" },
      {
        resolveHost: async () => [{ address: "::ffff:198.18.0.24", family: 6 }],
        fetch: (async () => {
          calls += 1;
          return response("Node.js documentation");
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  });

  it("still blocks a fake-ip address used as the URL host", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://198.18.0.24/" },
      {
        resolveHost: safeResolver("93.184.216.34"),
        fetch: (async () => {
          calls += 1;
          return response("must not be fetched");
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TARGET_BLOCKED");
    assert.equal(calls, 0);
  });

  it("still blocks a hostname that also resolves to RFC1918", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://mixed.example/" },
      {
        resolveHost: async () => [
          { address: "198.18.0.24", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
        fetch: (async () => {
          calls += 1;
          return response("must not be fetched");
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TARGET_BLOCKED");
    assert.equal(calls, 0);
  });

  it("revalidates every redirect and blocks a private redirect target", async () => {
    const urls: string[] = [];
    const result = await fetchWebPage(
      { url: "https://example.com/start" },
      {
        resolveHost: safeResolver(),
        fetch: (async (url) => {
          urls.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
          });
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TARGET_BLOCKED");
    assert.deepEqual(urls, ["https://example.com/start"]);
  });

  it("does not follow a redirect outside the authorized origins", async () => {
    const urls: string[] = [];
    const result = await fetchWebPage(
      { url: "https://example.com/start" },
      {
        allowedOrigins: ["https://example.com"],
        resolveHost: safeResolver(),
        fetch: (async (url) => {
          urls.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example/article" },
          });
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "ORIGIN_NOT_AUTHORIZED");
    assert.deepEqual(urls, ["https://example.com/start"]);
  });

  it("stops after five redirects", async () => {
    let calls = 0;
    const result = await fetchWebPage(
      { url: "https://example.com/0" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://example.com/${calls}` },
          });
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "REDIRECT_LIMIT");
    assert.equal(calls, 6);
  });

  it("extracts HTML and marks a response truncated at the text budget", async () => {
    const html = `<html><head><style>hide</style><script>bad()</script></head><body><h1>Title</h1><p>${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES)}</p></body></html>`;
    const result = await fetchWebPage(
      { url: "https://example.com/page" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response(html, 200, { "content-type": "text/html; charset=utf-8" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.text, /^Title/);
    assert.equal(result.value.text.includes("hide"), false);
    assert.equal(result.value.text.includes("bad()"), false);
    assert.equal(result.value.truncated, true);
    assert.ok(new TextEncoder().encode(result.value.text).byteLength <= WEB_FETCH_MAX_TEXT_BYTES);
  });

  it("truncates at the text budget without splitting a multi-byte character", async () => {
    const html = `<html><body><p>${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES - 1)}😀</p></body></html>`;
    const result = await fetchWebPage(
      { url: "https://example.com/page" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response(html, 200, { "content-type": "text/html; charset=utf-8" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const bytes = new TextEncoder().encode(result.value.text);
    assert.equal(result.value.truncated, true);
    assert.ok(bytes.byteLength <= WEB_FETCH_MAX_TEXT_BYTES, `got ${bytes.byteLength}`);
    assert.equal(result.value.text.includes("\uFFFD"), false);
  });

  it("drops the whole multi-byte character when the budget lands inside its sequence", async () => {
    // Budget ends after the lead byte and one continuation byte of a 3-byte
    // character, so only the trailing sequence is incomplete.
    const html = `<html><body><p>${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES - 2)}你</p></body></html>`;
    const result = await fetchWebPage(
      { url: "https://example.com/page" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response(html, 200, { "content-type": "text/html; charset=utf-8" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const bytes = new TextEncoder().encode(result.value.text);
    assert.equal(result.value.truncated, true);
    assert.ok(bytes.byteLength <= WEB_FETCH_MAX_TEXT_BYTES, `got ${bytes.byteLength}`);
    assert.equal(result.value.text.includes("\uFFFD"), false);
    assert.equal(result.value.text, "x".repeat(WEB_FETCH_MAX_TEXT_BYTES - 2));
  });

  it("keeps a complete multi-byte character that ends exactly at the text budget", async () => {
    const html = `<html><body><p>${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES - 3)}你z</p></body></html>`;
    const result = await fetchWebPage(
      { url: "https://example.com/page" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response(html, 200, { "content-type": "text/html; charset=utf-8" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const bytes = new TextEncoder().encode(result.value.text);
    assert.equal(result.value.truncated, true);
    assert.ok(bytes.byteLength <= WEB_FETCH_MAX_TEXT_BYTES, `got ${bytes.byteLength}`);
    assert.equal(result.value.text.includes("\uFFFD"), false);
    assert.equal(result.value.text, `${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES - 3)}你`);
  });

  it("marks a body beyond the raw response budget as truncated", async () => {
    const result = await fetchWebPage(
      { url: "https://example.com/large" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response("a".repeat(WEB_FETCH_MAX_RESPONSE_BYTES + 1))) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
    assert.equal(new TextEncoder().encode(result.value.text).byteLength, WEB_FETCH_MAX_TEXT_BYTES);
  });

  it("returns explicit HTTP and content-type failures", async () => {
    const notFound = await fetchWebPage(
      { url: "https://example.com/missing" },
      { resolveHost: safeResolver(), fetch: (async () => response("no", 404)) as typeof globalThis.fetch },
    );
    assert.equal(notFound.ok, false);
    if (!notFound.ok) {
      assert.equal(notFound.error.code, "HTTP_STATUS");
      assert.equal(notFound.error.status, 404);
    }

    const binary = await fetchWebPage(
      { url: "https://example.com/image" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response("PNG", 200, { "content-type": "image/png" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(binary.ok, false);
    if (!binary.ok) assert.equal(binary.error.code, "UNSUPPORTED_CONTENT_TYPE");
  });

  it("maps the request deadline to TIMEOUT", async () => {
    const result = await fetchWebPage(
      { url: "https://example.com/slow" },
      {
        timeoutMs: 5,
        resolveHost: safeResolver(),
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TIMEOUT");
  });
});

describe("fetchFeedDocument", () => {
  it("preserves XML mislabeled as HTML, including content beyond the page text cap", async () => {
    const xml = `<rss><channel><item><title>${"x".repeat(WEB_FETCH_MAX_TEXT_BYTES)}</title></item></channel></rss>`;
    const result = await fetchFeedDocument(
      { url: "https://example.com/feed" },
      {
        now: () => NOW,
        resolveHost: safeResolver(),
        fetch: (async () => response(xml, 200, { "content-type": "text/html; charset=utf-8" })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, xml);
    assert.equal(result.value.truncated, false);
    assert.equal(result.value.contentType, "text/html");
    assert.equal(result.value.fetchedAt, NOW.toISOString());
  });

  it("signals the 512 KiB raw cap without pretending a partial feed is complete", async () => {
    const result = await fetchFeedDocument(
      { url: "https://example.com/feed" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response("x".repeat(WEB_FETCH_MAX_RESPONSE_BYTES + 1), 200, {
          "content-type": "application/rss+xml",
        })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
    assert.equal(new TextEncoder().encode(result.value.text).byteLength, WEB_FETCH_MAX_RESPONSE_BYTES);
  });

  it("rejects a non-UTF-8 feed without attempting to transcode", async () => {
    const result = await fetchFeedDocument(
      { url: "https://example.com/feed" },
      {
        resolveHost: safeResolver(),
        fetch: (async () => response("<rss/>", 200, {
          "content-type": "text/xml; charset=iso-8859-1",
        })) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "UNSUPPORTED_CONTENT_TYPE");
  });

  it("blocks a private redirect before making a second request", async () => {
    const requests: string[] = [];
    const result = await fetchFeedDocument(
      { url: "https://example.com/feed" },
      {
        resolveHost: safeResolver(),
        fetch: (async (url) => {
          requests.push(String(url));
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/feed" } });
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TARGET_BLOCKED");
    assert.deepEqual(requests, ["https://example.com/feed"]);
  });
});

describe("feed item URL validation", () => {
  it("rejects non-HTTP, credentialed, local and private IP targets", async () => {
    for (const url of ["file:///tmp/a", "https://u:p@example.com/", "http://localhost/x", "https://10.0.0.1/x"]) {
      assert.equal(validatePublicWebUrl(url), null);
      assert.equal(await validatePublicFeedItemUrl(url, { resolveHost: safeResolver() }), null);
    }
  });

  it("checks DNS and retains the fake-IP resolver exception", async () => {
    assert.equal(await validatePublicFeedItemUrl("https://public.example/a", {
      resolveHost: safeResolver("192.168.1.2"),
    }), null);
    assert.equal(await validatePublicFeedItemUrl("https://public.example/a", {
      resolveHost: safeResolver("198.18.0.24"),
    }), "https://public.example/a");
  });
});
