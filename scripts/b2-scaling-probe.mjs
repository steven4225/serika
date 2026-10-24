import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [distArgument, outputArgument, mode = 'current'] = process.argv.slice(2);
assert.ok(distArgument && outputArgument, 'Usage: node b2-scaling-probe.mjs ABS_ASSISTANT_DIST ABS_OUTPUT [baseline|current]');
assert.ok(process.env.SERIKA_TEST_HOME?.startsWith('/'), 'Use scripts/test-home.mjs with an explicit temporary home');
const dist = resolve(distArgument), output = resolve(outputArgument);
const sourceRoot = resolve(dist, '../../..');
const sourceCommit = execFileSync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('/usr/bin/git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const scriptSHA = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const load = name => import(pathToFileURL(join(dist, name)).href);
const [{ DirectoryAccess }, { createReadFileTool }, { SeatbeltShellRunner }, { resolveSeatbeltRuntime }, { seatbeltPolicy }, protection] = await Promise.all([
  load('directory-access.js'), load('read-file.js'), load('modules/seatbelt-shell-runner.js'), load('modules/seatbelt-runtime.js'), load('modules/seatbelt-policy.js'), load('protected-paths.js'),
]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'serika-b2-scaling-')));
const workspace = join(root, 'workspace'), home = join(root, 'H'), config = join(home, 'config.json'), env = join(home, 'env');
await mkdir(workspace); await mkdir(home); await writeFile(config, 'control-before'); await writeFile(env, 'credential-before'); await writeFile(join(workspace, 'target'), 'ordinary');
const directories = [{ path: workspace, access: 'readwrite' }];
const access = new DirectoryAccess({ load: async () => directories, protectedPaths: [config], credentialPaths: [env] });
const tool = createReadFileTool(access, workspace);
const runner = new SeatbeltShellRunner({ home, directories: access, protectedPaths: [config] });
const runtime = await resolveSeatbeltRuntime({ home, protectedPaths: [config, protection.serikaCodeRoot] });
const executeRead = () => tool.execute({ path: 'target' }, { toolCallId: 'b2-scaling', messages: [], context: {} });
const executeShell = command => runner.execute({ directory: workspace, input: { command }, signal: new AbortController().signal, execution: { timeoutMs: 30000, maxOutputBytes: 65536, killGraceMs: 250 } });
const reduced = result => result.ok ? { ok: true, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode, output: result.output }) } : { ok: false, error: result.error };
const timed = async (call, repeats) => {
  const measurementsMs = []; let result;
  for (let i = 0; i < repeats; i++) { const start = performance.now(); result = await call(); measurementsMs.push(performance.now() - start); }
  const sorted = [...measurementsMs].sort((a,b) => a-b);
  return { measurementsMs, medianMs: sorted[Math.floor(sorted.length / 2)], result: reduced(result) };
};
const profile = async () => {
  const scanned = typeof protection.scanProtectedPaths === 'function' ? await protection.scanProtectedPaths([workspace]) : { controlPaths: [], credentialPaths: [] };
  const text = seatbeltPolicy({ directories, temp: join(root, 'fixed-policy-temp'), userHome: userInfo().homedir, runtime, protectedPaths: [config, ...scanned.controlPaths, protection.serikaCodeRoot], credentialPaths: [env, ...scanned.credentialPaths] });
  return { bytes: Buffer.byteLength(text), scannedControls: scanned.controlPaths.length, scannedCredentials: scanned.credentialPaths.length };
};
const repeats = mode === 'baseline' ? 3 : 7;
const stat = async path => { try { const value = await lstat(path); return { inode: value.ino, links: value.nlink }; } catch (error) { return { code: error.code }; } };
const report = { runId: randomUUID(), sourceCommit, dirty, scriptSHA, dist, status: 'observed', interpretation: 'Performance and filesystem effects observed on synthetic data; residual risks are not approved by this probe.', mode, platform: process.platform, release: release(), testData: true, root, startedAt: new Date().toISOString(), method: 'Same authorized directory before/after 100000 empty ordinary files; runtime and tool paths warmed; median of measured invocations per size. Extra time = large median minus small median.', repeats, sizes: {} };
try {
  assert.equal((await executeRead()).ok, true); const warm = await executeShell('printf warm'); assert.equal(warm.ok && warm.exitCode === 0, true, JSON.stringify(warm));
  report.sizes.one = { files: 1, readFile: await timed(executeRead, repeats), shellExec: await timed(() => executeShell('printf ordinary'), repeats), profile: await profile() };
  const creating = performance.now();
  for (let directory = 0; directory < 100; directory++) {
    const path = join(workspace, `batch-${directory}`); await mkdir(path);
    for (let start = 0; start < 1000; start += 32) await Promise.all(Array.from({ length: Math.min(32, 1000-start) }, (_, offset) => writeFile(join(path, `f-${start+offset}`), '')));
  }
  report.creationMs = performance.now() - creating;
  report.sizes.large = { files: 100001, readFile: await timed(executeRead, repeats), shellExec: await timed(() => executeShell('printf ordinary'), repeats), profile: await profile() };
  report.extraMs = { readFile: report.sizes.large.readFile.medianMs - report.sizes.one.readFile.medianMs, shellExec: report.sizes.large.shellExec.medianMs - report.sizes.one.shellExec.medianMs };
  const inaccessible = join(workspace, 'unreadable'); await mkdir(inaccessible); await writeFile(join(inaccessible, 'sentinel'), 'test only'); await chmod(inaccessible, 0);
  try { await readdir(inaccessible); report.unreadableProof = 'readable'; } catch(error) { report.unreadableProof = error.code; }
  try { report.withUnreadableRead = reduced(await executeRead()); } catch(error) { report.withUnreadableRead = { thrownCode: error.code, thrownName: error.name }; }
  try { report.withUnreadableShell = reduced(await executeShell('printf ordinary')); } catch(error) { report.withUnreadableShell = { thrownCode: error.code, thrownName: error.name }; }
  await chmod(inaccessible, 0o700);
  // These links exist before the sandbox starts. All contents are synthetic test data.
  await link(config, join(workspace, 'control-alias')); await link(env, join(workspace, 'credential-alias'));
  report.existingHardlinks = {
    fileControl: reduced(await tool.execute({ path: 'control-alias' }, { toolCallId: 'hardlink-control', messages: [], context: {} })),
    fileCredential: reduced(await tool.execute({ path: 'credential-alias' }, { toolCallId: 'hardlink-credential', messages: [], context: {} })),
    shellReadControl: reduced(await executeShell('cat control-alias')),
    shellWriteControl: reduced(await executeShell('printf control-after > control-alias')),
    shellReadCredential: reduced(await executeShell('cat credential-alias')),
    shellWriteCredential: reduced(await executeShell('printf credential-after > credential-alias')),
    shellCreateHardlink: reduced(await executeShell('ln target new-hardlink')),
    createdHardlink: await stat(join(workspace, 'new-hardlink')), sourceAfterCreate: await stat(join(workspace, 'target')),
    controlAlias: await stat(join(workspace, 'control-alias')), controlSource: await stat(config), credentialAlias: await stat(join(workspace, 'credential-alias')), credentialSource: await stat(env),
    controlAfter: await readFile(config, 'utf8'), credentialAfter: await readFile(env, 'utf8'),
    profileAfterLinks: await profile(),
  };
  if (mode !== 'baseline') {
    assert.equal(report.unreadableProof, 'EACCES');
    assert.equal(report.withUnreadableRead.ok, true);
    assert.equal(report.withUnreadableShell.ok && report.withUnreadableShell.exitCode === 0, true);
    assert.equal(report.sizes.one.profile.bytes, report.sizes.large.profile.bytes);
    assert.equal(report.existingHardlinks.shellCreateHardlink.exitCode === 0, false);
    assert.equal(report.existingHardlinks.createdHardlink.code, 'ENOENT');
    assert.equal(report.existingHardlinks.sourceAfterCreate.links, 1);
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'scaling.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await chmod(join(workspace,'unreadable'), 0o700).catch(()=>{}); await runner.settle(); await rm(root, { recursive: true, force: true }); }
