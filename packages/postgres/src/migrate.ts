import { runMigrations } from "./migrations.js";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  throw new Error("Usage: migrate <up|down>");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

await runMigrations({
  databaseUrl,
  direction,
  ...(direction === "down" ? { count: 1 } : {}),
  log: console.log,
});
