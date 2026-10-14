import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalMemoryEmbedder, normalizeLocalEmbeddingConfig, createMemoryEmbedder, normalizeEmbeddingConfig } from "./memory-embedding-client.js";

describe("explicit DashScope cloud embedding", () => {
  it("binds flash vectors to single-text requests when the provider returns zero for every index", async () => {
    const submitted: string[] = [];
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async (_url, init) => {
      const { input } = JSON.parse(init!.body as string);
      if (Array.isArray(input)) return new Response(JSON.stringify({ data: input.map(() => ({ index: 0, embedding: [1, 1] })) }));
      submitted.push(input);
      await new Promise(resolve => setTimeout(resolve, input === "甲" ? 15 : 1));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: ["甲乙丙".indexOf(input) + 1, 1] }],
        usage: { prompt_tokens: 2, total_tokens: 2 } }));
    });
    assert.deepEqual(await client.embed(["甲", "乙", "丙"], new AbortController().signal), [[1, 1], [2, 1], [3, 1]]);
    assert.deepEqual(submitted, ["甲", "乙", "丙"]);
    assert.deepEqual(client.lastUsage, { inputTokens: 6, totalTokens: 6 });
  });

  it("does not guess array order for an actual ambiguous flash response", async () => {
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async () =>
      new Response(JSON.stringify({ data: [0, 0, 0].map(index => ({ index, embedding: [1, 1] })) })));
    await assert.rejects(client.embed(["甲", "乙", "丙"], new AbortController().signal));
    assert.deepEqual(client.lastUsage, {});
  });

  it("bounds flash concurrency, preserves input order and does not dispatch duplicate texts as retries", async () => {
    let active = 0, peak = 0, calls = 0;
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async (_url, init) => {
      const { input } = JSON.parse(init!.body as string);
      calls++; peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, Number(input) % 2 ? 1 : 10));
      active--;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [Number(input) + 1, 1] }], usage: { total_tokens: 1 } }));
    });
    const texts = Array.from({ length: 21 }, (_, index) => String(index));
    assert.deepEqual(await client.embed(texts, new AbortController().signal), texts.map(text => [Number(text) + 1, 1]));
    assert.equal(calls, 21); assert.equal(peak, 10);
    assert.deepEqual(client.lastUsage, { totalTokens: 21 }, "missing prompt usage stays unknown");
    assert.equal(client.lastResponseMapping?.batchOffset, 20);
    assert.equal(client.requestMode, "single-input");
  });

  it("stops flash groups on failure or cancellation with no retry and no successful partial usage", async () => {
    let calls = 0;
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async (_url, init) => {
      calls++;
      const { input } = JSON.parse(init!.body as string);
      return input === "0" ? new Response("unavailable", { status: 503 })
        : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }], usage: { total_tokens: 1 } }));
    });
    await assert.rejects(client.embed(Array.from({ length: 21 }, (_, index) => String(index)), new AbortController().signal), /HTTP 503/);
    assert.equal(calls, 10, "only the first bounded group may have been dispatched");
    assert.deepEqual(client.lastUsage, {});
    const stop = new AbortController(); calls = 0;
    const cancelled = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async () => {
      calls++; stop.abort(Error("fixture cancelled"));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }] }));
    });
    await assert.rejects(cancelled.embed(Array(21).fill("事实"), stop.signal), /fixture cancelled/);
    assert.equal(calls, 1); assert.deepEqual(cancelled.lastUsage, {});
  });

  it("rejects inconsistent flash dimensions across separate requests and validates all texts before dispatch", async () => {
    let calls = 0;
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-key" }, async (_url, init) => {
      calls++;
      const { input } = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: input === "甲" ? [1, 1] : [1, 1, 1] }] }));
    });
    await assert.rejects(client.embed(["甲", "乙"], new AbortController().signal), /Inconsistent embedding dimensions/);
    assert.deepEqual(client.lastUsage, {});
    calls = 0;
    await assert.rejects(client.embed(["甲", "乙".repeat(4097)], new AbortController().signal), /input exceeds/);
    assert.equal(calls, 0);
  });

  it("restores batch order from canonical decimal strings or the documented text_index alias without guessing", async () => {
    for (const field of ["index", "text_index"]) {
      const client = createMemoryEmbedder({ provider: "dashscope", modelId: "text-embedding-v4" }, { DASHSCOPE_API_KEY: "fixture-key" }, async () =>
        new Response(JSON.stringify({ data: [2, 0, 1].map(index => ({ [field]: String(index), embedding: [index + 1, 1] })) })));
      assert.deepEqual(await client.embed(["甲", "乙", "丙"], new AbortController().signal), [[1, 1], [2, 1], [3, 1]]);
      assert.deepEqual(client.lastResponseMapping?.items, [2, 0, 1].map(value => ({ field, format: "string", value })));
    }
  });

  it("still rejects duplicate, ambiguous, missing, noncanonical and out-of-range indexes", async () => {
    for (const indexes of [["0", "0"], ["00", "1"], [" 0", "1"], ["0e0", "1"], ["0.0", "1"], ["0", "2"], [null, "1"], [undefined, "1"]]) {
      const client = createMemoryEmbedder({ provider: "dashscope", modelId: "text-embedding-v4" }, { DASHSCOPE_API_KEY: "fixture-key" }, async () =>
        new Response(JSON.stringify({ data: indexes.map(index => ({ index, embedding: [1, 1] })) })));
      await assert.rejects(client.embed(["甲", "乙"], new AbortController().signal), /Invalid embedding index/);
      assert.deepEqual(client.lastUsage, {});
    }
    const ambiguous = createMemoryEmbedder({ provider: "dashscope", modelId: "text-embedding-v4" }, { DASHSCOPE_API_KEY: "fixture-key" }, async () =>
      new Response(JSON.stringify({ data: [{ index: "0", text_index: 1, embedding: [1, 1] }, { index: "1", text_index: 0, embedding: [1, 1] }] })));
    await assert.rejects(ambiguous.embed(["甲", "乙"], new AbortController().signal), /Invalid embedding index/);
  });

  it("defaults only an explicit cloud selection and permits official regional workspace endpoints", () => {
    assert.deepEqual(normalizeEmbeddingConfig({ provider: "dashscope" }), {
      provider: "dashscope", modelId: "qwen3.7-text-embedding-flash", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    assert.equal(normalizeEmbeddingConfig({ provider: "dashscope", modelId: "text-embedding-v3" }).modelId,
      "text-embedding-v3", "explicit existing model selections must not be silently upgraded");
    assert.equal(normalizeEmbeddingConfig({}).provider, "local", "legacy opt-in must not start exporting to cloud");
    for (const host of ["dashscope-intl.aliyuncs.com", "fixture.cn-beijing.maas.aliyuncs.com", "fixture.ap-southeast-1.maas.aliyuncs.com", "fixture.cn-hongkong.maas.aliyuncs.com"]) {
      assert.equal(normalizeEmbeddingConfig({ provider: "dashscope", baseURL: `https://${host}/compatible-mode/v1/` }).baseURL,
        `https://${host}/compatible-mode/v1`);
    }
    for (const baseURL of ["http://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1",
      "https://evil.test/compatible-mode/v1", "https://dashscope.aliyuncs.com:8443/compatible-mode/v1",
      "https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1?key=secret",
      "https://dashscope.aliyuncs.com/other", "http://127.0.0.1/v1", "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"]) {
      assert.throws(() => normalizeEmbeddingConfig({ provider: "dashscope", baseURL }), /DashScope/);
    }
  });

  it("sends only the dedicated env key with no redirects and no key in cache identity", async () => {
    let calls = 0;
    const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-dashscope-key", OPENAI_API_KEY: "fixture-chat-key" }, async (url, init) => {
      calls++;
      assert.equal(String(url), "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
      assert.equal(init!.redirect, "error");
      assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer fixture-dashscope-key");
      assert.deepEqual(JSON.parse(init!.body as string), { model: "qwen3.7-text-embedding-flash", input: "合成事实", encoding_format: "float" });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 4 } }));
    });
    assert.deepEqual(await client.embed(["合成事实"], new AbortController().signal), [[1, 2]]);
    assert.equal(calls, 1);
    assert.deepEqual(client.lastUsage, { totalTokens: 4 });
    assert.ok(!client.modelId.includes("key"));
    assert.equal(client.modelId, createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "different-key" }).modelId);
  });

  it("does not inherit chat keys, fail startup or dispatch with missing/invalid dedicated credentials", async () => {
    for (const env of [{ OPENAI_API_KEY: "fixture-chat-key" }, { DASHSCOPE_API_KEY: " " }, { DASHSCOPE_API_KEY: "bad\nkey" }]) {
      let calls = 0;
      const client = createMemoryEmbedder({ provider: "dashscope" }, env, async () => { calls++; throw Error("should not dispatch"); });
      await assert.rejects(client.embed(["合成事实"], new AbortController().signal), /DASHSCOPE_API_KEY/);
      assert.equal(calls, 0);
      assert.deepEqual(client.lastUsage, {});
    }
    const local = createMemoryEmbedder({ provider: "local", modelId: "fixture" }, { DASHSCOPE_API_KEY: "fixture-key" }, async (_url, init) => {
      assert.equal((init!.headers as Record<string, string>).Authorization, undefined);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
    await local.embed(["合成事实"], new AbortController().signal);
  });

  it("never exposes provider bodies or transport secrets and never retries", async () => {
    for (const fail of [async () => new Response("fixture-secret-key", { status: 401 }),
      async () => { throw Error("fixture-secret-key"); }, async () => new Response("fixture-secret-key")]) {
      let calls = 0;
      const client = createMemoryEmbedder({ provider: "dashscope" }, { DASHSCOPE_API_KEY: "fixture-secret-key" }, async () => { calls++; return fail(); });
      await assert.rejects(client.embed(["合成事实"], new AbortController().signal), error => {
        assert.ok(error instanceof Error && !error.message.includes("fixture-secret-key")); return true;
      });
      assert.equal(calls, 1);
      assert.deepEqual(client.lastUsage, {});
    }
  });
});

