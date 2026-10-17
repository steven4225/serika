import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs from dist/, so read the TypeScript sources next to it.
const src = fileURLToPath(new URL("../src/", import.meta.url));

it("the CLI uses only the assistant package's public entries; test fixtures stay in tests", async () => {
  const offenders: string[] = [];
  for (const name of await readdir(src)) {
    if (!name.endsWith(".ts")) continue;
    const text = await readFile(join(src, name), "utf8");
    if (/@serika\/assistant\/(dist|internal)\//.test(text)) offenders.push(name);
    if (!name.includes(".test.") && /from "@serika\/assistant\/testing"/.test(text)) offenders.push(`${name} (testing entry outside tests)`);
  }
  assert.deepEqual(offenders, []);
});
