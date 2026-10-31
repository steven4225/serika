import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, open, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const herdr = '/opt/homebrew/bin/herdr';
const exec = promisify(execFile);
const { HerdrClient } = await import(pathToFileURL(join(repo, 'packages/assistant/dist/herdr.js')));
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const persist = state => writeFile(join(state.root, 'herdr-state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const environment = state => ({ PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: state.home,
  XDG_CONFIG_HOME: join(state.home, '.config'), XDG_CACHE_HOME: join(state.home, '.cache'), HERDR_CONFIG_PATH: join(state.home, '.config/herdr/config.toml'),
  SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: state.piDirectory,
  PI_CODING_AGENT_SESSION_DIR: join(state.piDirectory, 'sessions'), PI_OFFLINE: '1', PI_TELEMETRY: '0' });
const client = state => new HerdrClient({ env: environment(state), cwd: state.work, authorizedDirectory: state.work });
async function cli(state, args) {
  const { stdout } = await exec(herdr, ['--session', state.session, ...args], { cwd: state.work, env: environment(state), timeout: 35000, maxBuffer: 512 * 1024 });
  return JSON.parse(stdout);
}
async function mutation(state, phase, args) {
  state.phase = phase + '-dispatching'; await persist(state);
  try { const result = await cli(state, args); assert.ok(result && result.error === undefined, 'Herdr rejected operation');
    state.operations.push({ phase, at: new Date().toISOString(), result }); state.phase = phase + '-confirmed'; await persist(state); return result;
  } catch (error) { state.unknown = true; state.phase = phase + '-unknown'; await persist(state); throw new Error(`${phase} outcome not confirmed; stop and reconcile the isolated target before further calls`, { cause: error }); }
}

// Preparation only when imported. setup is the explicit side-effect boundary.
export async function setup(root, proxyURL, model) {
  root = await realpath(resolve(root));
  assert.ok(root.startsWith('/private/tmp/'), 'root must be a pre-created isolated /private/tmp directory');
  const url = new URL(proxyURL);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.match(model, /^[^\x00-\x1f\x7f]+$/);
  const fixture = join(root, 'herdr-fixture'); await mkdir(fixture); // Existing fixtures cannot be resumed or overwritten.
  const state = { id: randomUUID(), root: fixture, parentRoot: root, createdAt: new Date().toISOString(), phase: 'preparing', unknown: false,
    home: join(fixture, 'H'), piDirectory: join(fixture, 'pi'), work: join(fixture, 'workspace'), piSession: join(fixture, 'pi-session.jsonl'),
    model, proxyURL: url.href.replace(/\/$/, ''), operations: [] };
  state.session = 'w-' + state.id.replaceAll('-', '').slice(0, 8);
  await Promise.all(['H/.config/herdr', 'H/.cache', 'pi/sessions', 'workspace'].map(path => mkdir(join(fixture, path), { recursive: true })));
  state.work = await realpath(state.work);
  await writeFile(join(fixture, 'owner.json'), JSON.stringify({ id: state.id, session: state.session, work: state.work }) + '\n', { mode: 0o600 });
  await writeFile(join(state.home, '.config/herdr/config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n', { mode: 0o600 });
  await writeFile(join(state.piDirectory, 'models.json'), JSON.stringify({ providers: { 'serika-isolated-proxy': {
    baseUrl: state.proxyURL, api: 'openai-completions', apiKey: 'isolated-proxy', models: [{ id: model, input: ['text'], reasoning: false,
      contextWindow: 32768, maxTokens: 4096, cost: { input: .32, output: 1.16, cacheRead: .03, cacheWrite: .32 } }] } } }), { mode: 0o600 });
  await writeFile(join(state.piDirectory, 'settings.json'), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false }, cacheWarming: 'off', quietStartup: true, defaultProjectTrust: 'never', defaultTools: ['read', 'write', 'edit'] }), { mode: 0o600 });
  await persist(state);
  const log = await open(join(fixture, 'server.log'), 'a', 0o600);
  state.phase = 'server-dispatching'; await persist(state);
  try {
    const child = spawn(herdr, ['--session', state.session, 'server'], { cwd: state.work, env: environment(state), stdio: ['ignore', log.fd, log.fd], detached: true });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    state.serverPid = child.pid; child.unref(); state.phase = 'server-spawned'; await persist(state);
  } catch (error) { state.unknown = true; state.phase = 'server-unknown'; await persist(state); throw error; }
  finally { await log.close(); }
  // Poll only read-only readiness. workspace create is dispatched once.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await cli(state, ['workspace', 'list']); assert.ok(response && !response.error); ready = true; break; }
    catch { await delay(250); }
  }
  assert.ok(ready, 'new isolated server did not become ready; preserve target for inspection');
  const workspace = await mutation(state, 'workspace-create', ['workspace', 'create', '--cwd', state.work, '--label', 'Serika isolated wiring', '--no-focus']);
  const pane = workspace.result?.root_pane;
  assert.ok(typeof pane?.pane_id === 'string' && typeof pane?.terminal_id === 'string', 'creation response lacks exact pane identity');
  state.target = { authorizedDirectory: state.work, session: state.session, paneId: pane.pane_id, terminalId: pane.terminal_id }; await persist(state);
  await mutation(state, 'pi-start', ['agent', 'start', 'serika-wiring-pi', '--kind', 'pi', '--pane', pane.pane_id, '--',
    '--offline', '--tools', 'read,write,edit', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve',
    '--provider', 'serika-isolated-proxy', '--model', model, '--thinking', 'off', '--session', state.piSession,
    '--system-prompt', `Work only inside ${state.work}. Use only read, write and edit tools. Do the requested small file task, read the result, then report exactly what changed. Never run commands, install software or access unrelated paths.`]);
  const observation = await client(state).execute(state.target, { action: 'get' });
  state.initialObservation = observation; await persist(state);
  assert.ok(observation.ok && ['idle', 'done'].includes(observation.value.status), 'exact Pi target is not idle/done');
  state.targets = [state.target]; state.piSessions = [state.piSession];
  state.phase = 'ready'; await persist(state);
  return { statePath: join(fixture, 'herdr-state.json'), root: fixture, work: state.work, target: state.target, env: environment(state), piSession: state.piSession };
}

