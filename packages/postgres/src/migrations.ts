import { fileURLToPath } from "node:url";
import { runner, type RunnerOption } from "node-pg-migrate";

export interface RunMigrationsOptions {
  databaseUrl: string;
  direction?: "up" | "down";
  count?: number;
  log?: (message: string) => void;
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<void> {
  const migrationsDirectory = fileURLToPath(
    new URL("./migrations", import.meta.url),
  );
  const runnerOptions: RunnerOption = {
    databaseUrl: options.databaseUrl,
    direction: options.direction ?? "up",
    dir: `${migrationsDirectory}/*.js`,
    useGlob: true,
    migrationsTable: "runloom_migrations",
    checkOrder: true,
    singleTransaction: true,
    log: options.log ?? (() => undefined),
  };
  if (options.count !== undefined) runnerOptions.count = options.count;
  await runner(runnerOptions);
}
