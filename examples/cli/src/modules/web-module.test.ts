import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolExecutionOptions } from "ai";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import { createModuleHost } from "../module-host.js";
import type { ResolveWebHost, WebFetchResult } from "../web-fetch.js";
import { WEB_FETCH_TIMEOUT_MS } from "../web-fetch.js";
import { createWebModule, WEB_FETCH_TOOL_TIMEOUT_MS } from "./web-module.js";

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
