import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, symlink, copyFile, rename } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--home') && arg('--home'), 'Explicit temporary --home required');
const home = resolve(arg('--home')), root = dirname(home), directory = join(root, 'A');
const sha = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const wait = ms => new Promise(done => setTimeout(done, ms));

if (args.includes('--child')) {
  const plan = JSON.parse(await readFile(arg('--plan'), 'utf8')), checks = {};
  const attempt = async (name, action) => {
    try { await action(); checks[name] = { blocked: false }; }
    catch (error) { checks[name] = { blocked: ['EPERM', 'EACCES'].includes(error.code), code: error.code }; }
  };
  if (arg('--child') === 'dns') {
    console.log('DNS runtime initialization');
    const {Resolver} = await import('node:dns/promises');
    const resolver = new Resolver({ timeout: 200, tries: 1 }); resolver.setServers(['127.0.0.1:' + plan.ports.UDP4]);
    await resolver.resolve4('s1-probe.invalid');
  } else if (arg('--child') === 'spawn') {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)', '--', '--home', home], { detached: true, stdio: 'ignore' });
    checks.detachedSpawn = { blocked: r.error?.code === 'EPERM', code: r.error?.code ?? null, exitCode: r.status };
  } else {
    await writeFile(join(directory, 'allowed.txt'), 'allowed'); checks.authorizedWrite = true;
    await writeFile(join(process.env.TMPDIR, 'private.txt'), 'allowed'); checks.privateTempWrite = true;
    await attempt('outsideWrite', () => writeFile(join(plan.outside, 'denied.txt'), 'denied'));
    await attempt('sensitiveRead', () => readFile(join(plan.sensitive, 'credential')));
    await attempt('homeRead', () => readFile(join(home, 'config.json')));
    await attempt('envRead', () => readFile(join(directory, '.env')));
    await attempt('nestedEnvRead', () => readFile(join(directory, 'nested/.env.local')));
    for (const name of plan.credentialPaths) {
      await attempt('sensitiveRead:' + name, () => readFile(join(directory, name)));
      await attempt('sensitiveWrite:' + name, () => writeFile(join(directory, name), 'denied'));
    }
    for (const path of plan.protectedFiles) {await attempt('protected-read:' + path, () => readFile(path)); await attempt('protected-write:' + path, () => writeFile(path, 'denied'));}
    await attempt('protectedAncestorRename', () => rename(plan.protectedRename,join(directory,'relocated-protected')));
    await attempt('symlinkWrite', () => writeFile(join(directory, 'escape/denied.txt'), 'denied'));
    await attempt('symlinkRead', () => readFile(join(directory, 'secret/credential')));
    await attempt('runtimeWrite', () => writeFile('/opt/homebrew/Cellar/node/26.4.0/bin/s1-denied', 'denied'));
    checks.environment = plan.envNames.map(name => ({ name, blocked: !(name in process.env) }));
    for (const [name, host] of [['IPv4', '127.0.0.1'], ['IPv6', '::1'], ['Unix', null]]) {
      await attempt(name, () => new Promise((done, fail) => {
        const socket = connect(host ? { host, port: plan.ports[name] } : { path: plan.socket });
        socket.once('connect', () => { socket.destroy(); done(); }); socket.once('error', fail);
        socket.setTimeout(1000, () => { socket.destroy(); fail(Object.assign(new Error(), { code: 'PROBE_TIMEOUT' })); });
      }));
    }
    checks.nodeExecuted = true;
  }
  if (args.includes('--result-file')) await writeFile(arg('--result-file'), json(checks));
  console.log(JSON.stringify(checks));
} else {
  assert.equal(process.platform, 'darwin');
  assert.ok(home.startsWith('/private/tmp/serika-s1-'));
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url))), output = resolve(arg('--output'));
  assert.ok(!output.startsWith(repo + '/'), 'Evidence outside checkout');
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    sourceWorktreeDirty: !!spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), realModelCalls: 0, status: 'failed', commands: [], checks: {} };
  for (const path of [home, directory, output, join(root, 'B'), join(root, 'sensitive'), join(directory, 'nested'), join(directory, '.ssh')]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(home, 'config.json'), 'fixture-only');
  await writeFile(join(root, 'sensitive/credential'), 'fixture-only');
  for (const name of ['.env', 'nested/.env.local', '.ssh/credential']) await writeFile(join(directory, name), 'fixture-only');
  await symlink(join(root, 'B'), join(directory, 'escape'));
  await symlink(join(root, 'sensitive'), join(directory, 'secret'));
  const fixture = join(directory, 'checks.mjs'), planPath = join(directory, 'plan.json');
  await copyFile(fileURLToPath(import.meta.url), fixture);
  const envNames = [...new Set(['PROBE_CREDENTIAL_CANARY', 'AWS_ACCESS_KEY_ID', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES',
    ...Object.keys(process.env).filter(name => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE|PROXY)/i.test(name))])].sort();
  const credentialPaths = ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.docker/config.json', '.aws/credentials', '.gnupg/private', '.ssh/credential'];
  for (const path of credentialPaths) { await mkdir(dirname(join(directory, path)), {recursive: true}); await writeFile(join(directory, path), 'fixture-only'); }
  const protectedFiles = [join(directory, 'H/config.json'), join(directory, 'Library/Keychains/canary'), join(directory, 'Library/Application Support/Browser/canary'), join(directory, 'trusted[1].json'), join(directory, 'trusted[1].json.lock'), join(directory, 'trusted[1].json.replace.tmp')];
  for (const path of protectedFiles) { await mkdir(dirname(path), {recursive: true}); await writeFile(path, 'fixture-only'); }
  await mkdir(join(directory,'trusted-parent/nested'),{recursive:true}); await writeFile(join(directory,'trusted-parent/nested/credential'),'fixture-only');
  const plan = { credentialPaths, protectedFiles, protectedRename:join(directory,'trusted-parent'), outside: join(root, 'B'), sensitive: join(root, 'sensitive'), envNames, ports: {}, socket: join(root, 'test.socket') };
  const servers = []; const datagrams = []; let udpPackets = 0;
  for (const [name, host] of [['UDP4', '127.0.0.1'], ['UDP6', '::1']]) {
    const socket = createSocket(name === 'UDP4' ? 'udp4' : 'udp6'); datagrams.push(socket); socket.on('message', () => udpPackets++);
    await new Promise((done, fail) => {socket.once('error', fail); socket.bind(0, host, done);}); plan.ports[name] = socket.address().port;
  }
  for (const [name, host] of [['IPv4', '127.0.0.1'], ['IPv6', '::1'], ['Unix', null]]) {
    const server = createServer(socket => socket.end()); servers.push(server);
    await new Promise((done, fail) => { server.once('error', fail); server.listen(host ? { host, port: 0 } : { path: plan.socket }, done); });
    if (host) plan.ports[name] = server.address().port;
  }
  await writeFile(planPath, json(plan));
  const env = { HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin' };
  for (const name of ['process', 'cancel', 'network']) {
    const source = join(repo, `packages/assistant/scripts/seatbelt-s1-${name}.c`), binary = join(directory, name);
    const r = spawnSync('/bin/sh', ['-c', 'exec /usr/bin/clang "$1" -o "$2"', '--home', source, binary, '--home', home], { env, encoding: 'utf8' });
    report.commands.push({ name: `compile-${name}`, exitCode: r.status, signal: r.signal, sourceSha256: sha(await readFile(source)), stderr: r.stderr });
    assert.equal(r.status, 0, r.stderr);
  }
  const target = spawn(process.execPath, ['-e', 'process.on("SIGUSR2",()=>{});setInterval(()=>{},1000)', '--', '--home', home],
    { env: { ...env, PROBE_CREDENTIAL_CANARY: randomUUID() }, stdio: 'ignore' });
  const targetExit = new Promise(done => target.once('exit', done));
  const scope = { home, configPath: join(directory, 'trusted[1].json'), protectedPaths: [home, plan.sensitive, join(directory, 'H'), join(directory, 'Library'), join(directory,'trusted-parent/nested')] };
  const execution = {timeoutMs: 30_000, maxOutputBytes: 65536, killGraceMs: 250};
  const { SeatbeltShellRunner } = await import('../dist/modules/seatbelt-shell-runner.js');
  const runner = new SeatbeltShellRunner(scope);
  const {seatbeltPolicy} = await import('../dist/modules/seatbelt-policy.js');
  report.expandedSensitiveRoots = [...scope.protectedPaths, ...['.serika','.ssh','.aws','.gnupg','Library'].map(name=>join(userInfo().homedir,name))];
  const referencePolicy = seatbeltPolicy({directory,temp:join(root,'policy-reference-T'),userHome:userInfo().homedir,protectedPaths:scope.protectedPaths,configPath:scope.configPath});
  for(const path of report.expandedSensitiveRoots) assert.ok(referencePolicy.includes('(subpath ' + JSON.stringify(path) + ')'));
  await writeFile(join(output,'policy-reference.sb'),referencePolicy);
  report.policyReference = {file:'policy-reference.sb',sha256:sha(referencePolicy),temporaryDirectoryIsReferenceOnly:true};
  const parse = result => {
    assert.equal(result.ok, true); assert.equal(result.exitCode, 0);
    const lines = result.output.trim().split('\n'); const value = JSON.parse(lines.pop());
    assert.ok(lines.every(line => line === 'Error opening /private/var/select/sh: Operation not permitted'), 'Unexpected stderr');
    return value;
  };
  const run = async (name, command, signal = new AbortController().signal) => {
    const result = await runner.execute({ directory, input: { command }, signal, execution });
    report.commands.push({ name, command, result }); return result;
  };
  try {
    await wait(100);
    const control = spawnSync(join(directory, 'process'), ['--pid', String(target.pid), '--home', home], { env, encoding: 'utf8' });
    report.commands.push({ name: 'cross-process-host-control', exitCode: control.status, result: JSON.parse(control.stdout) });
    assert.equal(control.status, 0); assert.equal(JSON.parse(control.stdout).numericProcargs2.blocked, false); assert.equal(JSON.parse(control.stdout).numericProcargs2.variableNameObserved, true);
    const inherited = connect({ host: '127.0.0.1', port: plan.ports.IPv4 });
    await new Promise((done, fail) => { inherited.once('connect', done); inherited.once('error', fail); });
    const fdControl = spawnSync(join(directory, 'process'), ['--pid', String(target.pid), '--home', home], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', inherited._handle.fd] });
    inherited.destroy();
    const fdResult = JSON.parse(fdControl.stdout); assert.equal(fdControl.status, 0); assert.equal(fdResult.descriptors.sockets, 1);
    report.commands.push({ name: 'S10-inherited-socket-positive-control', exitCode: fdControl.status, result: fdResult });
    const cross = parse(await run('S15', `${directory}/process --pid ${target.pid} --home ${home}`));
    report.checks.S15 = cross;
    for (const name of ['numericProcargs2', 'numericProcargs', 'numericProcInfo', 'processInfo', 'processPath', 'taskPort', 'taskReadPort', 'taskInspectPort', 'taskNamePort', 'externalSignal']) assert.equal(cross[name].blocked, true, name);
    assert.ok(cross.machServices.every(item => item.blocked));
    assert.equal(cross.descriptors.extraOpen, 0); assert.equal(cross.descriptors.sockets, 0);
    const filesystem = parse(await run('S04-S09', `${process.execPath} ${fixture} --child checks --plan ${planPath} --home ${home}`));
    report.checks.filesystem = filesystem;
    for (const [name, result] of Object.entries(filesystem)) {
      if (typeof result === 'boolean') assert.equal(result, true, name);
      else if (Array.isArray(result)) for (const variable of result) assert.equal(variable.blocked, true, variable.name);
      else assert.equal(result.blocked, true, name);
    }
    const sockets = parse(await run('S09-native-sockets', `${directory}/network ${plan.ports.UDP4} --home ${home}`));
    assert.ok(Object.values(sockets).every(item => item.blocked)); report.checks.sockets = sockets;
    const dns = await run('S09-DNS', `${process.execPath} ${fixture} --child dns --plan ${planPath} --home ${home}`);
    assert.equal(dns.ok, true); assert.notEqual(dns.exitCode, 0); report.checks.DNS = {result: dns, peerPackets: udpPackets};
    const descendant = parse(await run('S12-fork-exec', `{ ${process.execPath} ${fixture} --child checks --plan ${planPath} --home ${home}; } & wait`));
    assert.deepEqual(descendant, filesystem); report.checks.descendant = descendant;
    const spawnResult = parse(await run('S12-posix-spawn', `${process.execPath} ${fixture} --child spawn --plan ${planPath} --home ${home}`));
    assert.equal(spawnResult.detachedSpawn.blocked, true); report.checks.spawn = spawnResult;
    const controller = new AbortController();
    const running = run('S13', `${directory}/cancel --temp ${directory} --home ${home}`, controller.signal);
    let ready;
    for (let i = 0; i < 100; i++) { try { ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')); break; } catch {} await wait(20); }
    assert.ok(ready, 'Native double-fork fixture reached its heartbeat');
    assert.equal(ready.setsidBlocked, true); assert.equal(ready.setpgidBlocked, true); controller.abort();
    const result = await running;
    const before = await readFile(join(directory, 'heartbeat'), 'utf8'); await wait(300);
    const after = await readFile(join(directory, 'heartbeat'), 'utf8');
    let alive = false; try { process.kill(ready.pid, 0); alive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
    const latePid = Number(await readFile(join(directory, 'after-term.pid'), 'utf8'));
    let lateAlive = false; try { process.kill(latePid, 0); lateAlive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
    report.checks.S13 = { ready, result, heartbeatStopped: before === after, descendantAlive: alive, latePid, lateAlive };
    assert.equal(lateAlive, false);
    assert.equal(alive, false); assert.equal(before, after); assert.equal(result.cancelled, true);
    const unavailable = await runner.execute({ directory: home, input: { command: 'touch forbidden-fallback' }, signal: new AbortController().signal, execution });
    assert.equal(unavailable.ok, false); assert.equal(unavailable.error.code, 'SANDBOX_UNAVAILABLE'); report.checks.S03 = unavailable;
    const originalKill = process.kill; let settlementChecks = 0;
    process.kill = (pid, signal) => { if (pid < 0 && signal === 0) { settlementChecks++; throw Object.assign(new Error('Injected process-group observation failure'), {code:'EPERM'}); } return originalKill(pid, signal); };
    try {
      await assert.rejects(run('S13-unknown-observation-fault', 'printf invoked > unknown-once'), error => {
        report.checks.unknown = {code:error.data?.code, retryable:error.data?.retryable, settlementChecks, faultInjection:'group observation EPERM after real command'};
        return error.data?.code === 'TOOL_OUTCOME_UNKNOWN' && error.data.retryable === false;
      });
    } finally { process.kill = originalKill; }
    assert.equal(await readFile(join(directory,'unknown-once'),'utf8'), 'invoked'); assert.equal(settlementChecks,1);
    assert.equal(udpPackets, 0); report.checks.networkPeerPackets = udpPackets;
    const versions = {};
    for (const [name, command] of [['shell', 'printf shell-ok'], ['node', `${process.execPath} --version`], ['git', `/Library/Developer/CommandLineTools/usr/bin/git --version`], ['npm', `${process.execPath} /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js --version`], ['pnpm', `${process.execPath} /opt/homebrew/Cellar/pnpm/11.9.0/libexec/lib/node_modules/pnpm/bin/pnpm.cjs --version`]]) {
      const result = await run('S05-' + name, command); versions[name] = result; assert.equal(result.ok, true); if (['shell', 'node', 'git'].includes(name)) assert.equal(result.exitCode, 0, name); else versions[name].supported = result.exitCode === 0;
    }
    report.checks.runtime = versions;
    report.runtimeUnsupported = Object.entries(versions).filter(([,r])=>r.exitCode!==0).map(([name,r])=>({name,exitCode:r.exitCode,signal:r.signal,requiredPath:'explicit host Run with per-call confirmation'}));
    for (const [name, program, args] of [['missing-program', join(root, 'absent-sandbox'), []], ['invalid-profile', '/usr/bin/sandbox-exec', ['-p', '(invalid-profile)', '/bin/sh', '-c', 'printf forbidden-fallback', '--home', home]]]) {
      const r = spawnSync(program, [...args, '--home', home], {env, encoding: 'utf8'});
      assert.ok(r.error || r.status !== 0); assert.ok(!r.stdout?.includes('forbidden-fallback'));
      report.commands.push({name: 'S03-' + name, exitCode: r.status, errorCode: r.error?.code ?? null, signal: r.signal, stdout: r.stdout, stderr: r.stderr});
    }
    report.status = 'passed';
  } catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
  finally {
    target.kill('SIGKILL'); await targetExit;
    await Promise.all(datagrams.map(socket => new Promise(done => socket.close(done))));
    await Promise.all(servers.map(server => new Promise(done => server.close(done))));
    report.finishedAt = new Date().toISOString(); report.targetStopped = true;
    await writeFile(join(output, 'native-result.json'), json(report));
    console.log(JSON.stringify({ runId: report.runId, status: report.status, failure: report.failure, output }));
  }
}
