import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("personal disclosures share chevrons instead of native triangles and plus/minus markers", async () => {
  const css = await readFile(new URL("./shell.css", import.meta.url), "utf8");
  assert.match(css, /\.personal-layout details > summary::marker\s*\{\s*content:\s*""/);
  assert.match(css, /\.personal-layout details > summary::after\s*\{[^}]*border-right:[^}]*border-bottom:[^}]*rotate\(-45deg\)/);
  assert.match(css, /\.personal-layout details\[open\] > summary::after\s*\{[^}]*rotate\(45deg\)/);
  const base = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(base, /\.trace-node[^\n]*content:\s*"[+−]"/);
});
