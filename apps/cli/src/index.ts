import { configureCliModel, createDemoModel, createRuntimeApp, readinessExitCode, type RuntimeApp } from "@serika/assistant";
import { checkTuiStartup } from "./startup-check.js";
import { runTui } from "./tui.js";
import { parseTuiArgs } from "./cli-options.js";

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const checkArgs = args.filter((arg) => arg !== "--check" && arg !== "--tui");
  const snapshot = await checkTuiStartup(checkArgs);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  process.exit(readinessExitCode(snapshot));
}
const { modelAlias, model } = configureCliModel(createDemoModel);
// `--tui [directory] [flags]` assembles the full assistant; anything else runs
// the offline demo, whose optional first argument is the transcript directory.
const tuiArgs = args[0] === "--tui" ? parseTuiArgs(args.slice(1)) : undefined;
const { directory, ...assistant } = tuiArgs ?? { directory: args[0] };
const app = await createRuntimeApp({
  ...(directory !== undefined ? { directory } : {}),
  ...(tuiArgs ? { assistant } : {}),
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
      ...(app.resume ? { resume: app.resume } : {}),
    });
  } else {
    await runMessage(app, "user-1", "What is 20 + 22?");
    await runMessage(app, "user-2", "What was the previous result?");
    console.log(`\nTranscript directory: ${app.directory}`);
  }
} finally {
  app.dispose();
}
