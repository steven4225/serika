import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
assert.ok(process.argv[2] && process.argv[3], 'Pass the absolute temporary release and evidence directories');
const release = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const sha = value => createHash('sha256').update(value).digest('hex');
const root = await realpath(await mkdtemp(join(tmpdir(), 'b2-release-test-')));
const project = join(root, 'project'), unrelated = join(root, 'unrelated cwd'), configPath = join(root, "test's H", 'config.json');
await Promise.all([project, unrelated, dirname(configPath), evidence].map(path => mkdir(path, {recursive:true})));
const original = JSON.stringify({ version: 1, authorizedDirectory: project, modules: {} }, null, 2) + '\n\n';
await writeFile(configPath, original, {mode:0o600});
const git=args=>execFileSync('git',args,{cwd:release,encoding:'utf8'}).trim();
const report = {scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),sourceCommit:git(['rev-parse','HEAD']),sourceWorktreeDirty:!!git(['status','--porcelain']),runId:randomUUID(), verification:'test-data-independent-local-clone-pnpm-build-no-model', release, cwd:unrelated, realModelCalls:0, status:'failed', files:{}, originalSha256:sha(original)};
try {
  for (const file of ['packages/assistant/scripts/config-upgrade.mjs','packages/assistant/dist/flock.js','packages/assistant/dist/tui-module-config.js','packages/assistant/dist/node-runtime.json','apps/desktop/out/main/index.js']) report.files[file] = sha(await readFile(join(release,file)));
  const runtime=JSON.parse(await readFile(join(release,'packages/assistant/dist/node-runtime.json'),'utf8'));
  report.nodeExecutable=runtime.nodeExecutable; assert.equal(runtime.nodeExecutable,process.execPath);
  const {readTuiModuleConfig}=await import(pathToFileURL(join(release,'packages/assistant/dist/tui-module-config.js')));
  let message; try { await readTuiModuleConfig(configPath); } catch(error) { message=error.message; }
  assert.match(message,/^配置为 v1，请运行 /); report.v1Message=message;
  const command=message.slice('配置为 v1，请运行 '.length,-' 升级'.length); report.copyableCommand=command;
  const run=command=>execFileSync('/bin/sh',['-c',command],{cwd:unrelated,env:process.env,encoding:'utf8'});
  report.dryRunDiff=run(command.replace("'--upgrade'","'--dry-run'")); assert.equal(sha(await readFile(configPath)),report.originalSha256);
  report.upgrade=JSON.parse(run(command)); assert.equal(report.upgrade.originalSha256,report.originalSha256); assert.equal(sha(await readFile(report.upgrade.backupPath)),report.originalSha256);
  const parsed=await readTuiModuleConfig(configPath); assert.equal(parsed.version,2); assert.deepEqual(parsed.authorizedDirectories,[{path:project,access:'readwrite'}]); assert.equal(parsed.projectDirectory,project);
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  report.rollback=JSON.parse(run(command.replace("'--upgrade'", "'--rollback' "+quote(report.upgrade.receiptPath))));
  report.restoredSha256=sha(await readFile(configPath)); assert.equal(report.restoredSha256,report.originalSha256); assert.equal(report.rollback.identical,true);
  report.rollbackReceipt=JSON.parse(await readFile(report.rollback.rollbackReceiptPath,'utf8'));
  report.status='passed';
} catch(error) {report.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally {await rm(root,{recursive:true,force:true});report.testDirectoryRemoved=true;await writeFile(join(evidence,'release-upgrade.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));}
