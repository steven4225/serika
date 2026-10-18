import { readdir, readFile } from "node:fs/promises";

/**
 * Source-text checks on the main window read `App.tsx` plus the files split
 * out of it into `src/renderer/src/app/` (architecture-v2 step 3, splitting
 * App.tsx). App.tsx comes first; the parts follow in file-name order.
 */
export async function readAppSource(): Promise<string> {
  const root = new URL("../src/", import.meta.url);
  const parts = (await readdir(new URL("app/", root))).filter(name => /\.tsx?$/.test(name) && !name.endsWith(".test.ts")).sort();
  const files = [new URL("App.tsx", root), ...parts.map(name => new URL(`app/${name}`, root))];
  return (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
}
