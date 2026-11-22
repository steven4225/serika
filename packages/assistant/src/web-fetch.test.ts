import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import { createServer } from "node:https";
import { type LookupFunction } from "node:net";
import { describe, it } from "node:test";
import tls from "node:tls";
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

// Self-signed test identity for dial.example only.
const TLS_FIXTURE = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBPCw8IfQGp9TE7KX
JXsu1e3DWhqvlpqKDmrOnsuifUqhRANCAATq0ycEoPwqBVlmZv4bUCQ0yxRdFaWV
vrjrj4dOh7Fd7Cl4HRtsatl+XZG9UgAiVeVkLD8TVb8dpeFlYGtFrJgN
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBnjCCAUSgAwIBAgIUMTP+1w9zk5875c1HxL7U9dux1s8wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZGlhbC5leGFtcGxlMCAXDTIwMDEwMTAwMDAwMFoYDzIxMjYw
MTAxMDAwMDAwWjAXMRUwEwYDVQQDDAxkaWFsLmV4YW1wbGUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATq0ycEoPwqBVlmZv4bUCQ0yxRdFaWVvrjrj4dOh7Fd7Cl4
HRtsatl+XZG9UgAiVeVkLD8TVb8dpeFlYGtFrJgNo2wwajAdBgNVHQ4EFgQUgjIv
NeXyQ/lZEt8VHJWU35zeYGYwHwYDVR0jBBgwFoAUgjIvNeXyQ/lZEt8VHJWU35ze
YGYwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxkaWFsLmV4YW1wbGUwCgYI
KoZIzj0EAwIDSAAwRQIhALp1eQpGfDKXmPKEag/K34K8aiDLLT3fXRwCRHGVCPaP
AiBxovAyf65yTrgYWJYFS4pJP3dX6p0fEFvIfap205w32w==
-----END CERTIFICATE-----`,
};

// Intercept the final TCP dial so every candidate fails offline, even on the old transport.
const { TCP }: { TCP: { prototype: {
  connect(request: unknown, address: string, port: number): number;
  connect6(request: unknown, address: string, port: number): number;
} } } = Reflect.get(process, "binding")("tcp_wrap");

function safeResolver(address = "93.184.216.34"): ResolveWebHost {
  return async () => [{ address, family: 4 }];
}

const laterLookup: LookupFunction = (_host, options, callback) => {
  queueMicrotask(() => options.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4));
};

function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

describe("fetchWebPage", () => {
  it("dials only the validated IPv4 and IPv6 candidates, including on fallback", async (t) => {
    const attempts: string[] = [];
    const refuse = (_request: unknown, address: string) => {
      attempts.push(address);
      return -1;
    };
    t.mock.method(TCP.prototype, "connect", refuse);
    t.mock.method(TCP.prototype, "connect6", refuse);
    t.mock.method(dns, "lookup", laterLookup);

    const result = await fetchWebPage({ url: "http://dial.example/" }, {
      resolveHost: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700::1111", family: 6 },
        { address: "1.1.1.1", family: 4 },
      ],
    });

    assert.deepEqual(attempts, ["93.184.216.34", "2606:4700::1111", "1.1.1.1"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "NETWORK_ERROR");
  });

  it("binds each HTTPS hop while preserving Host, SNI, and certificate checks", async (t) => {
    const requests: { host: string | undefined; sni: string | false | null }[] = [];
    const controller = new AbortController();
    const abortReason = new Error("cancel fixture request");
    const server = createServer(TLS_FIXTURE, (request, reply) => {
      const sni = request.socket instanceof tls.TLSSocket ? request.socket.servername : false;
      requests.push({ host: request.headers.host, sni });
      if (request.url === "/start") reply.writeHead(302, { location: "/article" }).end();
      else if (request.url === "/cancel") controller.abort(abortReason);
      else reply.writeHead(200, { "content-type": "text/plain" }).end("fixture page");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const endpoint = server.address();
    assert.ok(endpoint !== null && typeof endpoint === "object");

    const attempts: string[] = [];
    const connect = TCP.prototype.connect;
    t.mock.method(TCP.prototype, "connect", function (
      this: typeof TCP.prototype, request: unknown, address: string, port: number,
    ) {
      attempts.push(address);
      // Redirect only the fixture's validated candidates to the local TLS server.
      if (port !== endpoint.port || (address !== "93.184.216.34" && address !== "198.18.0.24")) return -1;
      return connect.call(this, request, "127.0.0.1", port);
    });
    t.mock.method(TCP.prototype, "connect6", () => -1);
    t.mock.method(dns, "lookup", laterLookup);
    let trustFixture = true;
    const tlsConnect = tls.connect;
    t.mock.method(tls, "connect", (options: tls.ConnectionOptions) =>
      tlsConnect({ ...options, ...(trustFixture ? { ca: TLS_FIXTURE.cert } : {}) }));

    let resolutions = 0;
    const result = await fetchWebPage({ url: `https://dial.example:${endpoint.port}/start` }, {
      resolveHost: async () => [{ address: ++resolutions === 1 ? "93.184.216.34" : "198.18.0.24", family: 4 }],
    });
    assert.deepEqual(attempts, ["93.184.216.34", "198.18.0.24"]);
    assert.ok(result.ok);
    assert.equal(result.value.finalUrl, `https://dial.example:${endpoint.port}/article`);
    assert.equal(result.value.text, "fixture page");
    const identity = { host: `dial.example:${endpoint.port}`, sni: "dial.example" };
    assert.deepEqual(requests, [identity, identity]);

    const wrongHost = await fetchWebPage({ url: `https://other.example:${endpoint.port}/` }, {
      resolveHost: safeResolver(),
    });
    assert.ok(!wrongHost.ok);
    assert.equal(wrongHost.error.code, "NETWORK_ERROR");
    trustFixture = false;
    const untrusted = await fetchWebPage({ url: `https://dial.example:${endpoint.port}/` }, {
      resolveHost: safeResolver(),
    });
    assert.ok(!untrusted.ok);
    assert.equal(untrusted.error.code, "NETWORK_ERROR");
    assert.deepEqual(attempts.slice(2), ["93.184.216.34", "93.184.216.34"]);
    assert.deepEqual(requests, [identity, identity]);

    trustFixture = true;
    await assert.rejects(fetchWebPage({ url: `https://dial.example:${endpoint.port}/cancel` }, {
      resolveHost: safeResolver(),
      signal: controller.signal,
    }), (error) => error === abortReason);
    assert.deepEqual(requests, [identity, identity, identity]);
  });

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

  it("rejects redirect targets in blocked address ranges before dispatch", async () => {
    for (const location of [
      "http://10.0.0.2/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "http://next.example/",
    ]) {
      const requests: string[] = [];
      const result = await fetchWebPage({ url: "http://start.example/" }, {
        resolveHost: async (host) => host === "start.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "::ffff:192.168.1.3", family: 6 }],
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(null, { status: 302, headers: { location } });
        },
      });
      assert.ok(!result.ok, location);
      assert.equal(result.error.code, "TARGET_BLOCKED");
      assert.deepEqual(requests, ["http://start.example/"]);
    }
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
