import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonical } from './test-home-guard.mjs';
import { guardedRun, metadata } from './test-home.mjs';

for (const mode of ['node', 'shell']) test(`fails the whole command on a ${mode} write, using a temporary protected fixture`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-home-guard-test-'));
  const protectedRoot = join(root, 'protected'), home = join(root, 'home');
  await mkdir(protectedRoot);
  const alias = join(root, 'alias'); await symlink(protectedRoot, alias, 'dir');
  const destination = join(alias, 'unexpected');
  try {
    const before = await metadata(protectedRoot);
    const command = mode === 'node' ? [process.execPath, '-e', `
      const fs=require('node:fs');
      try {fs.writeFileSync(${JSON.stringify(destination)}, 'fixture')} catch {}
      process.exit(0);
    `] : ['/bin/sh', '-c', 'printf fixture > "$1"', '--home', home, destination];
    if (mode === 'shell') command[2] = 'printf fixture > "$2"';
    assert.notEqual(await guardedRun({ home, command, protectedRoot }), 0);
    if (mode === 'node') {
      assert.deepEqual(await metadata(protectedRoot), before);
      const reports = (await readdir(home)).filter(name => name.startsWith('write-guard-'));
      const result = JSON.parse(await readFile(join(home, reports[0], 'result.json'), 'utf8'));
      assert.equal(result.violations.length, 1);
    }
    else assert.equal(await readFile(join(protectedRoot, 'unexpected'), 'utf8'), 'fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires an explicit temporary home and preserves successful isolated commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serika-home-guard-pass-'));
  try {
    const home = join(root, 'home'), protectedRoot = join(root, 'protected'); await mkdir(protectedRoot);
    assert.equal(spawnSync(process.execPath, [new URL('./test-home.mjs', import.meta.url).pathname], { encoding: 'utf8' }).status, 1);
    assert.equal(await guardedRun({ home, protectedRoot, command: [process.execPath, '-e',
      `require('node:assert/strict').equal(process.env.SERIKA_HOME, ${JSON.stringify(canonical(home))}); require('node:fs').writeFileSync(${JSON.stringify(join(home, 'fixture'))}, 'isolated')`] }), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
