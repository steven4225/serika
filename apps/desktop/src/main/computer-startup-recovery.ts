import { ComputerDriverUnavailableError } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { changeModuleSetting, updateDesktopConfig } from "./module-settings.js";

/** Startup has no runtime owner yet. Recovery only revokes the selected config after explicit confirmation. */
export async function recoverComputerStartup(error: unknown, options: {
  cwd: string;
  confirm: (configPath: string) => Promise<boolean>;
  restart: () => void;
}): Promise<boolean> {
  if (!(error instanceof ComputerDriverUnavailableError)) return false;
  let expected: string | undefined;
  await updateDesktopConfig(error.configPath, options.cwd, async before => { expected = before; return undefined; });
  if (expected === undefined || !await options.confirm(error.configPath)) return false;
  await changeModuleSetting(error.configPath, { id: "computer", enabled: false, expectedEnabled: true }, options.cwd, expected);
  options.restart();
  return true;
}
