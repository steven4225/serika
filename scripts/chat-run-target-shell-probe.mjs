import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectoryAccess } from '../packages/assistant/dist/directory-access.js';
import { SeatbeltShellRunner } from '../packages/assistant/dist/modules/seatbelt-shell-runner.js';
import { resolveSeatbeltRuntime } from '../packages/assistant/dist/modules/seatbelt-runtime.js';

const file = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--child') {
  const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'serika-197-shell-fixed-'));
  await mkdir(output, { recursive: true });
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: output, TMPDIR: await realpath(tmpdir()), LANG: 'C', LC_ALL: 'C' };
  const { stdout } = await promisify(execFile)(process.execPath, [file, '--child', output], { env, timeout: 60_000 });
  console.log(stdout.trim());
} else {
  const output = process.argv[3], root = await realpath(await mkdtemp(join(tmpdir(), 'serika-197-shell-scope-')));
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const report = { id: randomUUID(), startedAt: new Date().toISOString(), verification: 'isolated-native-resident-equivalent-minimal-environment',
    platform: process.platform, arch: process.arch, runtime: process.execPath, status: 'failed' };
  const runner = new SeatbeltShellRunner({ home, protectedPaths: [home],
    directories: new DirectoryAccess({ load: async () => [{ path: workspace, access: 'readwrite' }], protectedPaths: [home] }) });
  try {
    await assert.rejects(resolveSeatbeltRuntime({ home, protectedPaths: [home], searchPath: process.env.PATH }), /runtime missing/);
    report.expectedPathOnlyFailure = 'Seatbelt runtime missing';
    report.result = await runner.execute({ directory: workspace, input: { command: `node -e 'require("node:fs").writeFileSync("answer.json", JSON.stringify({total:7*8}))'` },
      signal: new AbortController().signal, execution: { timeoutMs: 30_000, maxOutputBytes: 4096, killGraceMs: 250 } });
    await runner.settle();
    assert.ok(report.result.ok); assert.equal(report.result.exitCode, 0);
    const artifact = await readFile(join(workspace, 'answer.json'));
    report.artifact = JSON.parse(artifact); assert.deepEqual(report.artifact, { total: 56 });
    report.artifactSha256 = createHash('sha256').update(artifact).digest('hex');
    report.artifactPath = join(workspace, 'answer.json'); report.status = 'passed';
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ output, status: report.status, artifact: report.artifact }));
}
