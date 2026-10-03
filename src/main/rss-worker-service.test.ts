import assert from "node:assert/strict";
import { it } from "node:test";
import { createDesktopRssWorker } from "./rss-worker-service.js";

it("desktop service never starts implicitly, rejects IPC paths/options and requires trusted credential-file paths", async () => {
  const worker = createDesktopRssWorker({ workspace: "/private/tmp/test", home: "/private/tmp/home", env: { COMMAND_CODE_API_KEY: "SECRET_FIXTURE" }, workerEntry: "/private/tmp/entry.js", platform: "darwin" });
  const invalid = await worker.setEnabled({ enabled: true, nodePath: "/untrusted" });
  assert(!invalid.ok);
  const status = await worker.status(); assert(!status.ok);
  assert.match(status.message, /RUNLOOM_WORKER_NODE/);
  assert.doesNotMatch(status.message, /SECRET_FIXTURE/);
  const enabled = await worker.setEnabled(true); assert(!enabled.ok);
  assert.match(enabled.message, /不会把当前进程密钥复制/);
});
