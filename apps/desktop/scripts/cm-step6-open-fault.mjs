export function installOpenFault(_electron, target) {
  const fs = process.getBuiltinModule('fs/promises');
  const original = fs.open;
  globalThis.__cm6WriteFault = { matched: 0, delegatedTargetOpens: 0, released: 0 };
  fs.open = async function(path, ...args) {
    if (path !== target) return original.call(this, path, ...args);
    globalThis.__cm6WriteFault.matched++;
    await new Promise(resolve => setTimeout(resolve, 1800));
    globalThis.__cm6WriteFault.released++;
    throw Object.assign(new Error('Test open stalled before dispatch'), { code: 'ETIMEDOUT' });
  };
  process.getBuiltinModule('module').syncBuiltinESMExports();
  return { type: 'target-open-blocked-before-filesystem', relativePath: target.split('/').slice(-2).join('/'),
    delayMs: 1800, toolDeadlineMs: 1000, fabricatedToolResult: false };
}
