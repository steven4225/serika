import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setup } from '/Users/a1-6/Code/agents/serika-chat-run-target/apps/desktop/scripts/chat-run-target-live-herdr.mjs';
const root = await mkdtemp('/private/tmp/serika-chat-run-target-telegram-repro-');
const report = { id: randomUUID(), startedAt: new Date().toISOString(), root, verification: 'real-herdr-long-path-reproduction', realModelCalls: 0, telegramCalls: 0, status: 'failed' };
try { await setup(root, 'http://127.0.0.1:1/pi/v1', 'deepseek/deepseek-v4.1-flash-fast'); report.unexpectedSuccess = true; }
catch (error) { report.error = error.message; const state = JSON.parse(await readFile(join(root, 'herdr-fixture/herdr-state.json'), 'utf8')); report.state = state; report.serverLog = await readFile(join(root, 'herdr-fixture/server.log'), 'utf8'); try { process.kill(state.serverPid, 0); report.serverAlive = true; } catch(e) { if(e.code !== 'ESRCH') throw e; report.serverAlive = false; } report.reproduced = report.serverLog.includes('sun_path') && !report.serverAlive && state.operations.length === 0; }
report.finishedAt = new Date().toISOString();
await writeFile('/private/tmp/s197-socket-work/before.json', JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({reproduced: report.reproduced, error: report.error, serverLog: report.serverLog, root}));
process.exitCode = report.reproduced ? 0 : 1;