describe("local compatible embedding client", () => {
  it("batches ten inputs, restores response order and never truncates text", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createLocalMemoryEmbedder({ baseURL: "http://127.0.0.1:11434/v1/", modelId: "fixture" }, async (url, init) => {
      requests.push({ url: String(url), init: init! });
      const { input, model } = JSON.parse(init!.body as string) as { input: string[]; model: string };
      assert.equal(model, "fixture");
      return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [text.length, 1] })).reverse(), usage: { prompt_tokens: 20, total_tokens: 20 } }));
    });
    const texts = Array.from({ length: 23 }, (_, i) => "原话".repeat(i + 1));
    assert.deepEqual(await client.embed(texts, new AbortController().signal), texts.map(text => [text.length, 1]));
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(request => JSON.parse(request.init.body as string).input.length), [10, 10, 3]);
    assert.ok(requests.every(request => request.url === "http://127.0.0.1:11434/v1/embeddings" && request.init.redirect === "error"));
    assert.ok(requests.every(request => !(request.init.headers as Record<string, string>).Authorization));
    assert.deepEqual(client.lastUsage, { inputTokens: 60, totalTokens: 60 });
  });

  it("uses endpoint and model identity without sending or inheriting keys", () => {
    const a = createLocalMemoryEmbedder({ baseURL: "http://127.0.0.1:11434/v1", modelId: "fixture" });
    const b = createLocalMemoryEmbedder({ baseURL: "http://127.0.0.1:11435/v1", modelId: "fixture" });
    assert.notEqual(a.modelId, b.modelId);
    for (const baseURL of ["https://example.com/v1", "http://0.0.0.0:11434/v1", "http://localhost.example.com/v1", "http://user:secret@127.0.0.1/v1", "http://127.0.0.1/v1?key=secret", "file:///tmp/vector"]) {
      assert.throws(() => normalizeLocalEmbeddingConfig({ baseURL, modelId: "fixture" }), /loopback/);
    }
    assert.equal(normalizeLocalEmbeddingConfig({ modelId: "fixture" }).baseURL, "http://127.0.0.1:11434/v1");
  });

  it("rejects malformed response indexes/vectors, oversized bodies and HTTP failures without retry", async () => {
    for (const response of [
      new Response("no", { status: 503 }),
      new Response(JSON.stringify({ data: [{ index: 1, embedding: [1, 0] }] })),
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] })),
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, "bad"] }] })),
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] })),
      new Response(" ".repeat(2 * 1024 * 1024 + 1)),
    ]) {
      let calls = 0;
      const client = createLocalMemoryEmbedder({ modelId: "fixture" }, async () => { calls++; return response; });
      await assert.rejects(client.embed(["事实"], new AbortController().signal));
      assert.equal(calls, 1);
      assert.equal(client.lastUsage.inputTokens, undefined);
    }
  });

  it("cancels before dispatch or between batches and preserves missing usage as unknown", async () => {
    const stop = new AbortController();
    let calls = 0;
    const client = createLocalMemoryEmbedder({ modelId: "fixture" }, async (_url, init) => {
      calls++;
      const { input } = JSON.parse(init!.body as string) as { input: string[] };
      stop.abort(new Error("cancelled"));
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    });
    await assert.rejects(client.embed(Array(11).fill("事实"), stop.signal), /cancelled/);
    assert.equal(calls, 1);
    await assert.rejects(client.embed(["事实"], stop.signal), /cancelled/);
    assert.equal(calls, 1);
    const noUsage = createLocalMemoryEmbedder({ modelId: "fixture" }, async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
    await noUsage.embed(["事实"], new AbortController().signal);
    assert.deepEqual(noUsage.lastUsage, {});
  });

  it("cancels a stalled response reader even when its transport ignores the signal", async () => {
    let cancelCalled = false;
    let dispatched: (() => void) | undefined;
    const requestStarted = new Promise<void>(resolve => { dispatched = resolve; });
    const stop = new AbortController();
    const client = createLocalMemoryEmbedder({ modelId: "fixture" }, async () => {
      dispatched!();
      return new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelCalled = true; return new Promise(() => {}); },
      }));
    });
    const result = client.embed(["事实"], stop.signal);
    await requestStarted;
    stop.abort(new Error("reader cancelled"));
    await assert.rejects(Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(Error("reader cancellation hung")), 100))]), /reader cancelled/);
    assert.equal(cancelCalled, true);
  });

  it("rejects zero-norm underflow vectors before reporting success", async () => {
    const client = createLocalMemoryEmbedder({ modelId: "fixture" }, async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1e-300] }] })));
    await assert.rejects(client.embed(["事实"], new AbortController().signal), /Invalid embedding/);
  });

  it("does not present partial usage as a complete successful embedding after a later batch fails", async () => {
    let calls = 0;
    const client = createLocalMemoryEmbedder({ modelId: "fixture" }, async (_url, init) => {
      calls++;
      if (calls === 2) return new Response("unavailable", { status: 503 });
      const { input } = JSON.parse(init!.body as string) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 100, total_tokens: 100 } }));
    });
    await assert.rejects(client.embed(Array(11).fill("事实"), new AbortController().signal), /HTTP 503/);
    assert.equal(calls, 2);
    assert.deepEqual(client.lastUsage, {});
  });
});
