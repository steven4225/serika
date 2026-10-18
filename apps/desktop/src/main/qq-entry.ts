import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { configureCliModel } from "@aisdk-agent/example-cli/dist/model-config.js";
import { startQqHost } from "./qq-host.js";

async function main() {
  const configPath = process.env.QQ_CONFIG?.trim();
  if (!configPath) throw new Error("请在可信外部环境文件中配置 QQ_CONFIG 和 QQ_ACCESS_TOKEN。");
  const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
  const host = await startQqHost({ configPath, env: process.env, modelAlias, model, log: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`QQ 群助手已连接：群 ${host.config.binding.groupId}，机器人 ${host.config.binding.botId}。仅主人 ${host.config.binding.ownerId} 可批准工具。\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await host.close(); process.exitCode = 0; }
    catch { process.stderr.write("QQ 模式退出未确认，请核对群工作区执行回执。\n"); process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
void main().catch(() => {
  // Provider/config/transport error messages may include secrets. Never echo them.
  process.stderr.write("QQ 群助手启动失败。请核对独立 QQ_CONFIG、QQ_ACCESS_TOKEN、模型设置、NapCat 登录账号、状态目录权限及重复实例；未自动重试。\n");
  process.exitCode = 1;
});
