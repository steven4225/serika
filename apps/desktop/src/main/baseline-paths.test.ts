import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveApplicationHome } from "@serika/assistant";
import { resolveDesktopConfig } from "./desktop-config.js";
import { resolveDesktopIdentity } from "./desktop-identity.js";
import { resolveResidentPaths } from "./resident-service.js";
import { userDataPathFromEnv } from "./user-data-path.js";

/**
 * v2 pilot step 1 baseline (docs/v2-pilot/paths.md): desktop data locations.
 * H owns config, identity, transcripts and resident state under approved a2.
 * Regenerate only for an explicitly confirmed path change:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 pnpm --filter @serika/desktop test
 */

const snapshotFile = fileURLToPath(new URL("./__baseline__/desktop-paths.txt", import.meta.url));

describe("v2 pilot baseline: desktop data paths", () => {
  it("matches __baseline__/desktop-paths.txt", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-desktop-")));
    try {
      const applicationHome = join(root, "applicationHome");
      const lines = [
        `default application home = ${resolveApplicationHome({ env: {}, cwd: root, userHome: root }).replace(root, "root")}`,
        `userDataPathFromEnv({}) = ${String(userDataPathFromEnv({}))}`,
        `userDataPathFromEnv(RUNLOOM_USER_DATA=/abs) = ${userDataPathFromEnv({ RUNLOOM_USER_DATA: "/abs" })}`,
      ];
      const config = await resolveDesktopConfig({ env: {}, applicationHome, cwd: root });
      lines.push(`resolveDesktopConfig(no env) = ${relative(root, config.configPath)} generated=${config.generated}`);
      const explicit = await resolveDesktopConfig({ env: { RUNLOOM_CONFIG: "/elsewhere/runloom.json" }, applicationHome, cwd: root });
      lines.push(`resolveDesktopConfig(RUNLOOM_CONFIG) = ${explicit.configPath} generated=${explicit.generated}`);
      const generated = JSON.parse(await readFile(config.configPath, "utf8")) as { authorizedDirectory?: string };
      lines.push(`generated config workspace = ${String(generated.authorizedDirectory)}`);
      // Fixed absolute inputs: the explicit-launch key hashes these exact strings.
      const workspaceRoot = "/fixed/work", configPath = "/fixed/runloom.json";
      const explicitIdentity = await resolveDesktopIdentity({ applicationHome, configPath, workspaceRoot,
        env: { RUNLOOM_TRANSCRIPTS: "/fixed/transcripts" }, cwd: root });
      lines.push(`explicit identity (RUNLOOM_TRANSCRIPTS) thread = ${explicitIdentity.threadId}`);
      lines.push(`explicit identity (RUNLOOM_TRANSCRIPTS) transcripts = ${explicitIdentity.transcriptDirectory}`);
      const explicitThread = await resolveDesktopIdentity({ applicationHome, configPath, workspaceRoot,
        env: { RUNLOOM_THREAD: "my-thread" }, cwd: root });
      lines.push(`explicit identity (RUNLOOM_THREAD) thread = ${explicitThread.threadId}`);
      lines.push(`explicit identity (RUNLOOM_THREAD) transcripts = ${relative(root, explicitThread.transcriptDirectory)}`);
      const resident = resolveResidentPaths("/Users/me/work", 501);
      // The socket root is /private/tmp on macOS and /tmp elsewhere; both are locked here.
      const socketRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
      for (const [key, value] of Object.entries(resident)) {
        lines.push(`resident(/Users/me/work, 501).${key} = ${value.startsWith(`${socketRoot}/`) ? value.replace(socketRoot, "<socket tmp>") : value}`);
      }
      assert.equal(resident.socketRoot, `${socketRoot}/serika-host-501`);
      const files = (await readdir(applicationHome, { recursive: true, withFileTypes: true }))
        .map(entry => `${relative(root, join(entry.parentPath, entry.name))}${entry.isDirectory() ? "/" : ""}`).sort();
      lines.push("", "# applicationHome after config resolution", ...files);
      const actual = lines.join("\n") + "\n";
      if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(snapshotFile, actual);
      assert.equal(actual, await readFile(snapshotFile, "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
