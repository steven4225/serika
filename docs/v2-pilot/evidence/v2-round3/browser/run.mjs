import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
const [flag, home, ...command] = process.argv.slice(2);
assert.equal(flag, '--home');
assert.ok(home.startsWith('/private/tmp/serika-v2-round3-browser-evidence/'));
assert.ok(command.length);
mkdirSync(home, { recursive: true });
const result = spawnSync(command[0], command.slice(1), {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, SERIKA_HOME: home, RUNLOOM_HOME: home },
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);
writeFileSync(`/private/tmp/serika-v2-round3-browser-evidence/${basename(home)}.log`, output);
writeFileSync(`/private/tmp/serika-v2-round3-browser-evidence/${basename(home)}.json`, JSON.stringify({
  runId: randomUUID(), command, home, exitCode: result.status, signal: result.signal,
  outputSha256: createHash('sha256').update(output).digest('hex'),
}, null, 2) + '\n');
process.exit(result.status ?? 1);
