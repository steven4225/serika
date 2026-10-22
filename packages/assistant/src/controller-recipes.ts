import type { ControllerKernel } from "./controller-kernel.js";
import type { MemoryResult } from "./memory-types.js";
import { memoryControlFailure } from "./memory-controls.js";
import { RecipeError, recipeChangeSchema, type RecipeChange, type RecipeEntry } from "./recipe-store.js";

/** Saved Shell command recipes. */
export interface AssistantRecipeControls {
  list(): Promise<MemoryResult<RecipeEntry[]>>;
  change(input: RecipeChange): Promise<MemoryResult<RecipeEntry>>;
}

export function createRecipeControls(k: ControllerKernel): AssistantRecipeControls {
  const { app } = k;
  return {
    list: async () => {
      if (k.isClosed() || !app.recipes) return memoryControlFailure("RECIPE_UNAVAILABLE", "Command recipes require configured Shell and workspace");
      try { return { ok: true, value: await app.recipes.list(new AbortController().signal) }; }
      catch (error) { return memoryControlFailure(error instanceof RecipeError ? error.code : "READ_FAILED", "Cannot read recipes; existing catalog is preserved"); }
    },
    change: async input => {
      const parsed = recipeChangeSchema.safeParse(input);
      if (!parsed.success) return memoryControlFailure("INVALID_INPUT", "Invalid recipe change");
      if (k.isClosed() || !app.recipes) return memoryControlFailure("RECIPE_UNAVAILABLE", "Command recipes are unavailable");
      if (!k.isIdle()) return memoryControlFailure("BUSY", "Recipe changes require an idle controller");
      return k.exclusive("recipe-change", async (signal): Promise<MemoryResult<RecipeEntry>> => {
        try {
          await k.ensureRecovered();
          const value = parsed.data;
          return { ok: true, value: await app.recipes!.change(value.id, value.expectedRevision, value.action, value.hash, signal) };
        } catch (error) { return memoryControlFailure(error instanceof RecipeError ? error.code : "WRITE_FAILED", "Recipe change is unconfirmed; reread before another action"); }
      });
    },
  };
}
