import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLoadedBuildReader, fingerprintBackendDist } from "./build-identity.js";
import { buildStatus, type DesktopBuildManifest } from "../shared/build-identity.js";

const manifest: DesktopBuildManifest = {
  schemaVersion: 1, id: "0123456789abcdef", version: "0.1.0", builtAt: "2026-10-08T00:00:00.000Z",
  frontendSource: { revision: "a".repeat(40), dirty: false }, backendSource: { revision: "b".repeat(40), dirty: true },
  backendDistFingerprint: "c".repeat(64),
};

test("loaded build and startup backend stay frozen when another build replaces disk files", () => {
  const directory = mkdtempSync(join(tmpdir(), "serika-build-identity-"));
  try {
    const path = join(directory, "build-identity.json");
    writeFileSync(path, JSON.stringify(manifest));
    const read = createLoadedBuildReader(manifest, manifest.backendDistFingerprint, path);
    assert.equal(read().diskBuild, "same");
    assert.equal(buildStatus(read()).warning, false);
    writeFileSync(path, JSON.stringify({ ...manifest, id: "fedcba9876543210", backendDistFingerprint: "d".repeat(64) }));
    const changed = read();
    assert.equal(changed.diskBuild, "different");
    assert.equal(changed.loaded!.id, manifest.id);
    assert.equal(changed.backendDistAtStartup, manifest.backendDistFingerprint);
    assert.equal(changed.backendMatchesBuild, true);
    assert.match(buildStatus(changed).text, /仍在使用.*版本/);
    assert.match(buildStatus(changed, { ...manifest, id: "fedcba9876543210" }).text, /页面与主进程/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing or corrupt disk metadata is unavailable, never reported as latest", () => {
  const directory = mkdtempSync(join(tmpdir(), "serika-build-identity-"));
  try {
    const path = join(directory, "build-identity.json");
    const read = createLoadedBuildReader(manifest, manifest.backendDistFingerprint, path);
    assert.equal(read().diskBuild, "unavailable");
    writeFileSync(path, "not json");
    assert.equal(read().diskBuild, "unavailable");
    writeFileSync(path, JSON.stringify({ id: manifest.id }));
    assert.equal(read().diskBuild, "unavailable");
    assert.equal(read().loaded!.id, manifest.id);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mixed backend artifacts warn instead of substituting source revision for loaded dist", () => {
  const read = createLoadedBuildReader(manifest, "d".repeat(64), "/nonexistent/serika-build.json");
  assert.equal(read().backendMatchesBuild, false);
  assert.match(buildStatus(read()).text, /混合版本/);
  const unknown = createLoadedBuildReader(null, null, "/nonexistent/serika-build.json");
  assert.equal(unknown().backendMatchesBuild, null);
  assert.match(buildStatus(unknown()).text, /无法确认/);
});

test("backend fingerprint uses actual project JS contents, not git HEAD or file timestamps", () => {
  const directory = mkdtempSync(join(tmpdir(), "serika-build-dist-"));
  try {
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "app.js"), "export const version = 1;");
    writeFileSync(join(directory, "nested", "runtime.js"), "export const run = true;");
    const first = fingerprintBackendDist([directory]);
    assert.match(first!, /^[a-f0-9]{64}$/);
    writeFileSync(join(directory, "app.test.js"), "test fixture");
    writeFileSync(join(directory, "app.js.map"), "source map");
    writeFileSync(join(directory, "app.d.ts"), "declaration");
    assert.equal(fingerprintBackendDist([directory]), first);
    writeFileSync(join(directory, "nested", "runtime.js"), "export const run = false;");
    assert.notEqual(fingerprintBackendDist([directory]), first);
    assert.equal(fingerprintBackendDist([join(directory, "missing")]), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