export async function addPi(statePath) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(!state.unknown && state.phase === 'ready');
  const split = await mutation(state, 'pane-split', ['pane', 'split', state.target.paneId, '--direction', 'right', '--cwd', state.work, '--no-focus']);
  const pane = split.result.pane;
  const target = { authorizedDirectory: state.work, session: state.session, paneId: pane.pane_id, terminalId: pane.terminal_id };
  const piSession = join(state.root, 'pi-second.jsonl');
  await mutation(state, 'second-pi-start', ['agent', 'start', 'blue-pi', '--kind', 'pi', '--pane', target.paneId, '--',
    '--offline', '--tools', 'read,write,edit', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve',
    '--provider', 'serika-isolated-proxy', '--model', state.model, '--thinking', 'off', '--session', piSession,
    '--system-prompt', `Work only inside ${state.work}. Use only read, write and edit tools. Complete the requested small file task. Never run commands, install software or access unrelated paths.`]);
  const observation = await client(state).execute(target, { action: 'get' });
  assert.ok(observation.ok && ['idle', 'done'].includes(observation.value.status));
  state.targets.push(target); state.piSessions.push(piSession); state.phase = 'ready'; await persist(state);
  return { target, piSession };
}

export async function cleanup(statePath) {
  statePath = await realpath(resolve(statePath));
  assert.ok(statePath.startsWith('/private/tmp/') && statePath.endsWith('/herdr-fixture/herdr-state.json'));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.root, await realpath(join(state.parentRoot, 'herdr-fixture')));
  assert.equal(statePath, join(state.root, 'herdr-state.json'));
  assert.ok(!state.unknown && state.phase === 'ready', 'unknown/non-ready target cannot be cleaned up automatically');
  const owner = JSON.parse(await readFile(join(state.root, 'owner.json'), 'utf8'));
  assert.equal(owner.id, state.id); assert.equal(owner.session, state.session); assert.equal(owner.work, state.work);
  assert.ok(inside(state.root, await realpath(state.home)) && inside(state.root, await realpath(state.work)));
  assert.equal((await lstat(state.root)).isSymbolicLink(), false);
  state.cleanupObservations = [];
  for (const target of state.targets) {
    const observation = await client(state).execute(target, { action: 'get' });
    state.cleanupObservations.push(observation); await persist(state);
    assert.ok(observation.ok && ['idle', 'done'].includes(observation.value.status), 'exact target is not idle/done; no stop/delete');
  }
  await mutation(state, 'session-stop', ['session', 'stop', state.session, '--json']);
  await mutation(state, 'session-delete', ['session', 'delete', state.session, '--json']);
  state.phase = 'cleaned'; await persist(state);
  return { statePath, phase: state.phase, session: state.session, retainedFixture: state.root };
}
