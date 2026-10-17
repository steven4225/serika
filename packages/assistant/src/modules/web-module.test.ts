import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolExecutionOptions } from "ai";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { createModuleHost } from "../module-host.js";
import type { ResolveWebHost, WebFetchResult } from "../web-fetch.js";
import { WEB_FETCH_TIMEOUT_MS } from "../web-fetch.js";
import { WEB_SEARCH_TIMEOUT_MS } from "../web-search.js";
import { FEED_READ_TIMEOUT_MS, type FeedReadResult } from "../feed-read.js";
import {
  createWebModule,
  FEED_READ_TOOL_TIMEOUT_MS,
  WEB_FETCH_TOOL_TIMEOUT_MS,
  WEB_SEARCH_TOOL_TIMEOUT_MS,
} from "./web-module.js";

function toolOptions(
  signal = new AbortController().signal,
): ToolExecutionOptions<unknown> {
  return {
    toolCallId: "call-web-fetch",
    messages: [],
    abortSignal: signal,
    context: {},
  };
}

function executeTool(
  registeredTool: RegisteredTool["tool"],
  input: unknown,
  options: unknown,
): Promise<unknown> {
  const execute = registeredTool.execute as unknown as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, options);
}

function makeResponse(
  text: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(text, {
    status,
    headers: { "content-type": contentType },
  });
}

const safeResolver: ResolveWebHost = async () => [
  { address: "93.184.216.34", family: 4 },
];

