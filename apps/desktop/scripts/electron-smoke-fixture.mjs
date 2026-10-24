import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// The independently reproduced script still reads W/.runloom. Alias only its
// temporary fixture, so its assertions exercise the new physical H/data file.
const mkdtemp = fs.mkdtemp, writeFile = fs.writeFile;
const previousConfig = process.env.RUNLOOM_SMOKE_DAILY_CONFIG;
process.env.RUNLOOM_SMOKE_DAILY_CONFIG = new URL('./fixtures/retired-config.json', import.meta.url).pathname;
const fixtureRoots = new Set();
fs.writeFile = async (path, content, ...args) => {
  if (typeof path === 'string' && [...fixtureRoots].some(root => path.startsWith(root + '/')) && path.endsWith('.json') && typeof content === 'string') {
    const config = JSON.parse(content);
    if (config.version === 1 && typeof config.authorizedDirectory === 'string') {
      config.authorizedDirectories = [{ path: config.authorizedDirectory, access: 'readwrite' }];
      delete config.authorizedDirectory;
      content = JSON.stringify(config);
    }
  }
  return writeFile(path, content, ...args);
};
const fixture = { runId: randomUUID(), configSource: { kind: "repository-test-fixture", file: "apps/desktop/scripts/fixtures/retired-config.json" }, aliases: [] };
fs.mkdtemp = async (...args) => {
  const root = await mkdtemp(...args);
  if (basename(String(args[0])) !== 'serika-electron-smoke-') return root;
  fixtureRoots.add(root);
  const target = join(root, 'home', '.serika', 'data');
  const alias = join(root, 'primary', 'workspace', '.runloom');
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(join(root, 'primary', 'workspace'), { recursive: true });
  await fs.symlink(target, alias, 'dir');
  fixture.aliases.push({ alias, target, realpath: await fs.realpath(alias) });
  return root;
};
syncBuiltinESMExports();
try {
  await import('./electron-smoke.mjs');
} finally {
  fs.mkdtemp = mkdtemp;
  fs.writeFile = writeFile;
  if (previousConfig === undefined) delete process.env.RUNLOOM_SMOKE_DAILY_CONFIG;
  else process.env.RUNLOOM_SMOKE_DAILY_CONFIG = previousConfig;
  syncBuiltinESMExports();
  fixture.scriptSha256 = createHash('sha256').update(await fs.readFile(new URL('./electron-smoke.mjs', import.meta.url))).digest('hex');
  await fs.writeFile(new URL('../../../docs/v2-pilot/evidence/electron-smoke/home-fixture.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
}
