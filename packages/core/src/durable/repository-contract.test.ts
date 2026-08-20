import { InMemoryDurableRepository } from "./in-memory-repository.js";
import { runDurableRepositoryContract } from "./repository-contract.js";
import type { JsonValue } from "./types.js";

runDurableRepositoryContract("InMemory", async () => {
  const repository = new InMemoryDurableRepository<JsonValue>();
  return {
    repository,
    readSnapshot: async (runId) => repository.readSnapshot(runId),
  };
});
