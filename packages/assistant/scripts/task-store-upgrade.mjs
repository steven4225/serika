import { upgradeTaskCopy, rollbackTaskCopy } from "../dist/task-store-upgrade.js";

const args = process.argv.slice(2);
let dataDirectory, mode;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--data") dataDirectory = args[++index];
  else if (arg === "--dry-run" || arg === "--upgrade" || arg === "--rollback") mode = arg;
  else throw new Error(`未知参数 ${arg}`);
}
if (!dataDirectory || !dataDirectory.startsWith("/")) throw new Error("--data 必须是已授权副本的绝对路径");
if (!mode) throw new Error("用法：node packages/assistant/scripts/task-store-upgrade.mjs --data <绝对路径> --dry-run | --upgrade | --rollback");
const result = mode === "--rollback" ? await rollbackTaskCopy({ dataDirectory }) : await upgradeTaskCopy({ dataDirectory, dryRun: mode === "--dry-run" });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
