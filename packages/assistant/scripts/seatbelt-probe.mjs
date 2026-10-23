import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, symlink } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { createServer, connect, Socket } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--home') && arg('--home'), 'Explicit temporary --home required');
const home = resolve(arg('--home'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const wait = ms => new Promise(done => setTimeout(done, ms));
const isDenied = error => ['EPERM', 'EACCES'].includes(error?.code);
const gitDirectory = '/Library/Developer/CommandLineTools/usr/bin';
const safeEnv = (home, temp, node) => ({ HOME: home, TMPDIR: temp, PATH: dirname(node) + ':' + gitDirectory + ':/usr/bin:/bin',
  LANG: 'C', LC_ALL: 'C', TZ: 'UTC', OPENSSL_CONF: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });

async function child() {
  const plan = JSON.parse(await readFile(arg('--plan'), 'utf8'));
  const mode = arg('--child'), results = {};
  const attempt = async (name, action) => {
    try { await action(); results[name] = { blocked: false }; }
    catch (error) { results[name] = { blocked: isDenied(error), code: error.code ?? 'ERROR' }; }
  };
  if (mode === 'availability') results.entered = true;
  if (mode === 'filesystem') {
    await writeFile(join(plan.authorized, 'allowed.txt'), 'probe'); results.authorizedWrite = true;
    await writeFile(join(plan.temp, 'allowed.txt'), 'probe'); results.privateTempWrite = true;
    await attempt('outsideWrite', () => writeFile(join(plan.outside, 'denied.txt'), 'probe'));
    await attempt('sensitiveRead', () => readFile(join(plan.sensitive, 'credential')));
    await attempt('homeRead', () => readFile(join(home, 'config.json')));
    await attempt('runtimeWrite', () => writeFile(join(plan.runtime, 'denied.txt'), 'probe'));
    await attempt('symlinkWrite', () => writeFile(join(plan.authorized, 'escape/denied.txt'), 'probe'));
    await attempt('projectEnvRead', () => readFile(join(plan.authorized, '.env')));
  }
  if (mode === 'environment') results.variables = plan.envNames.map(name => ({ name, blocked: !(name in process.env) }));
  if (mode === 'network') for (const [family, host] of [['IPv4', '127.0.0.1'], ['IPv6', '::1'], ['Unix', null]]) {
    await attempt(family, () => new Promise((done, fail) => {
      const socket = connect(host ? { host, port: plan.ports[family] } : { path: plan.unixSocket });
      socket.once('connect', () => { socket.destroy(); done(); }); socket.once('error', fail);
      socket.setTimeout(1000, () => { socket.destroy(); fail(Object.assign(new Error(), { code: 'PROBE_TIMEOUT' })); });
    }));
  }
  if (mode === 'descendant' || mode === 'detached') {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', 'filesystem', '--home', home, '--plan', arg('--plan')],
      { env: process.env, detached: mode === 'detached', encoding: 'utf8', timeout: 30_000 });
    results.childExit = run.status; results.childSignal = run.signal;
    if (run.status === 0) results.inherited = JSON.parse(run.stdout);
    else results.spawnError = run.error?.code ?? 'CHILD_FAILED';
  }
  if (mode === 'descriptor') await attempt('inheritedSocketWrite', () => new Promise((done, fail) => {
    const socket = new Socket({ fd: 3, readable: false, writable: true });
    socket.on('error', fail); socket.end('fixture-only', error => error ? fail(error) : done());
  }));
  if (mode === 'descriptor-clean') {
    try { results.extraFdIsSocket = fstatSync(3).isSocket(); }
    catch (error) { results.extraFdIsSocket = false; results.code = error.code; }
  }
  if (mode === 'runtime') {
    const packageCommands = plan.packageManagers.map(({ name, entry }) => [name, `node ${JSON.stringify(entry)} --version`]);
    for (const [name, command] of [['shell', 'printf shell-ready'], ['git', 'git --version'], ['node', 'node --version'], ...packageCommands]) {
      const run = spawnSync('/bin/sh', ['-c', command, '--home', home], { env: process.env, encoding: 'utf8', timeout: 30_000 });
      results[name] = { exitCode: run.status, signal: run.signal, started: !run.error, nonemptyOutput: !!run.stdout?.trim() };
    }
  }
  if (mode === 'linger') {
    process.on('SIGTERM', () => {});
    await writeFile(join(plan.temp, 'child-ready.json'), json({ pid: process.pid }));
    let tick = 0;
    setInterval(() => { writeFile(join(plan.temp, 'heartbeat'), String(++tick)).catch(() => {}); }, 50); return;
  }
  if (mode === 'group-parent') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', 'linger', '--home', home, '--plan', arg('--plan')],
      { env: process.env, detached: args.includes('--detach-descendant'), stdio: 'ignore' });
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return;
  }
  console.log(JSON.stringify(results));
}

