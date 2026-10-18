import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatHome, type HomeSnapshot } from "@serika/assistant";
import { parseHome } from "./home.js";

/**
 * v2 pilot step 3 golden: what the Home panel shows today for every Home
 * branch, produced by the text parser from the CLI text of the shared
 * structured fixtures. The structured path must reproduce this exactly.
 * Regenerate only for a confirmed change: SERIKA_UPDATE_BASELINE_SNAPSHOT=1.
 */
const fixtures = fileURLToPath(new URL("../../../../../packages/assistant/src/__baseline__/home-snapshots.json", import.meta.url));
const golden = fileURLToPath(new URL("./__baseline__/home-view.json", import.meta.url));

it("v2 pilot baseline: Home panel view for every Home branch", async () => {
  const snapshots = JSON.parse(await readFile(fixtures, "utf8")) as Record<string, HomeSnapshot>;
  const views: Record<string, unknown> = {};
  for (const [name, snapshot] of Object.entries(snapshots)) views[name] = parseHome(formatHome(snapshot));
  const actual = JSON.stringify(views, null, 2) + "\n";
  if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(golden, actual);
  assert.equal(actual, await readFile(golden, "utf8"));
});
