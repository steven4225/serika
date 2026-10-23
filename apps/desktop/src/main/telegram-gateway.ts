import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopRuntime } from "./desktop-runtime.js";
import { TelegramApiError, type TelegramApi, type TelegramUpdate, type TelegramKeyboard } from "./telegram-api.js";
import { TelegramStore, telegramCapacity, type TelegramInbound, type TelegramDelivery, type TelegramTaskRoute } from "./telegram-store.js";
import type { PendingApproval } from "../shared/ui-contract.js";
import type { TelegramStatus } from "../shared/telegram.js";
import type { SavedTaskArrangement } from "@serika/assistant";
import type { TaskListInput } from "@serika/assistant";
import { formatLocalTaskTime, MODEL_TIME_ZONE } from "@serika/assistant";
import { telegramParts, telegramApprovalText, telegramBoundedText } from "./telegram-format.js";
import { formatCapabilityStatus } from "@serika/assistant";

type Host = Pick<DesktopRuntime, "channelTelegramAutonomyEnabled" | "channelSubscribe" | "channelSnapshot" | "channelCreateThread" | "channelRun" | "channelReceipt" | "channelScheduledTask" | "channelRecurringTask" | "channelScheduledTasks" | "current">;
function code() { return randomBytes(5).toString("hex").toUpperCase(); }
function approvalHash(value: PendingApproval) {
  // Preview is asynchronous presentation, not authority; hash the actual operation.
  return createHash("sha256").update(JSON.stringify([value.approvalId, value.toolCallId, value.toolName, value.input])).digest("hex");
}
export class TelegramGateway {
  #connection: TelegramStatus["connection"] = "disabled";
  #botUsername: string | null = null;
  #error: string | null = null;
  #deliveryError: string | null = null;
  #pairing: TelegramStatus["pairing"] = null;
  #approval: { code: string; runId: string; threadId: string; userId: number; chatId: number; hash: string; approvalId: string; expires: number } | undefined;
  #taskProposal: { code: string; goal: string; expires: number } | undefined;
  #abort: AbortController | undefined;
  #poll: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #events: Promise<void> = Promise.resolve();
  #remove: () => void;
  #activeKey: string | undefined;
  #settings = false;
  #pausing = false;
  get autonomyPaused() { return this.#pausing || this.store.snapshot().autonomyPaused === true; }
  async setAutonomyPaused(paused: boolean) {
    if (paused) this.#pausing = true;
    await this.store.update(data => { data.autonomyPaused = paused; });
    this.#pausing = false;
  }
  constructor(private host: Host, readonly store: TelegramStore, private api: TelegramApi | undefined, private now = Date.now) {
    this.#remove = host.channelSubscribe(message => {
      // Capture association now, before a later Thread switch changes the selected runtime.
      const key = this.#activeKey;
      if (message.type === "approval-cleared" && this.#approval?.approvalId === message.approvalId) {
        this.#approval = undefined;
        this.#queue(() => this.#discardStaleApprovals());
      }
      if (!key || !this.store.snapshot().enabled) return;
      const source = this.store.snapshot().inputs.find(input => input.key === key);
      if (!source?.runId) return;
      if (message.type === "event" && message.phase === "primary" && message.event.runId === source.runId) {
        const event = message.event;
        if (event.type === "run.steer.not_applied") {
          const correction = this.store.snapshot().inputs.find(item => item.runId === source.runId && item.steerId === event.data.id);
          if (correction) this.#queue(async () => { await this.#reply(`input:${correction.key}`, this.store.snapshot().owner!.chatId, "本轮未应用这条补充；请查看桌面执行记录。"); });
        }
        if (event.type === "tool.call.requested" && ["task_create", "task_repeat_create"].includes(event.data.toolName)) {
          const input = event.data.input as { arrangement?: { kind?: unknown } } | null;
          if (input?.arrangement?.kind === "reminder") this.#queue(() => this.#reminderReceipt(source, event.data.toolCallId));
        }
        if (event.type === "tool.call.completed") this.#queue(() => this.#reminderReceipt(source, event.data.toolCallId, { output: event.data.output }));
        if (event.type === "tool.call.failed") this.#queue(() => this.#reminderReceipt(source, event.data.toolCallId, { errorCode: event.data.error.code }));
      }
      if (message.type === "approval") this.#queue(async () => { await this.#publishApproval(source, message.approval); });
      if (message.type === "result" && message.phase === "primary" && message.result.runId === source.runId) {
        this.#approval = undefined;
        this.#queue(() => this.#finish(source, message.result.text));
      }
    });
  }
  #queue(action: () => Promise<void>) {
    this.#events = this.#events.then(action).catch(() => { this.#error = "Telegram 记录或投递未确认；请查看连接状态和桌面回执，不会重做执行。"; });
  }
  async #reminderReceipt(source: TelegramInbound, toolCallId: string, resolution?: { output?: unknown; errorCode?: string }) {
    const current = this.store.snapshot().inputs.find(x => x.key === source.key);
    if (!current || current.runId !== source.runId) return;
    if (resolution && !current.reminderReceipts?.some(x => x.toolCallId === toolCallId)) return;
    const { output, errorCode } = resolution ?? {};
    const result = output && typeof output === "object" ? output as { ok?: boolean; readback?: unknown } : undefined;
    const text = errorCode === "TOOL_OUTCOME_UNKNOWN" ? "提醒保存结果未知；请先核对，不要重复创建。"
      : errorCode === "TOOL_DENIED" ? "已取消，这条提醒未保存。"
      : errorCode !== undefined || result?.ok === false ? "这条提醒未保存，请核对时间与内容后再试。"
      : result?.ok === true && typeof result.readback === "string" ? telegramBoundedText(result.readback, 12_000)
      : "提醒保存状态尚未确认；请先核对，不要重复创建。";
    await this.store.update(data => {
      const saved = data.inputs.find(x => x.key === source.key)!;
      const receipts = saved.reminderReceipts ??= [];
      const receipt = receipts.find(x => x.toolCallId === toolCallId);
      if (receipt) receipt.text = text; else receipts.push({ toolCallId, text });
    });
  }
  autonomyBinding(): import("@serika/assistant").TelegramAutonomyGrant | null {
    const data = this.store.snapshot();
    const directory = this.host.channelSnapshot().info.authorizedDirectory;
    return data.owner && data.botId && directory ? { directory, botId: data.botId, userId: data.owner.userId, chatId: data.owner.chatId, threadId: data.owner.threadId } : null;
  }
  matchesAutonomyGrant(grant: import("@serika/assistant").TelegramAutonomyGrant) {
    const binding = this.autonomyBinding();
    return !this.autonomyPaused && !!binding && Object.keys(binding).every(key => binding[key as keyof typeof binding] === grant[key as keyof typeof grant]);
  }
  status(): TelegramStatus {
    const data = this.store.snapshot();
    return { autonomyEnabled: this.host.channelTelegramAutonomyEnabled(), autonomyPaused: this.autonomyPaused, available: true, tokenConfigured: !!this.api, enabled: data.enabled, connection: this.#connection, botUsername: this.#botUsername,
      owner: data.owner, pairing: this.#pairing && Date.parse(this.#pairing.expiresAt) > this.now() ? structuredClone(this.#pairing) : null,
      lastError: this.#error ?? this.#deliveryError, awaitingReview: data.inputs.filter(x => x.state === "unknown").length,
      failedDeliveries: data.deliveries.filter(x => x.state === "failed").length, unknownDeliveries: data.deliveries.filter(x => x.state === "unknown" && !x.reviewReport).length,
      reviews: data.inputs.filter(x => x.state === "unknown").slice(0, 10).map(x => ({ key: x.key, runId: x.runId, taskId: x.taskId })),
      pendingDeliveries: data.deliveries.filter(x => x.state === "pending" || x.state === "sending").length,
      capacity: telegramCapacity(data),
      routes: data.routes.map(x => ({ id: x.id, kind: x.kind, fromRunAt: x.fromRunAt })),
      deliveries: data.deliveries.filter(x => x.state !== "cancelled").reverse()
        .sort((a, b) => Number(a.state === "submitted" || !!a.reviewReport) - Number(b.state === "submitted" || !!b.reviewReport)).slice(0, 20).map(x => ({
        key: x.key, state: x.state as "pending" | "sending" | "submitted" | "failed" | "unknown", preview: x.text.slice(0, 160), messageId: x.messageId,
        retryAllowed: /^(scheduled|result):/.test(x.key) && x.state === "failed" && (!x.retryAt || Date.parse(x.retryAt) <= this.now()) && data.enabled && this.#connection === "online" && x.chatId === data.owner?.chatId,
        error: x.error ?? null, ...(x.reviewReport ? { reviewReport: x.reviewReport } : {}),
      })) };
  }
  /** The model cannot supply destinations. Only a saved tool result owned by this channel is routed. */
  arrangementDestination() {
    const running = this.#ownedRunning(), owner = this.store.snapshot().owner;
    return running && owner ? `Telegram 已绑定私聊 ${owner.chatId}` : null;
  }
  async arrangementSaved(saved: SavedTaskArrangement) {
    const running = this.#ownedRunning();
    if (!running) return;
    await this.#saveRoute(saved.task.id, saved.kind, saved.kind === "once" ? saved.task.runAt : new Date(this.now()).toISOString(), running.source);
  }
  async #saveRoute(id: string, kind: "once" | "recurring", fromRunAt: string, source?: TelegramInbound) {
    await this.store.update(data => {
      if (!data.enabled || !data.owner) throw new Error("安排已保存，但 Telegram 未连接或绑定；未登记投递目的地");
      const key = `${kind}:${id}`;
      if (data.routes.some(x => x.key === key)) return;
      data.routes.push({ key, id, kind, fromRunAt, userId: data.owner.userId, chatId: data.owner.chatId,
        ...(source?.runId ? { sourceKey: source.key, sourceRunId: source.runId } : {}) });
    });
  }
  async setTaskRoute(input: { id: string; kind: "once" | "recurring"; enabled: boolean }) {
    if (!input || typeof input.id !== "string" || !input.id || !["once", "recurring"].includes(input.kind) || typeof input.enabled !== "boolean") throw new Error("Telegram 投递设置无效");
    const key = `${input.kind}:${input.id}`;
    if (!input.enabled) {
      await this.store.update(data => {
        data.routes = data.routes.filter(x => x.key !== key);
        for (const delivery of data.deliveries) if (delivery.routeKey === key && ["pending", "failed"].includes(delivery.state)) delivery.state = "cancelled";
      });
    } else {
      const record = input.kind === "once" ? await this.host.channelScheduledTask(input.id) : await this.host.channelRecurringTask(input.id);
      if (!record.ok || !record.value || !record.value.arrangement ||
        !(input.kind === "once" ? ["scheduled", "running"].includes(record.value.status) && !("recurringTaskId" in record.value && record.value.recurringTaskId) : record.value.status === "active")) {
        throw new Error("只能选择当前工作区未结束的安排；不会转发历史结果或未声明来源的任务");
      }
      await this.#saveRoute(input.id, input.kind, input.kind === "once" ? (record.value as { runAt: string }).runAt : new Date(this.now()).toISOString());
    }
    return this.status();
  }
  async retryDelivery(key: string) {
    const data = this.store.snapshot();
    if (!data.enabled || this.#connection !== "online" || !data.owner || typeof key !== "string" || !/^(scheduled|result):/.test(key)) throw new Error("请连接已绑定的 Telegram 后重试结果发送");
    await this.store.update(next => {
      const delivery = next.deliveries.find(x => x.key === key);
      if (!next.enabled || !delivery || delivery.state !== "failed" || delivery.chatId !== next.owner?.chatId || (delivery.retryAt && Date.parse(delivery.retryAt) > this.now())) throw new Error("只有明确未发送的失败结果可以重试；未知、已提交和限流等待中的消息不会重发");
      delivery.state = "pending";
      for (const part of delivery.parts ?? []) if (part.state === "failed") part.state = "pending";
    });
    await this.#flush(); // No model call, task claim, or execution restart.
    return this.status();
  }
  async resolveDelivery(input: { key: string; action: "cancel" | "review"; note?: string }) {
    if (!input || typeof input.key !== "string" || !["cancel", "review"].includes(input.action)) throw new Error("投递处理参数无效");
    await this.store.update(next => {
      const delivery = next.deliveries.find(item => item.key === input.key);
      if (!delivery || delivery.chatId !== next.owner?.chatId) throw new Error("投递不属于当前绑定账号");
      if (input.action === "cancel") {
        if (!["pending", "failed"].includes(delivery.state)) throw new Error("只可停止尚未发送或明确失败的消息；发送中和结果未知不能当作未发送");
        delivery.state = "cancelled";
      } else {
        if (delivery.state !== "unknown" || typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw new Error("未知投递需要填写实际核对观察");
        delivery.reviewReport = input.note.trim(); // Keeps unknown; no claim of delivery or read.
      }
    });
    return this.status();
  }
  #scanning: Promise<void> | undefined;
  async #collectSafely() {
    try { await this.collectScheduledResults(); this.#deliveryError = null; }
    catch { this.#deliveryError = "安排投递暂不可读或超过扫描容量；消息入口仍可用，未把遗漏结果标成已发送。请回桌面核对。"; }
  }
  /** Reconstruct missing sends from exact terminal TaskStore records, never execute the task. */
  async collectScheduledResults() {
    if (this.#scanning) return this.#scanning;
    if (!this.store.snapshot().enabled || !this.store.snapshot().owner) return;
    this.#scanning = (async () => {
      for (const route of this.store.snapshot().routes) {
        if (route.kind === "once") await this.#collectTask(route, route.id);
        else {
          let before: TaskListInput["before"] = route.scanBefore;
          for (let page = 0; page < 20; page++) {
            const listed = await this.host.channelScheduledTasks({ recurringTaskId: route.id, limit: 50, ...(before ? { before } : {}) });
            if (!listed.ok) throw new Error("安排结果暂不可读；未标记为已发送");
            for (const task of listed.value.tasks) {
              if (Date.parse(task.runAt) >= Date.parse(route.fromRunAt) && ["completed", "failed", "interrupted"].includes(task.status)) await this.#collectTask(route, task.id);
            }
            // TaskStore pages descending creation time. Recurring instances are
            // only created when due, so pre-opt-in instances cannot be new sends.
            const reachedOld = listed.value.nextCursor !== null && listed.value.nextCursor !== undefined && Date.parse(listed.value.nextCursor.createdAt) < Date.parse(route.fromRunAt);
            before = !listed.value.truncated || reachedOld ? undefined : listed.value.nextCursor ?? undefined;
            if (listed.value.truncated && !reachedOld && !before) throw new Error("安排历史分页位置缺失；未标记遗漏结果");
            await this.store.update(data => {
              const current = data.routes.find(x => x.key === route.key && x.fromRunAt === route.fromRunAt);
              if (current) { if (before) current.scanBefore = before; else delete current.scanBefore; }
            });
            // New results already found are deliverable even if the next read fails.
            await this.#flush();
            if (!before) break;
          }
        }
      }
      await this.#flush();
    })().finally(() => { this.#scanning = undefined; });
    return this.#scanning;
  }
  async #collectTask(route: TelegramTaskRoute, id: string) {
          const key = `scheduled:${id}`;
          if (await this.store.hasDelivery(key)) return;
          const result = await this.host.channelScheduledTask(id);
          if (!result.ok) throw new Error("安排结果暂不可读；未标记为已发送");
          const task = result.value;
          if (!task || task.id !== id || !task.arrangement || !["completed", "failed", "interrupted"].includes(task.status) || !task.finishedAt ||
            (route.kind === "recurring" ? task.recurringTaskId !== route.id || Date.parse(task.runAt) < Date.parse(route.fromRunAt) : task.recurringTaskId !== null)) return;
          // Under the configured --notify worker, null is the persisted empty RSS outcome.
          if (task.arrangement.kind === "rss-digest" && task.status === "completed" && task.notification === null) return;
          const label = task.status === "completed" ? "安排已完成" : task.status === "interrupted" ? "安排中断，未自动重做；请回桌面核对" : "安排执行失败";
          const text = telegramBoundedText(`${label}\n${task.resultText ?? task.error?.message ?? "没有结果正文"}`);
          await this.store.update(data => {
            if (!data.enabled || !data.routes.some(x => x.key === route.key && x.fromRunAt === route.fromRunAt) || data.owner?.chatId !== route.chatId || data.owner.userId !== route.userId || data.deliveries.some(x => x.key === key)) return;
            data.deliveries.push({ key, routeKey: route.key, chatId: route.chatId, text, parts: this.#parts(text, true), state: "pending", messageId: null });
          });
  }
  async reviewInput(input: { key: string; note: string }) {
    if (!input || typeof input.key !== "string" || typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw new Error("请填写核对后的实际观察（最多 2000 字）");
    const data = this.store.snapshot(), owner = data.owner, source = data.inputs.find(x => x.key === input.key);
    const current = this.host.channelSnapshot();
    if (!source || source.state !== "unknown" || !owner || current.info.threadId !== owner.threadId || current.snapshot.state.kind !== "idle") throw new Error("请先在桌面打开 Telegram 对话并完成回执核对，空闲时再报告观察");
    if (source.taskId) {
      const task = await this.host.current.getWorkTask(source.taskId);
      if (!task.ok || task.value.status === "needs_review" || task.value.status === "running") throw new Error("请先在工作任务中完成未知效果核对；这里不能绕过任务核对");
    }
    await this.store.update(next => {
      const saved = next.inputs.find(x => x.key === input.key)!;
      if (saved.state !== "unknown") throw new Error("核对记录已变化");
      saved.state = "reviewed"; saved.reviewReport = input.note.trim();
    });
    return this.status(); // A human report, never success evidence or permission restoration.
  }
  async initialize() {
    // No model call, no tool, no approval restoration. Pending sends are not execution.
    await this.store.update(data => {
      for (const input of data.inputs) if (["reserved", "bound"].includes(input.state)) input.state = "unknown";
      for (const delivery of data.deliveries) {
        if (delivery.state === "sending") delivery.state = "unknown";
        else if (delivery.key.startsWith("approval:") && ["pending", "failed"].includes(delivery.state)) delivery.state = "cancelled";
        for (const part of delivery.parts ?? []) if (part.state === "sending") part.state = "unknown";
      }
    });
    if (this.store.snapshot().enabled) void this.start(); // Offline IM must not block desktop startup.
  }
  async setEnabled(enabled: boolean) {
    if (typeof enabled !== "boolean") throw new Error("Telegram 开关参数无效");
    if (this.#settings) throw new Error("Telegram 设置正在应用");
    if (!enabled && this.#activeKey) throw new Error("请先停止或等待 Telegram 执行结束，再关闭连接");
    if (enabled && !this.api) throw new Error("请先在常驻助手的可信环境文件中设置 TELEGRAM_BOT_TOKEN，再重启常驻助手。");
    this.#settings = true;
    try {
      await this.store.update(data => { data.enabled = enabled; });
      if (enabled) await this.start(); else await this.#stop();
      return this.status();
    } finally { this.#settings = false; }
  }
  beginPairing() {
    if (this.#settings) throw new Error("Telegram 设置正在应用");
    if (!this.store.snapshot().enabled || this.#connection !== "online") throw new Error("请先接通 Telegram，再生成绑定码");
    if (this.store.snapshot().owner) throw new Error("当前工作区已经绑定账号；不会覆盖原绑定");
    this.#pairing = { code: code(), expiresAt: new Date(this.now() + 5 * 60_000).toISOString(), proposed: null };
    return this.status();
  }
  #herdrReadNotice() {
    return this.host.channelSnapshot().info.capabilities?.tools.includes("herdr_pi_read")
      ? "例外：Herdr 专用 get/read/wait 免逐条确认，每次核对已选择的终端；prompt/input/stop 每次确认且不可记住。" : "";
  }
  async confirmPairing(expectedCode: string) {
    const pairing = this.status().pairing;
    if (!pairing?.proposed || pairing.code !== expectedCode) throw new Error("绑定预览已过期或未收到私聊验证，请重新生成");
    if (this.#settings) throw new Error("Telegram 设置正在应用");
    this.#settings = true;
    try {
      const thread = await this.host.channelCreateThread();
      await this.store.update(data => {
        if (data.owner) throw new Error("已有账号绑定");
        data.owner = { ...pairing.proposed!, threadId: thread.threadId };
      });
      this.#pairing = null;
      const permissions = this.host.channelTelegramAutonomyEnabled()
        ? "授权目录内文件和 Seatbelt 内命令免逐条确认，其他工具仍逐次确认。" : "工具仍逐次确认。";
      await this.#reply(`binding:${thread.threadId}`, pairing.proposed.chatId, `已绑定当前授权目录。直接发消息提问；任务用“任务：目标”。${permissions}${this.#herdrReadNotice()}执行中直接补充会进入本轮调整，成功不另回复。停止：取消并暂停免确认；恢复自主执行：恢复原授权。需要核对未知效果时回桌面处理。`);
      return this.status();
    } finally { this.#settings = false; }
  }
  async start() {
    if (this.#starting) return this.#starting;
    this.#starting = this.#startChannel().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }
  async #startChannel() {
    if (this.#poll || !this.store.snapshot().enabled) return;
    if (!this.api) { this.#connection = "failed"; this.#error = "TELEGRAM_BOT_TOKEN 未配置；未发起网络请求。"; return; }
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#connection = "connecting";
    try {
      const bot = await this.api.identity(signal);
      if (!Number.isSafeInteger(bot?.id) || typeof bot.username !== "string") throw new Error("invalid bot");
      if ((await this.api.webhook(signal)).url) throw new Error("webhook");
      await this.store.update(data => {
        if (data.botId !== null && data.botId !== bot.id) throw new Error("different bot");
        data.botId = bot.id;
      });
      this.#botUsername = bot.username; this.#connection = "online"; this.#error = null;
      // Terminal results can be recovered from receipts, never from earlier unrelated Runs.
      for (const input of this.store.snapshot().inputs.filter(x => x.state === "unknown" && x.runId)) await this.#finish(input);
      await this.#flush();
      await this.#collectSafely();
      for (const input of this.store.snapshot().inputs.filter(x => x.state === "received")) await this.#process(input);
      this.#poll = this.#loop(signal).finally(() => { this.#poll = undefined; });
    } catch (error) {
      this.#connection = signal.aborted ? "disabled" : "failed";
      this.#error = error instanceof TelegramApiError ? error.message : "Telegram 无法连接：请核对机器人、已有 webhook 和保存状态；不会删除 webhook 或替换旧绑定。";
    }
  }
  async #loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.#collectSafely();
        const updates = await this.api!.updates(this.store.snapshot().offset, signal);
        if (!Array.isArray(updates)) throw new Error("invalid updates");
        for (const update of updates) { if (signal.aborted) break; await this.receive(update); }
        if (!signal.aborted) { this.#connection = "online"; this.#error = null; }
      } catch (error) {
        if (signal.aborted) break;
        this.#connection = "failed";
        this.#error = error instanceof TelegramApiError ? error.message : "Telegram 入站消息保存失败，已停止接收；请重启后核对。";
        // Only GET long-poll failures retry. No model, tool or send retries here.
        if (!(error instanceof TelegramApiError) || ["401", "409"].includes(error.code)) break;
        await delay(Math.max(5000, error.retryAfter * 1000), undefined, { signal }).catch(() => undefined);
      }
    }
  }
  async receive(update: TelegramUpdate) {
    const receivedAt = formatLocalTaskTime(new Date(this.now()), MODEL_TIME_ZONE);
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !this.store.snapshot().enabled) return;
    if (update.update_id < this.store.snapshot().offset) return;
    const message = update.message;
    const privateText = message?.chat?.type === "private" && message.from?.is_bot === false &&
      message.forward_origin === undefined && message.via_bot === undefined &&
      Number.isSafeInteger(message.from.id) && message.from.id > 0 && Number.isSafeInteger(message.chat.id) && message.chat.id > 0 &&
      Number.isSafeInteger(message.message_id) && message.message_id > 0 && typeof message.text === "string" && message.text.length <= 16_384;
    const owner = this.store.snapshot().owner;
    const callback = update.callback_query;
    let input: TelegramInbound | undefined;
    if (callback && owner && typeof callback.id === "string" && callback.id.length > 0 && callback.id.length <= 256 &&
        callback.from?.is_bot === false && callback.from.id === owner.userId && callback.message?.chat.type === "private" &&
        callback.message.chat.id === owner.chatId && callback.message.from?.is_bot === true && callback.message.from.id === this.store.snapshot().botId &&
        Number.isSafeInteger(callback.message.message_id) && callback.message.message_id > 0) {
      const key = `callback:${callback.id}`;
      // Unknown payloads stay control messages: they must never become model input.
      const command = /^(allow|deny):([A-F0-9]{10})$/.exec(callback.data ?? "");
      if (!await this.store.hasInput(key)) input = { key, updateId: update.update_id, receivedAt, state: "received", runId: null, taskId: null,
        text: command ? `${command[1] === "allow" ? "允许" : "拒绝"} ${command[2]}` : "允许",
        callback: { id: callback.id, messageId: callback.message.message_id } };
    } else if (!callback && privateText && message) {
      const text = message.text!.trim();
      const pairing = this.status().pairing;
      if (!owner && pairing && text === `/start ${pairing.code}` && !pairing.proposed) {
        this.#pairing!.proposed = { userId: message.from!.id, chatId: message.chat.id, name: String(message.from!.first_name ?? "Telegram 用户").slice(0, 100) };
      } else if (owner && owner.userId === message.from!.id && owner.chatId === message.chat.id && text) {
        const key = `${message.chat.id}:${message.message_id}`;
        if (!await this.store.hasInput(key)) input = { key, updateId: update.update_id, text, receivedAt, state: "received", runId: null, taskId: null };
      }
    }
    // Offset acknowledgement is committed alongside accepted text, before next getUpdates.
    await this.store.update(data => { if (input) data.inputs.push(input); data.offset = Math.max(data.offset, update.update_id + 1); });
    if (input) await this.#process(input);
    if (callback && typeof callback.id === "string" && callback.id.length > 0 && callback.id.length <= 256 && this.api && this.#abort) {
      // Closing the spinner is presentation only; failure must not undo or replay a control.
      try { await this.api.answerCallback(callback.id, this.#abort.signal); }
      catch { this.#error = "手机按钮回执未确认；请查看聊天中的实际处理结果，不要重复创建。"; }
    }
  }
  #ownedRunning() {
    const data = this.store.snapshot(), source = data.inputs.find(x => x.key === this.#activeKey);
    const current = this.host.channelSnapshot();
    return source?.state === "bound" && source.runId && current.info.threadId === data.owner?.threadId && current.snapshot.state.kind === "running" &&
      current.snapshot.state.phase === "primary" && current.snapshot.state.runId === source.runId ? { source, current } : undefined;
  }
  #liveApproval() {
    const permit = this.#approval, owner = this.store.snapshot().owner, running = this.#ownedRunning();
    const pending = running?.current.snapshot.pendingApproval;
    return permit && owner && permit.expires > this.now() && owner.userId === permit.userId && owner.chatId === permit.chatId && owner.threadId === permit.threadId &&
      running?.source.runId === permit.runId && pending?.approvalId === permit.approvalId && approvalHash(pending) === permit.hash ? permit : undefined;
  }
  #liveApprovalDelivery(key: string, chatId: number) {
    const permit = this.#liveApproval();
    return permit && chatId === permit.chatId && key === `approval:${permit.approvalId}:${permit.code}`;
  }
  async #discardStaleApprovals() {
    await this.store.update(data => {
      for (const delivery of data.deliveries) {
        if (delivery.key.startsWith("approval:") && ["pending", "failed"].includes(delivery.state) &&
            !this.#liveApprovalDelivery(delivery.key, delivery.chatId)) delivery.state = "cancelled";
      }
    });
  }
  async #process(input: TelegramInbound) {
    const owner = this.store.snapshot().owner;
    if (!owner) return;
    const text = input.text;
    const reject = async (reason: string) => {
      await this.store.update(data => { data.inputs.find(x => x.key === input.key)!.state = "rejected"; });
      await this.#reply(`input:${input.key}`, owner.chatId, reason);
    };
    if (text === "/confirm" || text === "当前确认") {
      const running = this.#ownedRunning();
      if (!running?.current.snapshot.pendingApproval) return reject("当前没有属于 Telegram 的待确认操作；没有批准任何操作。");
      this.#approval = undefined; // Explicit refresh revokes the previous code.
      const state = await this.#publishApproval(running.source, running.current.snapshot.pendingApproval);
      const notice = state === "submitted" ? "Telegram 已接收新的当前确认；不代表你已阅读。" :
        state === "failed" ? "新确认发送明确失败，未自动重发。请检查连接后再次发送 /confirm。" :
        state === "unknown" ? "新确认发送结果未知，不会盲目重发。请核对手机；需要新的确认时再发送 /confirm。" :
        state === "pending" ? "新确认已保存，等待发送；尚未确认 Telegram 已接收。" : "当前确认已变化或失效，没有批准任何操作。";
      return reject(`${notice}\n旧短码失效，仍需你允许或拒绝同一次操作。`);
    }
    if (text === "/details") {
      const running = this.#ownedRunning();
      return reject(running?.current.snapshot.pendingApproval
        ? telegramBoundedText(running.current.snapshot.pendingApproval.preview || JSON.stringify(running.current.snapshot.pendingApproval.input), 8000)
        : "当前没有属于 Telegram 的待确认操作。");
    }
    const approval = /^(允许|拒绝)[\s:：]*([A-F0-9]{10})$/i.exec(text);
    if (approval) {
      const pending = this.#liveApproval();
      const matches = pending && pending.code === approval[2]!.toUpperCase();
      const envelope = matches ? this.store.snapshot().deliveries.find(x => x.key === `approval:${pending.approvalId}:${pending.code}`) : undefined;
      // A callback must originate from the exact delivered preview, not a copied payload on another message.
      const valid = matches && (!input.callback || envelope?.messageId === input.callback.messageId && envelope.state === "submitted");
      if (valid) this.#approval = undefined; // Consume before dispatch, including competing phone/desktop decisions.
      const accepted = valid && this.host.current.confirm({ approvalId: pending.approvalId, decision: approval[1] === "允许" ? "allow" : "deny" }).accepted;
      return reject(accepted ? "已处理这一次确认，不适用于后续操作。" : "确认已过期、已处理或不属于当前执行；没有批准任何操作。发送 /confirm 获取当前确认的新短码。");
    }
    if (/^(允许|拒绝)(?:[\s:：A-Za-z0-9]|$)/.test(text)) return reject("请点当前确认下的按钮，或完整发送“允许 短码 / 拒绝 短码”；发送 /confirm 可刷新确认。");
    const stopText = text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "").toLowerCase();
    if (["停", "停下", "停止", "stop"].includes(stopText)) {
      const running = this.#ownedRunning();
      this.#pausing = true;
      const cancellation = running ? this.host.current.cancel() : Promise.resolve();
      await Promise.all([this.setAutonomyPaused(true), cancellation]);
      return reject("已暂停这个私聊的免确认，并请求停止当前执行。已经发生的操作不会撤销；实际结果见回执。发送“恢复自主执行”可恢复原有授权。");
    }
    if (text === "恢复自主执行" || text === "/autonomy_resume") {
      if (this.host.channelSnapshot().snapshot.state.kind !== "idle") return reject("请等待当前执行结束后再恢复自主执行。");
      await this.setAutonomyPaused(false);
      return reject((this.host.channelTelegramAutonomyEnabled()
        ? "已恢复这个私聊的原有自主授权：文件和 Seatbelt 内命令免逐条确认，其他操作仍需确认。"
        : "已解除暂停，但当前绑定没有有效自主授权；请在桌面明确授权。工具仍需确认。") + this.#herdrReadNotice());
    }
    if (this.#ownedRunning()?.current.snapshot.pendingApproval && /^(?:可以|好|好的|行|同意|确认|yes|y|ok)[。.!！]?$/i.test(text)) {
      return reject("请点当前确认卡的按钮，或发送“允许 短码 / 拒绝 短码”；本条没有批准或调整任何操作。");
    }
    if (/^调整[:：]/.test(text)) {
      const running = this.#ownedRunning();
      if (!running) return reject("没有可调整的 Telegram 执行；未改动其他对话。");
      return this.#acceptCorrection({ input, source: running.source, text: text.replace(/^调整[:：]/, "").trim() });
    }
    if (text === "/capabilities") {
      const info = this.host.channelSnapshot().info;
      if (info.runtimeRecovery) return reject("助手连接未恢复；缓存配置不能证明当前能力。请先恢复连接，本条未调用模型或执行工具。");
      const status = info.capabilities;
      const enabled = this.host.channelTelegramAutonomyEnabled();
      const channelStatus = status ? { ...status, shell: { ...status.shell, authority: enabled ? "explicit_workspace_telegram_primary; no background inheritance" : "current_run_only",
        warning: enabled ? "当前绑定私聊的文件操作及 Seatbelt 内命令免逐条确认；默认断网、不可用时拒绝执行。本机联网命令及其他工具仍逐条确认。" : status.shell.mode === "docker" ? "沿用配置的挂载与网络限制；工具仍需确认。" : "当前私聊未授权自主执行，文件和本机命令仍需确认。" } } : undefined;
      return reject(channelStatus ? formatCapabilityStatus(channelStatus) + "\n" + this.#herdrReadNotice() : "当前连接未提供能力状态；无法据此判断已注册或可用。");
    }
    if (text === "/start" || text === "/help") return reject("直接提问或说“几分钟后提醒我…”；点确认卡下的按钮即可批准或取消。备用：允许 短码 / 拒绝 短码。/confirm 刷新当前确认，/details 查看详情，/capabilities 查看真实能力状态。执行中直接补充会进入本轮调整，成功不另回复。停止：取消并暂停免确认；恢复自主执行：恢复原授权。工作任务用“任务：目标 → 开始 短码”。");
    if (/^(?:任务[:：]|\/task\s)/.test(text)) {
      const goal = text.replace(/^(?:任务[:：]|\/task\s)/, "").trim();
      if (!goal || goal.length > 8000) return reject("请用 1–8000 字说明任务目标。");
      if (this.#activeKey || this.host.channelSnapshot().snapshot.state.kind !== "idle") return reject("助手正在处理，请结束后再交办；没有排队或启动任务。");
      this.#taskProposal = { goal, code: code(), expires: this.now() + 5 * 60_000 };
      return reject(`任务目标：${goal}\n验收由你确认，不会让模型给自己通过。\n发送“开始 ${this.#taskProposal.code}”创建并执行；${this.host.channelTelegramAutonomyEnabled() ? "文件和 Seatbelt 内命令已授权连续执行，默认断网。发送“停止”会取消执行并暂停免确认；“恢复自主执行”恢复原授权。其他工具仍需批准。" : "工具操作需另行批准，可在桌面 Telegram 设置中开启独立自主执行授权。"}`);
    }
    let task = false, goal = text;
    const begin = /^开始 ([A-F0-9]{10})$/.exec(text);
    if (begin) {
      const proposal = this.#taskProposal;
      this.#taskProposal = undefined;
      if (!proposal || proposal.code !== begin[1] || proposal.expires <= this.now()) return reject("任务预览已过期或已使用，请重新发送任务目标。");
      task = true; goal = proposal.goal;
    } else if (/^(?:开始\s|\/)/.test(text)) return reject("未识别的控制指令，未提交给模型。发送 /help 查看用法。");
    if (this.#activeKey || this.host.channelSnapshot().snapshot.state.kind !== "idle") {
      const running = this.#ownedRunning();
      if (running && !task) return this.#acceptCorrection({ input, source: running.source, text });
      return reject("助手正在启动、收尾或处理其他消息；本条补充未接收、未排队，也未启动新一轮。");
    }
    if (this.store.snapshot().inputs.some(x => x.state === "unknown")) return reject("此前 Telegram 执行效果待核对。请先回桌面检查；不会自动重做旧操作。");
    await this.store.update(data => { data.inputs.find(x => x.key === input.key)!.state = "reserved"; });
    this.#activeKey = input.key;
    try {
      const result = await this.host.channelRun(owner.threadId, goal, task, async (record, taskId) => {
        if (record.threadId !== owner.threadId) throw new Error("Source Thread mismatch");
        await this.store.update(data => {
          const saved = data.inputs.find(x => x.key === input.key)!;
          if (saved.state !== "reserved" || saved.runId !== null) throw new Error("Source already used");
          saved.state = "bound"; saved.runId = record.id; saved.taskId = taskId;
        });
      }, input.receivedAt);
      if (!result.ok) {
        const bound = this.store.snapshot().inputs.find(x => x.key === input.key)!;
        if (bound.runId) await this.#finish(bound);
        else await reject("本条未启动执行；请查看桌面连接或任务错误，不会自动重试。");
        this.#activeKey = undefined;
      }
    } catch {
      const bound = this.store.snapshot().inputs.find(x => x.key === input.key)!;
      if (bound.runId) await this.#finish(bound);
      else await reject("本条启动未成功。未自动重试，请查看桌面连接状态。");
      this.#activeKey = undefined;
    }
  }
  async #acceptCorrection({ input, source, text }: { input: TelegramInbound; source: TelegramInbound; text: string }) {
    const steerId = `tg:${input.key}`;
    await this.store.update(data => {
      const saved = data.inputs.find(item => item.key === input.key)!;
      saved.state = "reserved"; saved.steerId = steerId; saved.runId = source.runId; saved.taskId = source.taskId;
    });
    let state: TelegramInbound["state"] = "unknown", notice: string | undefined;
    try {
      const result = await this.host.current.steer({ id: steerId, expectedRunId: source.runId!, text });
      if (result.ok) {
        state = "finished";
        if (result.steer.status === "not_applied") notice = "本轮未应用这条补充；请查看桌面执行记录。";
      } else {
        state = result.reason === "failed" ? "unknown" : "rejected";
        notice = result.reason === "failed" ? "补充接收结果未知；请查看桌面回执，不会自动重发。"
          : result.reason === "limit" ? "本轮补充次数已到上限，本条未接收。"
          : result.reason === "invalid" ? "补充为空或超过现有长度限制，本条未接收。"
          : "当前执行未接收补充；请稍后重发。";
      }
    } catch { notice = "补充接收结果未知；请查看桌面回执，不会自动重发。"; }
    await this.store.update(data => { data.inputs.find(item => item.key === input.key)!.state = state; });
    if (notice) await this.#reply(`input:${input.key}`, this.store.snapshot().owner!.chatId, notice);
  }
  async #publishApproval(source: TelegramInbound, approval: PendingApproval) {
    const running = this.#ownedRunning(), owner = this.store.snapshot().owner;
    if (!owner || running?.source.runId !== source.runId || running.current.snapshot.pendingApproval?.approvalId !== approval.approvalId) return;
    const current = running.current.snapshot.pendingApproval;
    const hash = approvalHash(current);
    const permit = this.#liveApproval() ??
      { code: code(), runId: source.runId!, threadId: owner.threadId, userId: owner.userId, chatId: owner.chatId,
        approvalId: current.approvalId, hash, expires: this.now() + 5 * 60_000 };
    this.#approval = permit;
    await this.#discardStaleApprovals();
    return this.#reply(`approval:${current.approvalId}:${permit.code}`, permit.chatId,
      telegramApprovalText(current.toolName, (current.preview || JSON.stringify(current.input)).slice(0, 2500), permit.code, current.input, new Date(this.now())),
      { inline_keyboard: [[{ text: ["task_create", "task_repeat_create"].includes(current.toolName) ? "确认保存" : "允许这次", callback_data: `allow:${permit.code}` },
        { text: "取消", callback_data: `deny:${permit.code}` }]] });
  }
  async #finish(source: TelegramInbound, text?: string) {
    const owner = this.store.snapshot().owner;
    if (!source.runId || !owner) return;
    await this.#discardStaleApprovals();
    const run = await this.host.channelReceipt(owner.threadId, source.runId);
    if (source.steerId) {
      const correction = run?.threadId === owner.threadId && run.runId === source.runId && run.phase === "primary" &&
        (!source.taskId || run.workTaskId === source.taskId) ? run.steers?.find(item => item.id === source.steerId) : undefined;
      if (!correction) return;
      await this.store.update(data => { data.inputs.find(item => item.key === source.key)!.state = "finished"; });
      if (correction.status === "not_applied") await this.#reply(`input:${source.key}`, owner.chatId, "本轮未应用这条补充；请查看桌面执行记录。");
      return;
    }
    if (!run || run.threadId !== owner.threadId || run.phase !== "primary" || run.runId !== source.runId || (source.taskId && run.workTaskId !== source.taskId) || run.status === "running") {
      await this.store.update(data => { data.inputs.find(x => x.key === source.key)!.state = "unknown"; });
      if (this.#activeKey === source.key) this.#activeKey = undefined;
      return;
    }
    const uncertain = run.status === "interrupted" || run.tools.some(x => x.status === "unknown");
    const label = uncertain ? "执行中断或效果未知，请回桌面核对；不会自动重做。"
      : run.status === "completed" ? source.taskId ? "结果仍需你在桌面验收。" : ""
      : run.status === "cancelled" ? "本轮已停止；已执行的操作不会撤回，操作结果请查看桌面回执。"
      : "这次执行失败了；操作结果请查看桌面回执。";
    const reminders = this.store.snapshot().inputs.find(x => x.key === source.key)?.reminderReceipts;
    const reply = reminders?.length ? reminders.map(x => run.tools.some(tool => tool.toolCallId === x.toolCallId && tool.status === "not_started")
      ? "这条提醒未保存（操作尚未开始）。" : x.text).join("\n") : text ?? run.resultTextPreview ?? "";
    // Ordinary replies are model prose. Keep safety notices, but trace identity
    // stays in source.runId and the result delivery key, not in the chat bubble.
    const body = telegramBoundedText([label, reply.trim() ? reply : label ? "" : "这次没有可显示的回复，请查看桌面执行记录。",
      !reminders?.length && text === undefined && run.resultTextTruncated ? "[恢复的是回执预览，已截断；完整回复请看桌面]" : ""].filter(Boolean).join("\n"));
    // Recovery still settles the input from its receipt, but an archived
    // submitted/cancelled envelope must not be recreated as a new send.
    const resultKey = `result:${source.key}`, delivered = await this.store.hasDelivery(resultKey);
    await this.store.update(data => {
      data.inputs.find(x => x.key === source.key)!.state = uncertain ? "unknown" : "finished";
      if (!delivered && !data.deliveries.some(x => x.key === resultKey)) data.deliveries.push({ key: resultKey, chatId: owner.chatId, text: body, parts: this.#parts(body, true), state: "pending", messageId: null });
    });
    if (this.#activeKey === source.key) this.#activeKey = undefined;
    await this.#flush();
  }
  async #reply(key: string, chatId: number, text: string, keyboard?: TelegramKeyboard): Promise<TelegramDelivery["state"] | undefined> {
    if (await this.store.hasDelivery(key)) return this.store.snapshot().deliveries.find(x => x.key === key)?.state;
    const body = telegramBoundedText(text);
    await this.store.update(data => { if (!data.deliveries.some(x => x.key === key)) data.deliveries.push({ key, chatId, text: body, parts: this.#parts(body, false), ...(keyboard ? { keyboard } : {}), state: "pending", messageId: null }); });
    await this.#flush();
    return this.store.snapshot().deliveries.find(x => x.key === key)?.state;
  }
  #parts(text: string, markdown: boolean): NonNullable<TelegramDelivery["parts"]> {
    return telegramParts(text, markdown).map(text => ({ text, state: "pending", messageId: null }));
  }
  #sending: Promise<void> | undefined;
  async #flush() {
    if (this.#sending) return this.#sending;
    if (!this.api || !this.#abort || this.#abort.signal.aborted) return;
    this.#sending = (async () => {
      while (true) {
        if (!this.store.snapshot().enabled) break;
        const delivery = this.store.snapshot().deliveries.find(x => x.state === "pending");
        if (!delivery) break;
        if (this.#abort!.signal.aborted) break;
        let claimed = false;
        await this.store.update(data => {
          const saved = data.deliveries.find(x => x.key === delivery.key)!;
          if (!data.enabled || saved.state !== "pending") return;
          if (saved.key.startsWith("approval:") && !this.#liveApprovalDelivery(saved.key, saved.chatId)) { saved.state = "cancelled"; return; }
          if (saved.routeKey && !data.routes.some(x => x.key === saved.routeKey)) { saved.state = "cancelled"; return; }
          saved.state = "sending"; claimed = true;
        });
        if (!claimed) continue;
        // The persisted claim may have awaited a write while desktop/Steer
        // cleared the approval. No request has been sent at this boundary.
        if (delivery.key.startsWith("approval:") && !this.#liveApprovalDelivery(delivery.key, delivery.chatId)) {
          await this.store.update(data => { data.deliveries.find(x => x.key === delivery.key)!.state = "cancelled"; });
          continue;
        }
        try {
          const parts = delivery.parts;
          for (let index = 0; index < (parts?.length ?? 1); index++) {
            if (parts?.[index]!.state === "submitted") continue;
            // Pace additional parts before the authority check/dispatch claim. Never retry a send.
            if (parts && index > 0) {
              try { await delay(1050, undefined, { signal: this.#abort!.signal }); }
              catch { throw new TelegramApiError("CANCELLED_BEFORE_SEND", "not_sent"); }
            }
            // Revalidate revocable authority before every part, not just the first.
            const latest = this.store.snapshot();
            if (!latest.enabled || latest.deliveries.find(x => x.key === delivery.key)?.state === "cancelled" ||
              delivery.routeKey && !latest.routes.some(x => x.key === delivery.routeKey) ||
              delivery.key.startsWith("approval:") && !this.#liveApprovalDelivery(delivery.key, delivery.chatId)) {
              await this.store.update(data => { data.deliveries.find(x => x.key === delivery.key)!.state = "cancelled"; });
              break;
            }
            if (parts) await this.store.update(data => { data.deliveries.find(x => x.key === delivery.key)!.parts![index]!.state = "sending"; });
            const admitted = this.store.snapshot();
            if (!admitted.enabled || delivery.routeKey && !admitted.routes.some(x => x.key === delivery.routeKey) ||
              delivery.key.startsWith("approval:") && !this.#liveApprovalDelivery(delivery.key, delivery.chatId)) {
              await this.store.update(data => {
                const saved = data.deliveries.find(x => x.key === delivery.key)!; saved.state = "cancelled";
                if (saved.parts) saved.parts[index]!.state = "pending"; // No network dispatch occurred.
              });
              break;
            }
            const id = await this.api!.send(delivery.chatId, parts ? parts[index]!.text : delivery.text, this.#abort!.signal, parts ? "HTML" : undefined,
              index === (parts?.length ?? 1) - 1 ? delivery.keyboard : undefined);
            await this.store.update(data => {
              const saved = data.deliveries.find(x => x.key === delivery.key)!;
              if (saved.parts) { saved.parts[index]!.state = "submitted"; saved.parts[index]!.messageId = id; }
              if (index === (parts?.length ?? 1) - 1) saved.state = "submitted";
              saved.messageId = id; delete saved.error; delete saved.retryAt;
            });
          }
        } catch (error) {
          await this.store.update(data => {
            const saved = data.deliveries.find(x => x.key === delivery.key)!;
            saved.state = error instanceof TelegramApiError && error.outcome === "not_sent" ? "failed" : "unknown";
            const part = saved.parts?.find(x => x.state === "sending");
            if (part) part.state = saved.state;
            saved.error = error instanceof TelegramApiError ? error.message.slice(0, 512) : "发送结果未知，不会自动重发";
            if (error instanceof TelegramApiError && error.retryAfter > 0) saved.retryAt = new Date(this.now() + error.retryAfter * 1000).toISOString();
          });
          this.#error = error instanceof TelegramApiError ? error.message : "Telegram 投递结果未知，不会自动重发。";
        }
      }
    })().finally(() => { this.#sending = undefined; });
    return this.#sending;
  }
  async #stop() { this.#abort?.abort(); await this.#starting; await this.#poll; await this.#scanning; await this.#sending; this.#connection = "disabled"; this.#approval = undefined; this.#pairing = null; this.#taskProposal = undefined; }
  async close() { this.#remove(); await this.#stop(); await this.#events; await this.api?.close?.(); }
}
