import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// The independently reproduced script still reads W/.runloom. Alias only its
// temporary fixture, so its assertions exercise the new physical H/data file.
const mkdtemp = fs.mkdtemp;
const fixture = { runId: randomUUID(), aliases: [] };
fs.mkdtemp = async (...args) => {
  const root = await mkdtemp(...args);
  if (basename(String(args[0])) !== 'serika-electron-smoke-') return root;
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
  syncBuiltinESMExports();
  fixture.scriptSha256 = createHash('sha256').update(await fs.readFile(new URL('./electron-smoke.mjs', import.meta.url))).digest('hex');
  await fs.writeFile(new URL('../../../docs/v2-pilot/evidence/electron-smoke/home-fixture.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
}