describe("createWebModule", () => {
  it("keeps only web_fetch when search is disabled", () => {
    const host = createModuleHost(
      [createWebModule({ searchEnabled: false })],
      { notify: () => undefined },
    );

    assert.deepEqual(host.tools.map(({ metadata }) => metadata), [
      {
        name: "web_fetch",
        version: "1",
        risk: "read",
        timeoutMs: WEB_FETCH_TOOL_TIMEOUT_MS,
        idempotent: true,
      },
    ]);
    host.dispose();
  });

  it("registers web_search when enabled without a provider key", () => {
    const host = createModuleHost(
      [
        createWebModule({
          searchEnabled: true,
        }),
      ],
      { notify: () => undefined },
    );

    assert.deepEqual(host.tools.map(({ metadata }) => metadata), [
      {
        name: "web_fetch",
        version: "1",
        risk: "read",
        timeoutMs: WEB_FETCH_TOOL_TIMEOUT_MS,
        idempotent: true,
      },
      {
        name: "web_search",
        version: "1",
        risk: "read",
        timeoutMs: WEB_SEARCH_TOOL_TIMEOUT_MS,
        idempotent: true,
      },
    ]);

    const search = host.tools[1];
    assert.ok(search);
    const schema = search.tool.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(schema.safeParse({ query: "runloom" }).success, true);
    assert.equal(schema.safeParse({ query: "" }).success, false);
    assert.equal(schema.safeParse({ query: "runloom", limit: 11 }).success, false);
    assert.ok(WEB_SEARCH_TOOL_TIMEOUT_MS > WEB_SEARCH_TIMEOUT_MS);
    host.dispose();
  });

  it("registers feed_read only when enabled and reads raw RSS through the shared transport", async () => {
    const requests: string[] = [];
    const host = createModuleHost(
      [createWebModule({
        feedEnabled: true,
        fetch: async (input) => {
          requests.push(String(input));
          return makeResponse(
            '<rss version="2.0"><channel><title>News</title><item><title>One</title><link>/one</link></item></channel></rss>',
            200,
            "text/xml; charset=utf-8",
          );
        },
        resolveHost: safeResolver,
      })],
      { notify: () => undefined },
    );

    assert.deepEqual(host.tools.map(({ metadata }) => metadata.name), ["web_fetch", "feed_read"]);
    const registered = host.tools[1];
    assert.ok(registered);
    assert.deepEqual(registered.metadata, {
      name: "feed_read",
      version: "1",
      risk: "read",
      timeoutMs: FEED_READ_TOOL_TIMEOUT_MS,
      idempotent: true,
    });
    assert.ok(FEED_READ_TOOL_TIMEOUT_MS > FEED_READ_TIMEOUT_MS);
    const schema = registered.tool.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(schema.safeParse({ url: "https://example.com/feed.xml", limit: 2 }).success, true);
    assert.equal(schema.safeParse({ url: "https://example.com/feed.xml", limit: 21 }).success, false);

    const result = (await executeTool(
      registered.tool,
      { url: "https://example.com/feed.xml" },
      toolOptions(),
    )) as FeedReadResult;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.feedTitle, "News");
      assert.deepEqual(result.value.items.map((item) => item.url), ["https://example.com/one"]);
    }
    assert.deepEqual(requests, ["https://example.com/feed.xml"]);
    host.dispose();
  });

  it("registers one read-only idempotent web_fetch tool", async () => {
    const requests: string[] = [];
    const host = createModuleHost(
      [
        createWebModule({
        fetch: async (input) => {
            requests.push(String(input));
            return makeResponse("<h1>Hello</h1><p>World</p>");
          },
          resolveHost: safeResolver,
        }),
      ],
      { notify: () => undefined },
    );

    assert.deepEqual(host.tools.map(({ metadata }) => metadata), [
      {
        name: "web_fetch",
        version: "1",
        risk: "read",
        timeoutMs: WEB_FETCH_TOOL_TIMEOUT_MS,
        idempotent: true,
      },
    ]);
    assert.equal(host.commands.size, 0);
    assert.ok(WEB_FETCH_TOOL_TIMEOUT_MS > WEB_FETCH_TIMEOUT_MS);

    const registered = host.tools[0];
    assert.ok(registered);
    const schema = registered.tool.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(schema.safeParse({ url: "https://example.com" }).success, true);
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(
      schema.safeParse({ url: "https://example.com", extra: true }).success,
      false,
    );

    const result = (await executeTool(
      registered.tool,
      { url: "https://example.com" },
      toolOptions(),
    )) as WebFetchResult;
    assert.equal(result.ok, true);
    assert.deepEqual(requests, ["https://example.com/"]);
    host.dispose();
  });

  it("forwards the Tool AbortSignal to the web fetch helper", async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveRequest: ((response: Response) => void) | undefined;
    const host = createModuleHost(
      [
        createWebModule({
        fetch: async (_input, init) => {
            requestSignal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => {
              resolveRequest = resolve;
            });
          },
          resolveHost: safeResolver,
        }),
      ],
      { notify: () => undefined },
    );
    const registered = host.tools[0];
    assert.ok(registered);
    const controller = new AbortController();
    const pending = executeTool(
      registered.tool,
      { url: "https://example.com" },
      toolOptions(controller.signal),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(requestSignal);
    controller.abort(new Error("stop web fetch"));
    assert.equal(requestSignal.aborted, true);
    assert.ok(resolveRequest);
    resolveRequest(makeResponse("<p>late</p>"));
    await assert.rejects(pending, { message: "stop web fetch" });
    host.dispose();
  });

  it("returns the helper's structured failure unchanged", async () => {
    const host = createModuleHost(
      [
        createWebModule({
        fetch: async () => makeResponse("blocked", 403, "text/plain"),
        resolveHost: safeResolver,
        }),
      ],
      { notify: () => undefined },
    );
    const registered = host.tools[0];
    assert.ok(registered);

    const result = (await executeTool(
      registered.tool,
      { url: "https://example.com/private" },
      toolOptions(),
    )) as WebFetchResult;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "HTTP_STATUS");
    host.dispose();
  });

  it("fetches a y/n origin even when another origin was authorized for the Run", async () => {
    const requests: string[] = [];
    const host = createModuleHost(
      [
        createWebModule({
          fetch: async (input) => {
            requests.push(String(input));
            return makeResponse("<p>ok</p>", 200, "text/plain");
          },
          resolveHost: safeResolver,
        }),
      ],
      { notify: () => undefined },
    );
    const registered = host.tools[0];
    assert.ok(registered);

    const result = (await executeTool(
      registered.tool,
      { url: "https://other.example/article" },
      toolOptions(),
    )) as WebFetchResult;
    assert.equal(result.ok, true);
    assert.deepEqual(requests, ["https://other.example/article"]);
    host.dispose();
  });
});
