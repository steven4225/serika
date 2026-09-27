import { createDemoModel } from "./demo-model.js";
import { configureCliModel } from "./model-config.js";
import { checkTuiStartup, readinessExitCode } from "./startup-check.js";
import { createRuntimeApp, type RuntimeApp } from "./app.js";
import { runTui } from "./tui.js";

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const checkArgs = args.filter((arg) => arg !== "--check" && arg !== "--tui");
  const snapshot = await checkTuiStartup(checkArgs);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  process.exit(readinessExitCode(snapshot));
}
const { modelAlias, model } = configureCliModel(createDemoModel);
const app = await createRuntimeApp({
  args,
  modelAlias,
  model,
  output: process.stdout,
  env: process.env,
  cwd: process.cwd(),
});

async function runMessage(app: RuntimeApp, id: string, text: string) {
  const handle = await app.runtime.run({
    agentId: app.agentId,
    threadId: "demo-thread",
    messages: [
      {
        id,
        role: "user",
        parts: [{ type: "text", text }],
      },
    ],
  });
  const consumeEvents = (async () => {
    for await (const event of handle.events) {
      console.log(`[${event.sequence}] ${event.type}`, event.data);
    }
  })();
  const result = await handle.result;
  await consumeEvents;
  console.log("\nResult:", result);
}

try {
  if (app.tuiMode) {
    await runTui({
      runtime: app.runtime,
      store: app.store,
      threadId: app.threadId,
      agentId: app.agentId,
      output: process.stdout,
      registerNotificationRedraw: app.registerNotificationRedraw,
      renderHome: app.renderHome,
      ...(app.toolConfirmation ? { toolConfirmation: app.toolConfirmation } : {}),
      ...(app.commands ? { commands: app.commands } : {}),
      ...(app.compaction ? { compaction: app.compaction } : {}),
      ...(app.resume ? { resume: app.resume } : {}),
      ...(app.autoConsolidationAgentId
        ? { autoConsolidationAgentId: app.autoConsolidationAgentId }
        : {}),
    });
  } else {
    await runMessage(app, "user-1", "What is 20 + 22?");
    await runMessage(app, "user-2", "What was the previous result?");
    console.log(`\nTranscript directory: ${app.directory}`);
  }
} finally {
  app.dispose();
}
