import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEED_DEFAULT_LIMIT,
  readFeed,
  feedReadInputSchema,
  feedReadResultSchema,
} from "./feed-read.js";
import type { ResolveWebHost, WebFetchOptions } from "./web-fetch.js";

const NOW = new Date("2026-09-24T08:00:00.000Z");
const FEED_URL = "https://example.com/blog/feed.xml";

function options(body: string, contentType = "text/xml"): WebFetchOptions {
  return {
    now: () => NOW,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as ResolveWebHost,
    fetch: (async () => new Response(body, {
      headers: { "content-type": `${contentType}; charset=utf-8` },
    })) as typeof globalThis.fetch,
  };
}

describe("readFeed", () => {
  it("maps RSS 2.0 in document order, skips missing titles, resolves relative links, and bounds fields", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>Example</title>
        <item><title>First</title><guid>guid-1</guid><link>/one</link>
          <pubDate>Wed, 24 Sep 2026 08:00:00 GMT</pubDate><description>first &amp; best</description></item>
        <item><link>/untitled</link></item>
        <item><title>Second</title><link>https://10.0.0.1/private</link><description>${"z".repeat(2_010)}</description></item>
        <item><title>Third</title><link>file:///etc/passwd</link></item>
      </channel></rss>`;
    const result = await readFeed({ url: FEED_URL, limit: 2 }, options(xml));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(feedReadResultSchema.safeParse(result).success, true);
    assert.equal(result.value.format, "rss2");
    assert.equal(result.value.feedTitle, "Example");
    assert.equal(result.value.requestedUrl, FEED_URL);
    assert.equal(result.value.fetchedAt, NOW.toISOString());
    assert.deepEqual(result.value.items.map(({ title, url }) => ({ title, url })), [
      { title: "First", url: "https://example.com/one" },
      { title: "Second", url: null },
    ]);
    assert.equal(result.value.items[0]?.summary, "first & best");
    assert.equal(result.value.items[1]?.summary?.length, 2_000);
    assert.equal(result.value.truncated, true);
  });

  it("maps Atom with alternate link priority and no date sorting", async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Journal</title>
      <entry><title>Old</title><id>tag:old</id><updated>2020-01-01</updated>
        <link rel="enclosure" href="https://example.com/media"/>
        <link rel="alternate" href="../old"/><summary>Some <b>text</b></summary></entry>
      <entry><title>New</title><published>2026-09-24</published>
        <link rel="alternate" href="file:///etc/passwd"/>
        <link rel="related" href="https://example.com/new"/></entry>
    </feed>`;
    const result = await readFeed({ url: FEED_URL }, options(xml, "application/atom+xml"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.format, "atom");
    assert.equal(result.value.items.length, 2);
    assert.deepEqual(result.value.items.map(({ title, url }) => ({ title, url })), [
      { title: "Old", url: "https://example.com/old" },
      { title: "New", url: "https://example.com/new" },
    ]);
    assert.equal(result.value.items[0]?.summary, "Some text");
    assert.equal(result.value.truncated, false);
  });

  it("defaults to ten entries, and truncated only means more than the local limit", async () => {
    const xml = `<rss version="2.0"><channel>${Array.from({ length: FEED_DEFAULT_LIMIT + 1 }, (_, n) =>
      `<item><title>Item ${n}</title></item>`).join("")}</channel></rss>`;
    const result = await readFeed({ url: FEED_URL }, options(xml, "text/html"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.items.length, FEED_DEFAULT_LIMIT);
    assert.equal(result.value.truncated, true);
  });

  it("rejects DTD, external entities, invalid XML, other roots, and declared non-UTF8", async () => {
    for (const xml of [
      `<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel><title>&secret;</title></channel></rss>`,
      `<rss version="2.0"><channel><item></channel></rss>`,
      `<html><body>Not a feed</body></html>`,
      `<rss version="1.0"><channel/></rss>`,
      `<rss version="2.1"><channel/></rss>`,
      `<feed><title>Missing Atom namespace</title></feed>`,
    ]) {
      const result = await readFeed({ url: FEED_URL }, options(xml));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_FEED");
    }
    const latin = await readFeed({ url: FEED_URL }, options(
      `<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel/></rss>`,
    ));
    assert.equal(latin.ok, false);
    if (!latin.ok) assert.equal(latin.error.code, "UNSUPPORTED_ENCODING");
  });

  it("rejects oversized raw response rather than parsing a partial feed", async () => {
    const xml = `<rss version="2.0"><channel>${" ".repeat(512 * 1024)}<item><title>tail</title></item></channel></rss>`;
    const result = await readFeed({ url: FEED_URL }, options(xml));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "FEED_INCOMPLETE");
  });

  it("rejects local and DNS-private item links without fetching those articles", async () => {
    let requestCount = 0;
    const xml = `<rss version="2.0"><channel>
      <item><title>Private host</title><link>https://private.example.net/article</link></item>
      <item><title>Local name</title><link>http://localhost/article</link></item>
      <item><title>Public</title><link>https://example.com/article</link></item>
    </channel></rss>`;
    const base = options(xml);
    const result = await readFeed({ url: FEED_URL }, {
      ...base,
      fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
        requestCount += 1;
        return base.fetch!(...args);
      }) as typeof globalThis.fetch,
      resolveHost: (async (host) => [{
        address: host === "private.example.net" ? "10.0.0.2" : "93.184.216.34",
        family: 4,
      }]) as ResolveWebHost,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.items.map((item) => item.url), [
      null,
      null,
      "https://example.com/article",
    ]);
    assert.equal(requestCount, 1);
  });

  it("validates limit before network and rejects invalid tool input", async () => {
    assert.equal(feedReadInputSchema.safeParse({ url: FEED_URL, limit: 21 }).success, false);
    const result = await readFeed({ url: FEED_URL, limit: 21 }, options(""));
    assert.equal(result.ok, false);
  });
});
