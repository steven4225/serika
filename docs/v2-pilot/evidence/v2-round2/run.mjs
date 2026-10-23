import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const [flag, home, ...command] = process.argv.slice(2);
assert.equal(flag,'--home'); assert.ok(home.startsWith('/private/tmp/serika-v2-round2')); assert.ok(command.length);
mkdirSync(home,{recursive:true});
const r=spawnSync(command[0],command.slice(1),{stdio:'inherit',env:{...process.env,HOME:home,SERIKA_HOME:home,RUNLOOM_HOME:home}});
process.exit(r.status??1);