if (args.includes('--child')) {
  await child();
} else {
  assert.ok(args.includes('--output'), 'Explicit --output outside source required');
  assert.equal(process.platform, 'darwin', 'This probe requires real macOS');
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const output = resolve(arg('--output'));
  assert.ok(home.startsWith('/private/tmp/') && home !== homedir(), 'Probe home must be a fresh private temporary directory');
  assert.equal(await realpath(dirname(home)), dirname(home), 'Temporary parent must be canonical and already exist');
  assert.ok(!output.startsWith(repo + sep), 'Evidence output must be outside checkout');
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), platform: process.platform, release: release(), arch: process.arch,
    node: process.version, sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    sourceWorktreeDirty: spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim() !== '',
    scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), realModelCalls: 0, productAutonomyEnabled: false,
    scope: 'S0 observations only; not S1 acceptance', s1Accepted: false, commands: [], checks: {}, status: 'failed' };
  const frozen = 'packages/assistant/src/permission-boundary.snapshot.json';
  report.b0Sha256 = sha(await readFile(join(repo, frozen)));
  assert.equal(report.b0Sha256, 'b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670');
  await mkdir(home, { mode: 0o700 });
  const root = dirname(home), runtime = join(root, 'runtime'), authorized = join(root, 'authorized'), outside = join(root, 'outside'), sensitive = join(root, 'sensitive'), temp = join(root, 'command-temp');
  const fixture = join(runtime, 'probe.mjs'), planPath = join(runtime, 'plan.json'), profilePath = join(root, 'probe.sb');
  for (const path of [runtime, authorized, outside, sensitive, temp]) await mkdir(path, { mode: 0o700 });
  await writeFile(fixture, await readFile(fileURLToPath(import.meta.url)), { mode: 0o600 });
  await writeFile(join(home, 'config.json'), 'fixture-only', { mode: 0o600 });
  await writeFile(join(sensitive, 'credential'), 'fixture-only', { mode: 0o600 });
  await writeFile(join(authorized, '.env'), 'fixture-only', { mode: 0o600 });
  await symlink(outside, join(authorized, 'escape'));
  const node = await realpath(process.execPath);
  const loaded = process.report.getReport().sharedObjects.filter(path => path.startsWith('/opt/homebrew/Cellar/'));
  const dependencyDirs = [...new Set(loaded.flatMap(path => [dirname(path), dirname(path).replace(/\/Cellar\/([^/]+)\/[^/]+\//, '/opt/$1/')]))];
  const packageManagers = [];
  for (const name of ['npm', 'pnpm']) {
    const entry = await realpath('/opt/homebrew/bin/' + name);
    packageManagers.push({ name, entry, readOnlyRoot: dirname(dirname(entry)) });
  }
  const systemReadRoots = ['/System/Library', '/usr/lib', '/Library/Developer/CommandLineTools/usr/lib'];
  const readRoots = [...systemReadRoots, ...dependencyDirs, ...packageManagers.map(item => item.readOnlyRoot), runtime, authorized, temp];
  const literals = ['/', '/bin/sh', join(gitDirectory, 'git'), '/dev/null', '/dev/urandom', node];
  const ancestors = new Set(['/']);
  for (const path of [...readRoots, ...literals]) for (let p = dirname(path); p !== '/'; p = dirname(p)) ancestors.add(p);
  const filters = (kind, paths) => paths.map(path => `(${kind} ${JSON.stringify(path)})`).join(' ');
  const profile = `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow sysctl-read)\n(allow signal (target self))\n` +
    `(allow file-read-metadata ${filters('literal', [...ancestors])})\n` +
    `(allow file-read* ${filters('subpath', readRoots)} ${filters('literal', literals)})\n` +
    `(allow file-write* ${filters('subpath', [authorized, temp])} (literal "/dev/null"))\n` +
    `(deny file-read* file-write* ${filters('subpath', [home, sensitive])} (regex #"(^|/)\\.env($|\\.)"))\n`;
  await writeFile(profilePath, profile, { mode: 0o600 });
  const parentCredentialNames = Object.keys(process.env).filter(name => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE|DYLD|NODE_OPTIONS|NODE_PATH|BASH_ENV|^ENV$|ZDOTDIR|PYTHONPATH|PROXY)/i.test(name)).sort();
  const syntheticInputNames = ['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'CANARY_UNCLASSIFIED'];
  const envNames = [...new Set([...parentCredentialNames, ...syntheticInputNames])].sort();
  const plan = { authorized, outside, sensitive, runtime, temp, envNames, packageManagers, ports: {}, unixSocket: join(temp, 'fixture.sock') };
  const servers = [];
  const listen = async host => {
    const server = createServer(socket => socket.on('data', () => {}));
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, host, done); });
    servers.push(server); return server.address().port;
  };
  const env = safeEnv(home, temp, node);
  report.environment = { parentCredentialNames, additionalProbeNames: syntheticInputNames,
    credentialValuesCopiedToChild: false, construction: 'fresh fixed environment, no source environment spread' };
  const invoke = async (mode, { executable = '/usr/bin/sandbox-exec', selectedProfile = profilePath, stdio = ['ignore', 'pipe', 'pipe'] } = {}) => {
    const command = ['-f', selectedProfile, node, fixture, '--child', mode, '--home', home, '--plan', planPath];
    const run = spawnSync(executable, command, { cwd: authorized, env, stdio, encoding: 'utf8', timeout: 30_000 });
    report.commands.push({ mode, exitCode: run.status, signal: run.signal, error: run.error?.code ?? null, stdoutBytes: Buffer.byteLength(run.stdout ?? ''), stderrBytes: Buffer.byteLength(run.stderr ?? '') });
    return { run, value: run.status === 0 ? JSON.parse(run.stdout) : null };
  };
  try {
    plan.ports.IPv4 = await listen('127.0.0.1'); plan.ports.IPv6 = await listen('::1');
    const unixServer = createServer(socket => socket.destroy()); servers.push(unixServer);
    await new Promise((done, fail) => { unixServer.once('error', fail); unixServer.listen(plan.unixSocket, done); });
    await writeFile(planPath, json(plan), { mode: 0o600 });
    const entry = await invoke('availability');
    report.checks.availability = { executablePresent: !entry.run.error, entered: entry.value?.entered === true };
    assert.ok(entry.value?.entered, 'Default-deny sandbox did not enter the probe');
    for (const mode of ['filesystem', 'environment', 'network', 'descendant', 'detached', 'runtime', 'descriptor-clean']) {
      const result = await invoke(mode); report.checks[mode] = result.value; assert.equal(result.run.status, 0, `${mode} probe failed`);
    }
    const server = createServer();
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); }); servers.push(server);
    const accepted = new Promise(done => server.once('connection', done));
    const socket = connect(server.address().port, '127.0.0.1'); await new Promise(done => socket.once('connect', done));
    const peer = await accepted; let receivedBytes = 0; peer.on('data', bytes => { receivedBytes += bytes.length; });
    try {
      report.checks.cleanSocketLaunch = (await invoke('descriptor-clean')).value;
      await wait(100); report.checks.cleanSocketLaunch.peerReceivedBytes = receivedBytes;
      assert.equal(report.checks.cleanSocketLaunch.extraFdIsSocket, false); assert.equal(receivedBytes, 0);
      report.checks.deliberatelyInheritedSocket = (await invoke('descriptor', { stdio: ['ignore', 'pipe', 'pipe', socket._handle.fd] })).value;
      await wait(100);
      report.checks.deliberatelyInheritedSocket.peerReceivedBytes = receivedBytes;
      assert.ok(receivedBytes > 0, 'Inherited socket control must demonstrate the bypass');
    }
    finally { socket.destroy(); peer.destroy(); }
    assert.equal(report.checks['descriptor-clean'].extraFdIsSocket, false);
    const cancellation = async detached => {
      const readHeartbeat = () => readFile(join(temp, 'heartbeat'), 'utf8').catch(() => null);
      const beforeReady = await readFile(join(temp, 'child-ready.json'), 'utf8').catch(() => null);
      const command = ['-f', profilePath, node, fixture, '--child', 'group-parent', '--home', home, '--plan', planPath, ...(detached ? ['--detach-descendant'] : [])];
      const leader = spawn('/usr/bin/sandbox-exec', command, { env, cwd: authorized, detached: true, stdio: 'ignore' });
      const settled = new Promise(done => { leader.once('exit', (code, signal) => done({ exitCode: code, signal })); leader.once('error', error => done({ error: error.code })); });
      let pid;
      const kill = (target, signal) => { try { process.kill(target, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      try {
        for (let i = 0; i < 100; i++) {
          const ready = await readFile(join(temp, 'child-ready.json'), 'utf8').catch(() => null);
          if (ready && ready !== beforeReady) { pid = JSON.parse(ready).pid; break; }
          await wait(50);
        }
        assert.ok(pid, 'Cancellation descendant did not start');
        kill(-leader.pid, 'SIGTERM'); await wait(250); kill(-leader.pid, 'SIGKILL');
        const result = await settled;
        await wait(200); const afterKill = await readHeartbeat(); await wait(300);
        result.detachedDescendant = detached; result.continuesAfterGroupKill = await readHeartbeat() !== afterKill;
        kill(pid, 'SIGKILL'); await wait(200); const afterCleanup = await readHeartbeat(); await wait(200);
        result.continuesAfterExplicitCleanup = await readHeartbeat() !== afterCleanup;
        assert.equal(result.continuesAfterExplicitCleanup, false);
        report.commands.push({ mode: detached ? 'cancel-detached' : 'cancel-ordinary', ...result });
        return result;
      } finally { if (leader.pid) kill(-leader.pid, 'SIGKILL'); if (pid) kill(pid, 'SIGKILL'); }
    };
    report.checks.cancelOrdinary = await cancellation(false);
    report.checks.cancelDetached = await cancellation(true);
    assert.equal(report.checks.cancelOrdinary.continuesAfterGroupKill, false);
    const missing = await invoke('availability', { executable: join(root, 'absent-sandbox-exec') });
    report.checks.unavailable = { refused: missing.run.error?.code === 'ENOENT', entered: missing.value?.entered === true, hostFallback: false };
    assert.ok(report.checks.unavailable.refused && !report.checks.unavailable.entered);
    const rejected = await invoke('availability', { selectedProfile: join(root, 'absent-profile.sb') });
    report.checks.rejectedProfile = { refused: rejected.run.status !== 0, entered: rejected.value?.entered === true, hostFallback: false };
    assert.ok(report.checks.rejectedProfile.refused && !report.checks.rejectedProfile.entered);
    for (const name of ['outsideWrite', 'sensitiveRead', 'homeRead', 'runtimeWrite', 'symlinkWrite', 'projectEnvRead']) assert.ok(report.checks.filesystem[name].blocked, name);
    assert.ok(report.checks.environment.variables.every(item => item.blocked));
    for (const result of Object.values(report.checks.runtime)) assert.equal(result.exitCode, 0, 'Runtime dependency not usable');
    assert.ok(Object.values(report.checks.network).every(result => result.blocked));
    for (const mode of ['descendant', 'detached']) {
      const inherited = report.checks[mode].inherited;
      assert.ok(inherited.authorizedWrite && inherited.privateTempWrite);
      for (const name of ['outsideWrite', 'sensitiveRead', 'homeRead', 'runtimeWrite', 'symlinkWrite', 'projectEnvRead']) assert.ok(inherited[name].blocked, `${mode}/${name}`);
    }
    report.status = 'passed';
  } catch (error) { report.failure = { code: error.code ?? error.name, check: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'PROBE_FAILED' }; process.exitCode = 1; }
  finally {
    for (const server of servers) await new Promise(done => server.close(done));
    report.runtime = { executable: node, gitExecutable: join(gitDirectory, 'git'), packageManagers, dependencyDirectories: dependencyDirs, systemReadRoots,
      environmentNamesPassed: Object.keys(env).sort(), metadataAncestorsOnly: true, globalOpenSSLConfigurationDisabled: true };
    report.executedProfileSha256 = sha(profile); report.profile = profile.replaceAll(root, '<temporary>');
    report.portableProfileSha256 = sha(report.profile);
    report.finishedAt = new Date().toISOString();
    assert.equal(sha(await readFile(join(repo, frozen))), report.b0Sha256);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, json(report), { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, b0Sha256: report.b0Sha256, outputSha256: sha(json(report)), realModelCalls: 0, productAutonomyEnabled: false }));
  }
}
