import { access, writeFile } from 'node:fs/promises';

await Promise.all(['./config-upgrade.mjs', '../dist/flock.js', '../dist/tui-module-config.js'].map(path => access(new URL(path, import.meta.url))));
await writeFile(new URL('../dist/node-runtime.json', import.meta.url), JSON.stringify({ nodeExecutable: process.execPath }) + '\n');
