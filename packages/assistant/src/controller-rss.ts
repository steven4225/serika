import type { ControllerKernel } from "./controller-kernel.js";
import { createRssSubscriptionStore, rssFailure, type RssAction, type RssInbox, type RssResult, type RssView } from "./rss-subscriptions.js";
import { createTaskStore } from "./task-store.js";

/** RSS subscriptions and the results of their recurring digest task. */
export interface AssistantRssControls {
  getSubscriptions(): Promise<RssResult<RssView>>;
  updateSubscriptions(input: RssAction): Promise<RssResult<RssView>>;
  getInbox(): Promise<RssResult<RssInbox>>;
  acknowledgeResult(id: string): Promise<RssResult<void>>;
}

export function createRssControls(k: ControllerKernel): AssistantRssControls {
  const { app } = k;
  return {
    getInbox: async () => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS requires workspace and task module" } };
      try {
        const view = await createRssSubscriptionStore(app.workspaceRoot).read();
        if (view.scheduleId === null) return { ok: true, value: { tasks: [], truncated: false } };
        const tasks = createTaskStore(app.workspaceRoot);
        const list = await tasks.list({ recurringTaskId: view.scheduleId, inbox: true, limit: 5 });
        if (!list.ok) return list;
        const entries: RssInbox["tasks"] = [];
        for (const s of list.value.tasks) {
          const task = await tasks.get(s.id);
          if (!task.ok) return task;
          const t = task.value;
          const text = t.resultText ?? `${t.error?.code ?? t.status}: ${t.error?.message ?? "无结果回执"}`;
          entries.push({ id: t.id, status: t.status, finishedAt: t.finishedAt, text: text.slice(0, 24000), textTruncated: text.length > 24000 });
        }
        return { ok: true, value: { tasks: entries, truncated: list.value.truncated } };
      } catch (e) { return rssFailure(e); }
    },
    acknowledgeResult: async id => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "Acknowledgement requires enabled task module" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "Acknowledgement requires an idle controller" } };
      return k.exclusive("rss-acknowledge", async (): Promise<RssResult<void>> => {
        try {
          const view = await createRssSubscriptionStore(app.workspaceRoot!).read();
          const tasks = createTaskStore(app.workspaceRoot!);
          const task = await tasks.get(id);
          if (!task.ok) return task;
          if (!view.scheduleId || task.value.recurringTaskId !== view.scheduleId) return { ok: false, error: { code: "RSS_NOT_FOUND", message: "Result does not belong to this RSS schedule" } };
          const ack = await tasks.acknowledge(id);
          return ack.ok ? { ok: true, value: undefined } : ack;
        } catch (e) { return rssFailure(e); }
      });
    },
    getSubscriptions: async () => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS subscriptions require workspace and task module" } };
      return createRssSubscriptionStore(app.workspaceRoot).get();
    },
    updateSubscriptions: async input => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS subscriptions require workspace and task module" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "RSS changes require an idle controller" } };
      return k.exclusive("rss-subscriptions", async (): Promise<RssResult<RssView>> => {
        try { return await createRssSubscriptionStore(app.workspaceRoot!).update(input); }
        catch (error) { return rssFailure(error); }
      });
    },
  };
}
