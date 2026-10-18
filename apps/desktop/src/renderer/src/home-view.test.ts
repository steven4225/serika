import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { HomeSnapshot } from "@serika/assistant";
import { EMPTY_HOME_VIEW, homeView } from "./home-view.js";

/**
 * v2 pilot step 3: the Home panel is built from the structured snapshot. The
 * golden `__baseline__/home-view.json` was recorded with the removed text
 * parser (commit "build Home as a structured snapshot…"); the structured path
 * must show exactly the same time, sections and items for every Home branch.
 */
const fixtures = fileURLToPath(new URL("../../../../../packages/assistant/src/__baseline__/home-snapshots.json", import.meta.url));
const golden = fileURLToPath(new URL("./__baseline__/home-view.json", import.meta.url));

it("v2 pilot baseline: Home panel view for every Home branch matches the parser-era golden", async () => {
  const snapshots = JSON.parse(await readFile(fixtures, "utf8")) as Record<string, HomeSnapshot>;
  const expected = JSON.parse(await readFile(golden, "utf8")) as Record<string, { time: string | null; sections: unknown[]; unparsed: string[] }>;
  assert.deepEqual(Object.keys(snapshots), Object.keys(expected));
  for (const [name, snapshot] of Object.entries(snapshots)) {
    const { unparsed, ...view } = expected[name]!;
    assert.deepEqual(unparsed, [], `${name}: the parser left nothing unrecognised, so dropping that branch loses nothing`);
    assert.deepEqual(homeView(snapshot), view, name);
  }
});

it("a cleared Home shows the loading state", () => {
  assert.deepEqual(homeView(null), EMPTY_HOME_VIEW);
});
