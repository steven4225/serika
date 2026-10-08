import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalLauncher } from "./install-local.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "serika-local-install-"));
  const desktop = join(root, "desktop");
  const applicationsDirectory = join(root, "Applications");
  const bundle = async (version, owner = desktop) => {
    const path = join(desktop, "dist", `local-${version}`, "Serika.app");
    await mkdir(join(path, "Contents/Resources"), { recursive: true });
    await writeFile(join(path, "Contents/Resources/serika-local.json"), JSON.stringify({ desktop: owner, version }));
    return path;
  };
  return { root, desktop, applicationsDirectory, bundle };
}

test("local install creates a registered Finder entry without copying app or framework links", async () => {
  const f = await fixture();
  try {
    const bundle = await f.bundle("44.4.5");
    const framework = join(bundle, "Contents/Frameworks");
    await mkdir(framework);
    await symlink("Versions/Current", join(framework, "framework-link"));
    const registered = [];
    const options = { ...f, desktop: `${f.desktop}/`, bundle, register: path => registered.push(path) };
    const result = await installLocalLauncher(options);
    assert.deepEqual(result, { bundle, installedPath: join(f.applicationsDirectory, "Serika.app") });
    assert.equal(await readlink(result.installedPath), bundle);
    assert.equal(await readlink(join(framework, "framework-link")), "Versions/Current");
    await installLocalLauncher(options);
    assert.deepEqual(registered, [result.installedPath, result.installedPath]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("local install updates only links to a launcher managed by the same checkout", async () => {
  const f = await fixture();
  try {
    const oldBundle = await f.bundle("44.4.4");
    const newBundle = await f.bundle("44.4.5");
    await mkdir(f.applicationsDirectory);
    const installed = join(f.applicationsDirectory, "Serika.app");
    await symlink(oldBundle, installed);
    await installLocalLauncher({ ...f, bundle: newBundle, register: () => {} });
    assert.equal(await readlink(installed), newBundle);
    assert.match(await readFile(join(oldBundle, "Contents/Resources/serika-local.json"), "utf8"), /44\.4\.4/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("local install refuses user files, another checkout, and unmanaged symlinks", async () => {
  for (const kind of ["file", "other-checkout", "unmanaged-link"]) {
    const f = await fixture();
    try {
      const bundle = await f.bundle("44.4.5");
      await mkdir(f.applicationsDirectory);
      const installed = join(f.applicationsDirectory, "Serika.app");
      if (kind === "file") await writeFile(installed, "user-owned");
      if (kind === "other-checkout") await symlink(await f.bundle("44.4.4", join(f.root, "other")), installed);
      if (kind === "unmanaged-link") await symlink(join(f.root, "User.app"), installed);
      const before = kind === "file" ? await readFile(installed, "utf8") : await readlink(installed);
      let called = false;
      await assert.rejects(installLocalLauncher({ ...f, bundle, register: () => { called = true; } }));
      assert.equal(called, false);
      assert.equal(kind === "file" ? await readFile(installed, "utf8") : await readlink(installed), before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("registration failure is reported and an explicit retry can register the installed link", async () => {
  const f = await fixture();
  try {
    const bundle = await f.bundle("44.4.5");
    await assert.rejects(installLocalLauncher({ ...f, bundle, register: () => { throw new Error("registration failed"); } }), /registration failed/);
    assert.equal(await readlink(join(f.applicationsDirectory, "Serika.app")), bundle);
    await installLocalLauncher({ ...f, bundle, register: () => {} });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
