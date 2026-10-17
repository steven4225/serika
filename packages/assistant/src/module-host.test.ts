import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import {
  createModuleHost,
  type AgentModule,
  type ModuleContext,
} from "./module-host.js";

function registeredTool(name: string): RegisteredTool {
  return {
    metadata: {
      name,
      version: "1",
      risk: "read",
      timeoutMs: 1_000,
      idempotent: true,
    },
    tool: tool({
      inputSchema: z.object({}),
      execute: async () => "ok",
    }) as ToolSet[string],
  };
}

function moduleWithSetup(
  id: string,
  setup: (context: ModuleContext) => void | (() => void),
): AgentModule {
  return { id, setup };
}

describe("createModuleHost", () => {
  it("collects tools and commands and closes the registration window", () => {
    let context!: ModuleContext;
    const host = createModuleHost(
      [
        moduleWithSetup("one", (next) => {
          context = next;
          next.registerTool(registeredTool("one-tool"));
          next.registerCommand({ name: "one", execute() {} });
        }),
      ],
      { notify() {} },
    );

    assert.equal(host.tools.length, 1);
    assert.equal(host.tools[0]?.metadata.name, "one-tool");
    assert.equal(host.commands.get("one")?.name, "one");
    assert.throws(() => context.registerTool(registeredTool("late-tool")), /registration is closed/);
    assert.throws(
      () => context.registerCommand({ name: "late", execute() {} }),
      /registration is closed/,
    );
  });

  it("rejects duplicate module ids before setup", () => {
    let setups = 0;
    assert.throws(
      () =>
        createModuleHost(
          [
            moduleWithSetup("same", () => {
              setups += 1;
            }),
            moduleWithSetup("same", () => {
              setups += 1;
            }),
          ],
          { notify() {} },
        ),
      /Module already registered: same/,
    );
    assert.equal(setups, 0);
  });

  it("rejects duplicate command names and disposes successful setup", () => {
    const disposed: string[] = [];
    assert.throws(
      () =>
        createModuleHost(
          [
            moduleWithSetup("one", (context) => {
              context.registerCommand({ name: "same", execute() {} });
              return () => disposed.push("one");
            }),
            moduleWithSetup("two", (context) => {
              context.registerCommand({ name: "same", execute() {} });
              return () => disposed.push("two");
            }),
          ],
          { notify() {} },
        ),
      /Command already registered: same/,
    );
    assert.deepEqual(disposed, ["two", "one"]);
  });

  it("discards a failed module and disposes prior modules in reverse order", () => {
    const disposed: string[] = [];
    const lateContext: ModuleContext[] = [];
    const error = new Error("setup failed");

    assert.throws(
      () =>
        createModuleHost(
          [
            moduleWithSetup("one", () => () => disposed.push("one")),
            moduleWithSetup("two", (context) => {
              lateContext.push(context);
              context.registerTool(registeredTool("discarded"));
              throw error;
            }),
          ],
          { notify() {} },
        ),
      (actual: unknown) => actual === error,
    );
    assert.deepEqual(disposed, ["one"]);
    assert.throws(
      () => lateContext[0]?.registerTool(registeredTool("late")),
      /registration is closed/,
    );
  });

  it("continues disposal and throws AggregateError", () => {
    const first = new Error("first");
    const second = new Error("second");
    const disposed: string[] = [];
    const host = createModuleHost(
      [
        moduleWithSetup("one", () => () => {
          disposed.push("one");
          throw first;
        }),
        moduleWithSetup("two", () => () => {
          disposed.push("two");
          throw second;
        }),
      ],
      { notify() {} },
    );

    assert.throws(
      () => host.dispose(),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0] === second &&
        error.errors[1] === first,
    );
    assert.deepEqual(disposed, ["two", "one"]);
    host.dispose();
    assert.deepEqual(disposed, ["two", "one"]);
  });

  it("routes notify with the module id", () => {
    const notifications: Array<[string, string]> = [];
    let notify!: (message: string) => void;
    createModuleHost(
      [
        moduleWithSetup("read-file", (context) => {
          notify = context.notify;
        }),
      ],
      { notify(moduleId, message) { notifications.push([moduleId, message]); } },
    );

    notify("workspace");
    assert.deepEqual(notifications, [["read-file", "workspace"]]);
  });
  it("collects declared permission facts, tool ownership, and per-module instructions", () => {
    let late!: ModuleContext;
    const seen: boolean[] = [];
    const host = createModuleHost(
      [
        moduleWithSetup("one", (context) => {
          context.registerTool(registeredTool("plain"));
          context.registerTool(registeredTool("scoped"), {
            scope: { kind: "origin", argument: "url" },
            defaults: { remember: "scope" },
          });
          context.addInstructions("first. ");
          context.addInstructions("second. ");
          seen.push(context.isAssembled("two"), context.isAssembled("missing"));
          late = context;
        }),
        moduleWithSetup("two", (context) => {
          context.registerTool(registeredTool("other"), { denialBlocksForRun: ["plain"] });
        }),
      ],
      { notify() {} },
    );

    assert.deepEqual(seen, [true, false], "a module sees every assembled module, even later ones");
    assert.deepEqual([...host.toolModules], [["plain", "one"], ["scoped", "one"], ["other", "two"]]);
    assert.deepEqual([...host.toolPermissions.keys()], ["scoped", "other"], "tools without facts have no entry");
    assert.deepEqual(host.toolPermissions.get("other"), { denialBlocksForRun: ["plain"] });
    assert.equal(host.instructions("one"), "first. second. ");
    assert.equal(host.instructions("two"), "");
    assert.equal(host.instructions("missing"), "");
    assert.throws(() => late.addInstructions("late"), /registration is closed: one/);
    assert.equal(host.instructions("one"), "first. second. ");
  });

  it("leaves no permission facts or instructions from a failed module", () => {
    assert.throws(() => createModuleHost(
      [moduleWithSetup("broken", (context) => {
        context.registerTool(registeredTool("half"), { defaults: { remember: "scope" } });
        context.addInstructions("never. ");
        throw new Error("boom");
      })],
      { notify() {} },
    ), /boom/);
  });
  it("words function-form instructions for the Run and keeps their order", () => {
    const host = createModuleHost([moduleWithSetup("one", (context) => {
      context.addInstructions("fixed. ");
      context.addInstructions(({ autonomous }) => autonomous ? "host-authorized. " : "asks y/n. ");
    })], { notify() {} });
    assert.equal(host.instructions("one"), "fixed. asks y/n. ");
    assert.equal(host.instructions("one", { autonomous: true }), "fixed. host-authorized. ");
  });
});
