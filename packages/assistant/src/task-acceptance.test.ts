import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { JsonlAgentStore } from "@serika/core";
import { createModuleHost } from "./module-host.js";
import { createTaskModule } from "./modules/task-module.js";
import { createTaskStore} from "./task-store.js";

// Ordinary tests never use a paid provider, even if RUNLOOM_MODEL is inherited.
// Opt in explicitly when running this file for live acceptance.
const model = process.env.RUNLOOM_ACCEPTANCE_MODEL ?? "mock";

it(`task lifecycle acceptance (${model}): command → worker → inbox → ack → restart`,
  { timeout: 100_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-task-acceptance-"));
    const store = createTaskStore(join(root, "data/tasks.json"));
    const notifications = new EventEmitter();
    const host = createModuleHost([createTaskModule(store)], {
      notify: (_module, message) => notifications.emit("message", message),
    });
    const children: ChildProcess[] = [];
    const entry = fileURLToPath(new URL("./task-worker-entry.js", import.meta.url));
    let workerError = "";

    async function command(args: string): Promise<string> {
      const received = once(notifications, "message", { signal: AbortSignal.timeout(5_000) });
      host.commands.get("task")!.execute(args);
      const [message] = await received;
      return message as string;
    }

    function startWorker(): ChildProcess {
      workerError = "";
      const child = spawn(process.execPath, [entry, "--home", root, "--config", join(root, "config.json")], {
        env: { ...process.env, RUNLOOM_MODEL: model },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(child);
      child.on("error", (error) => { workerError += error.message; });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => { workerError += chunk; });
      return child;
    }

    async function stopWorker(child: ChildProcess): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.kill("SIGKILL");
      await closed;
    }

    async function waitCompleted(id: string, child: ChildProcess) {
      const deadline = Date.now() + (model === "mock" ? 10_000 : 40_000);
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, workerError);
        assert.equal(child.signalCode, null, workerError);
        const result = await store.get(id);
        assert.ok(result.ok, JSON.stringify(result));
        if (result.value.status === "completed") return result.value;
        assert.ok(["scheduled", "running"].includes(result.value.status), JSON.stringify(result));
        await setTimeout(50);
      }
      assert.fail(`Task ${id} did not complete: ${workerError}`);
    }

    try {
      await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, modules: { task: { enabled: true } } }));
      const prompt = "Reply with only these two words: acceptance passed";
      const createdText = await command(`create ${new Date(Date.now() + 500).toISOString()} ${prompt}`);
      assert.match(createdText, /^Task created: /);
      const created = JSON.parse(createdText.slice("Task created: ".length)) as { id: string };
      const firstWorker = startWorker();
      const completed = await waitCompleted(created.id, firstWorker);
      assert.ok(completed.resultText?.trim());
      assert.ok(completed.threadId);
      assert.ok(completed.runId);
      assert.equal(completed.acknowledgedAt, null);

      const transcriptStore = new JsonlAgentStore({ directory: join(root, "transcripts/tasks") });
      const messages = await transcriptStore.getMessages(completed.threadId);
      assert.equal(messages[0]?.role, "user");
      assert.deepEqual(messages[0]?.parts, [{ type: "text", text: prompt }]);
      const answer = messages.filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text).join("");
      assert.equal(answer, completed.resultText);

      const beforeRead = await readFile(join(root, 'data/tasks.json'), "utf8");
      assert.ok((await command("inbox")).includes(`ID: ${created.id}`));
      assert.ok((await command(`show ${created.id}`)).includes(`Result: ${completed.resultText}`));
      assert.equal(await readFile(join(root, 'data/tasks.json'), "utf8"), beforeRead);

      assert.match(await command(`ack ${created.id}`), /^Task acknowledged: /);
      assert.equal(await command("inbox"), "Tasks: 0");
      const acknowledged = await store.get(created.id);
      assert.ok(acknowledged.ok && acknowledged.value.acknowledgedAt);
      await stopWorker(firstWorker);

      // A second completed task proves the restarted process is actually working.
      const second = await store.create({ runAt: new Date(Date.now() + 500).toISOString(), prompt });
      assert.ok(second.ok);
      const secondWorker = startWorker();
      const nextCompleted = await waitCompleted(second.value.id, secondWorker);
      assert.notEqual(nextCompleted.threadId, completed.threadId);
      const reopened = createTaskStore(join(root, "data/tasks.json"));
      assert.deepEqual(await reopened.get(created.id), acknowledged);
      assert.deepEqual(await reopened.acknowledge(created.id), acknowledged);
      const inbox = await reopened.list({ inbox: true });
      assert.ok(inbox.ok);
      assert.deepEqual(inbox.value.tasks.map((task) => task.id), [second.value.id]);
      const transcriptsAfterRestart = new JsonlAgentStore({ directory: join(root, "transcripts/tasks") });
      assert.deepEqual(await transcriptsAfterRestart.getMessages(completed.threadId), messages);
    } finally {
      for (const child of children) await stopWorker(child);
      host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
