import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("..", import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.(ts|tsx)$/.test(entry.name) ? [join(directory, entry.name)] : []));
  return nested.flat();
}

it("desktop uses only the assistant package's public entries, never its internal files", async () => {
  const offenders: string[] = [];
  for (const file of await sources(src)) {
    const text = await readFile(file, "utf8");
    if (/@serika\/assistant\/(dist|internal)\//.test(text)) offenders.push(file.slice(src.length));
    // Renderer code is bundled for the browser: runtime values come only from the browser-safe entry.
    if (/[/\\]renderer[/\\]/.test(file) && !file.includes(".test.") &&
      /^import (?!type )[^;]*from "@serika\/assistant(\/testing)?";/m.test(text)) offenders.push(`${file.slice(src.length)} (runtime import outside /browser)`);
  }
  assert.deepEqual(offenders, []);
});
