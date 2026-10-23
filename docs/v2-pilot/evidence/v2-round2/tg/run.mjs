import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [flag, home, ...command] = process.argv.slice(2);
if (flag !== '--home' || !home.startsWith('/private/tmp/serika-v2-round2-tg-H')) throw new Error('isolated --home required');
mkdirSync(home, {recursive:true});
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, HOME: home, SERIKA_HOME: home, RUNLOOM_HOME: home }, cwd: '/private/tmp/serika-v2-round2-tg' });
process.exit(result.status ?? 1);
