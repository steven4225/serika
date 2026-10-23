import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonical(path) {
  const absolute = resolve(path);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(canonical(parent), absolute.slice(parent.length + 1));
  }
}

export function installWriteGuard({ protectedRoot, violationFile }) {
  const root = canonical(protectedRoot);
  const append = fs.appendFileSync;
  const check = (value, operation) => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return;
    const path = canonical(value instanceof URL ? fileURLToPath(value) : String(value));
    if (path !== root && !path.startsWith(root + sep)) return;
    append(violationFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, operation, path }) + '\n');
    process.exitCode = 1;
    throw new Error(`TEST_REAL_HOME_WRITE: ${operation} ${path}`);
  };
  const mutations = {
    appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1], lchmod: [0], lchown: [0],
    link: [0, 1], lutimes: [0], mkdir: [0], mkdtemp: [0], rename: [0, 1], rm: [0], rmdir: [0],
    symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0], createWriteStream: [0],
  };
  for (const [name, indices] of Object.entries(mutations)) {
    for (const [api, key] of [[fs, name], [fs, name + 'Sync'], [fsp, name]]) {
      if (typeof api[key] !== 'function') continue;
      const original = api[key];
      api[key] = function (...args) {
        for (const index of indices) check(args[index], key);
        return Reflect.apply(original, this, args);
      };
    }
  }
  const writable = flags => typeof flags === 'number'
    ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : typeof flags === 'string' && /[wa+]/.test(flags);
  for (const [api, key] of [[fs, 'open'], [fs, 'openSync'], [fsp, 'open']]) {
    const original = api[key];
    api[key] = function (...args) {
      if (writable(args[1])) check(args[0], key);
      return Reflect.apply(original, this, args);
    };
  }
  syncBuiltinESMExports();
}

if (process.env.SERIKA_TEST_PROTECTED_ROOT && process.env.SERIKA_TEST_VIOLATIONS) {
  installWriteGuard({ protectedRoot: process.env.SERIKA_TEST_PROTECTED_ROOT, violationFile: process.env.SERIKA_TEST_VIOLATIONS });
}
