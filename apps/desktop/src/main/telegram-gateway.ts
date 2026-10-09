import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopRuntime } from "./desktop-runtime.js";
import { TelegramApiError, type TelegramApi, type TelegramUpdate } from "./telegram-api.js";
import { TelegramStore, type TelegramInbound } from "./telegram-store.js";
import type { PendingApproval } from "../shared/ui-contract.js";
import type { TelegramStatus } from "../shared/telegram.js";
import type { SavedTaskArrangement } from "@aisdk-agent/example-cli/dist/modules/task-module.js";
import type { TaskListInput } from "@aisdk-agent/example-cli/dist/task-store.js";

type Host = Pick<DesktopRuntime, "channelSubscribe" | "channelSnapshot" | "channelCreateThread" | "channelRun" | "channelReceipt" | "channelScheduledTask" | "channelRecurringTask" | "channelScheduledTasks" | "current">;
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
  #approval: { code: string; runId: string; hash: string; approvalId: string; expires: number } | undefined;
  #taskProposal: { code: string; goal: string; expires: number } | undefined;
  #abort: AbortController | undefined;
  #poll: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #events: Promise<void> = Promise.resolve();
  #remove: () => void;
  #activeKey: string | undefined;
  #settings = false;
  constructor(private host: Host, readonly store: TelegramStore, private api: TelegramApi | undefined, private now = Date.now) {
    this.#remove = host.channelSubscribe(message => {
      // Capture association now, before a later Thread switch changes the selected runtime.
      const key = this.#activeKey;
      if (message.type === "approval-cleared" && this.#approval?.approvalId === message.approvalId) this.#approval = undefined;
      if (!key || !this.store.snapshot().enabled) return;
      const source = this.store.snapshot().inputs.find(input => input.key === key);
      if (!source?.runId) return;
      if (message.type === "approval") this.#queue(() => this.#publishApproval(source, message.approval));
      if (message.type === "result" && message.phase === "primary" && message.result.runId === source.runId) {
        this.#approval = undefined;
        this.#queue(() => this.#finish(source, message.result.text));
      }
    });
  }
  #queue(action: () => Promise<void>) {
    this.#events = this.#events.then(action).catch(() => { this.#error = "Telegram 记录或投递未确认；请查看连接状态和桌面回执，不会重做执行。"; });
  }
  status(): TelegramStatus {
    const data = this.store.snapshot();
    return { available: true, tokenConfigured: !!this.api, enabled: data.enabled, connection: this.#connection, botUsername: this.#botUsername,
      owner: data.owner, pairing: this.#pairing && Date.parse(this.#pairing.expiresAt) > this.now() ? structuredClone(this.#pairing) : null,
      lastError: this.#error ?? this.#deliveryError, awaitingReview: data.inputs.filter(x => x.state === "unknown").length,
      failedDeliveries: data.deliveries.filter(x => x.state === "failed").length, unknownDeliveries: data.deliveries.filter(x => x.state === "unknown").length,
      reviews: data.inputs.filter(x => x.state === "unknown").slice(0, 10).map(x => ({ key: x.key, runId: x.runId, taskId: x.taskId })),
      pendingDeliveries: data.deliveries.filter(x => x.state === "pending" || x.state === "sending").length,
      routes: data.routes.map(x => ({ id: x.id, kind: x.kind, fromRunAt: x.fromRunAt })),
      deliveries: data.deliveries.filter(x => /^(scheduled|result):/.test(x.key) && x.state !== "cancelled").reverse()
        .sort((a, b) => Number(a.state === "submitted") - Number(b.state === "submitted")).slice(0, 20).map(x => ({
        key: x.key, state: x.state as "pending" | "sending" | "submitted" | "failed" | "unknown", preview: x.text.slice(0, 160), messageId: x.messageId,
        retryAllowed: x.state === "failed" && (!x.retryAt || Date.parse(x.retryAt) <= this.now()) && data.enabled && this.#connection === "online" && x.chatId === data.owner?.chatId,
        error: x.error ?? null,
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
    });
    await this.#flush(); // No model call, task claim, or execution restart.
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
        const ids: string[] = [];
        if (route.kind === "once") ids.push(route.id);
        else {
          let before: TaskListInput["before"];
          for (let page = 0; ; page++) {
            const listed = await this.host.channelScheduledTasks({ recurringTaskId: route.id, limit: 50, ...(before ? { before } : {}) });
            if (!listed.ok) throw new Error("安排结果暂不可读；未标记为已发送");
            ids.push(...listed.value.tasks.filter(x => Date.parse(x.runAt) >= Date.parse(route.fromRunAt) && ["completed", "failed", "interrupted"].includes(x.status)).map(x => x.id));
            if (!listed.value.truncated) break;
            if (page >= 19 || !listed.value.nextCursor) throw new Error("安排历史超过有界扫描范围；请核对待投递项，未将遗漏结果标成已发送");
            before = listed.value.nextCursor;
          }
        }
        for (const id of ids) {
          const key = `scheduled:${id}`;
          if (this.store.snapshot().deliveries.some(x => x.key === key)) continue;
          const result = await this.host.channelScheduledTask(id);
          if (!result.ok) throw new Error("安排结果暂不可读；未标记为已发送");
          const task = result.value;
          if (!task || task.id !== id || !task.arrangement || !["completed", "failed", "interrupted"].includes(task.status) || !task.finishedAt ||
            (route.kind === "recurring" ? task.recurringTaskId !== route.id || Date.parse(task.runAt) < Date.parse(route.fromRunAt) : task.recurringTaskId !== null)) continue;
          // Under the configured --notify worker, null is the persisted empty RSS outcome.
          if (task.arrangement.kind === "rss-digest" && task.status === "completed" && task.notification === null) continue;
          const label = task.status === "completed" ? "安排已完成" : task.status === "interrupted" ? "安排中断，未自动重做；请回桌面核对" : "安排执行失败";
          const text = `${label}\n${task.resultText ?? task.error?.message ?? "没有结果正文"}\n任务: ${task.id}`.slice(0, 32_000);
          await this.store.update(data => {
            if (!data.enabled || !data.routes.some(x => x.key === route.key && x.fromRunAt === route.fromRunAt) || data.owner?.chatId !== route.chatId || data.owner.userId !== route.userId || data.deliveries.some(x => x.key === key)) return;
            data.deliveries.push({ key, routeKey: route.key, chatId: route.chatId, text, state: "pending", messageId: null });
          });
        }
      }
      await this.#flush();
    })().finally(() => { this.#scanning = undefined; });
    return this.#scanning;
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
      for (const delivery of data.deliveries) if (delivery.state === "sending") delivery.state = "unknown";
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
      await this.#reply(`binding:${thread.threadId}`, pairing.proposed.chatId, "已绑定当前工作区。直接发消息提问；任务用“任务：目标”，工具仍逐次确认。调整：新方向；停止。需要核对未知效果时回桌面处理。");
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
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !this.store.snapshot().enabled) return;
    if (update.update_id < this.store.snapshot().offset) return;
    const message = update.message;
    const privateText = message?.chat?.type === "private" && message.from?.is_bot === false &&
      message.forward_origin === undefined && message.via_bot === undefined &&
      Number.isSafeInteger(message.from.id) && message.from.id > 0 && Number.isSafeInteger(message.chat.id) && message.chat.id > 0 &&
      Number.isSafeInteger(message.message_id) && message.message_id > 0 && typeof message.text === "string" && message.text.length <= 16_384;
    const owner = this.store.snapshot().owner;
    let input: TelegramInbound | undefined;
    if (privateText && message) {
      const text = message.text!.trim();
      const pairing = this.status().pairing;
      if (!owner && pairing && text === `/start ${pairing.code}` && !pairing.proposed) {
        this.#pairing!.proposed = { userId: message.from!.id, chatId: message.chat.id, name: String(message.from!.first_name ?? "Telegram 用户").slice(0, 100) };
      } else if (owner && owner.userId === message.from!.id && owner.chatId === message.chat.id && text) {
        const key = `${message.chat.id}:${message.message_id}`;
        if (!this.store.snapshot().inputs.some(x => x.key === key)) input = { key, updateId: update.update_id, text, state: "received", runId: null, taskId: null };
      }
    }
    // Offset acknowledgement is committed alongside accepted text, before next getUpdates.
    await this.store.update(data => { if (input) data.inputs.push(input); data.offset = Math.max(data.offset, update.update_id + 1); });
    if (input) await this.#process(input);
  }
  #ownedRunning() {
    const data = this.store.snapshot(), source = data.inputs.find(x => x.key === this.#activeKey);
    const current = this.host.channelSnapshot();
    return source?.runId && current.info.threadId === data.owner?.threadId && current.snapshot.state.kind === "running" &&
      current.snapshot.state.phase === "primary" && current.snapshot.state.runId === source.runId ? { source, current } : undefined;
  }
  async #process(input: TelegramInbound) {
    const owner = this.store.snapshot().owner;
    if (!owner) return;
    const text = input.text;
    const reject = async (reason: string) => {
      await this.store.update(data => { data.inputs.find(x => x.key === input.key)!.state = "rejected"; });
      await this.#reply(`input:${input.key}`, owner.chatId, reason);
    };
    const approval = /^(允许|拒绝) ([A-F0-9]{10})$/.exec(text);
    if (approval) {
      const pending = this.#approval, running = this.#ownedRunning(), snapshot = running?.current.snapshot;
      if (pending?.code === approval[2]) this.#approval = undefined; // Consume the matching capability before dispatch.
      const valid = pending && pending.code === approval[2] && pending.expires > this.now() && running?.source.runId === pending.runId &&
        snapshot?.pendingApproval?.approvalId === pending.approvalId && approvalHash(snapshot.pendingApproval) === pending.hash;
      const accepted = valid && this.host.current.confirm({ approvalId: pending.approvalId, decision: approval[1] === "允许" ? "allow" : "deny" }).accepted;
      return reject(accepted ? "已处理这一次确认，不适用于后续操作。" : "确认已过期、已处理或不属于当前执行；没有批准任何操作。请查看当前确认。");
    }
    if (/^(允许|拒绝)(?:\s|$)/.test(text)) return reject("请完整复制当前确认中的短码；普通“可以”不会授权工具。");
    if (text === "停止") {
      if (!this.#ownedRunning()) return reject("没有属于 Telegram 的当前执行；未停止其他对话。");
      await this.host.current.cancel();
      return reject("已请求停止。已经发生的操作不会撤销；实际结果见回执。");
    }
    if (/^调整[:：]/.test(text)) {
      const running = this.#ownedRunning();
      if (!running) return reject("没有可调整的 Telegram 执行；未改动其他对话。");
      const result = await this.host.current.steer({ id: randomUUID(), expectedRunId: running.source.runId!, text: text.replace(/^调整[:：]/, "").trim() });
      return reject(result.ok ? "调整已收到，会在安全边界应用；不是新增授权。" : "当前调整未接收，请在桌面查看执行状态。");
    }
    if (text === "/start" || text === "/help") return reject("直接提问；任务：目标 → 开始 短码。工具确认用“允许 短码 / 拒绝 短码”。调整：新方向；停止。未知效果回桌面核对。");
    if (/^(?:任务[:：]|\/task\s)/.test(text)) {
      const goal = text.replace(/^(?:任务[:：]|\/task\s)/, "").trim();
      if (!goal || goal.length > 8000) return reject("请用 1–8000 字说明任务目标。");
      if (this.#activeKey || this.host.channelSnapshot().snapshot.state.kind !== "idle") return reject("助手正在处理，请结束后再交办；没有排队或启动任务。");
      this.#taskProposal = { goal, code: code(), expires: this.now() + 5 * 60_000 };
      return reject(`任务目标：${goal}\n验收由你确认，不会让模型给自己通过。\n发送“开始 ${this.#taskProposal.code}”创建并执行；每次工具操作仍需另行批准。`);
    }
    let task = false, goal = text;
    const begin = /^开始 ([A-F0-9]{10})$/.exec(text);
    if (begin) {
      const proposal = this.#taskProposal;
      this.#taskProposal = undefined;
      if (!proposal || proposal.code !== begin[1] || proposal.expires <= this.now()) return reject("任务预览已过期或已使用，请重新发送任务目标。");
      task = true; goal = proposal.goal;
    } else if (/^(?:开始\s|\/)/.test(text)) return reject("未识别的控制指令，未提交给模型。发送 /help 查看用法。");
    if (this.#activeKey || this.host.channelSnapshot().snapshot.state.kind !== "idle") return reject("助手正在处理其他消息，请稍后再发；本条未排队、未调用模型。");
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
      });
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
  async #publishApproval(source: TelegramInbound, approval: PendingApproval) {
    const running = this.#ownedRunning();
    if (running?.source.runId !== source.runId || running.current.snapshot.pendingApproval?.approvalId !== approval.approvalId) return;
    const current = running.current.snapshot.pendingApproval;
    const hash = approvalHash(current);
    const permit = this.#approval?.approvalId === current.approvalId && this.#approval.hash === hash ? this.#approval :
      { code: code(), runId: source.runId!, approvalId: current.approvalId, hash, expires: this.now() + 5 * 60_000 };
    this.#approval = permit;
    await this.#reply(`approval:${approval.approvalId}`, this.store.snapshot().owner!.chatId,
      `请求使用 ${current.toolName}\n${(current.preview || JSON.stringify(current.input)).slice(0, 2500)}${["task_create", "task_repeat_create"].includes(current.toolName) ? "\n这个安排的结果将发送到本绑定私聊；保存、启用后台服务和投递是不同状态。" : ""}\n仅本次：允许 ${permit.code}\n或：拒绝 ${permit.code}\n五分钟有效；普通回复不代表授权。`);
  }
  async #finish(source: TelegramInbound, text?: string) {
    const owner = this.store.snapshot().owner;
    if (!source.runId || !owner) return;
    const run = await this.host.channelReceipt(owner.threadId, source.runId);
    if (!run || run.threadId !== owner.threadId || run.phase !== "primary" || run.runId !== source.runId || (source.taskId && run.workTaskId !== source.taskId) || run.status === "running") {
      await this.store.update(data => { data.inputs.find(x => x.key === source.key)!.state = "unknown"; });
      if (this.#activeKey === source.key) this.#activeKey = undefined;
      return;
    }
    const uncertain = run.status === "interrupted" || run.tools.some(x => x.status === "unknown");
    const label = uncertain ? "执行中断或效果未知，请回桌面核对；不会自动重做。" : run.status === "completed" ? source.taskId ? "任务这一轮已结束，结果仍需你在桌面验收。" : "本轮已结束。" : `本轮${run.status}；操作结果见桌面回执。`;
    const body = `${label}\n${(text ?? run.resultTextPreview ?? "").slice(0, 24_000)}${text === undefined && run.resultTextTruncated ? "\n[恢复的是回执预览，已截断；完整回复请看桌面]" : ""}\nRun: ${run.runId}`;
    await this.store.update(data => {
      data.inputs.find(x => x.key === source.key)!.state = uncertain ? "unknown" : "finished";
      if (!data.deliveries.some(x => x.key === `result:${source.key}`)) data.deliveries.push({ key: `result:${source.key}`, chatId: owner.chatId, text: body, state: "pending", messageId: null });
    });
    if (this.#activeKey === source.key) this.#activeKey = undefined;
    await this.#flush();
  }
  async #reply(key: string, chatId: number, text: string) {
    await this.store.update(data => { if (!data.deliveries.some(x => x.key === key)) data.deliveries.push({ key, chatId, text: text.slice(0, 32_000), state: "pending", messageId: null }); });
    await this.#flush();
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
          if (saved.routeKey && !data.routes.some(x => x.key === saved.routeKey)) { saved.state = "cancelled"; return; }
          saved.state = "sending"; claimed = true;
        });
        if (!claimed) continue;
        try {
          const id = await this.api!.send(delivery.chatId, delivery.text, this.#abort!.signal);
          await this.store.update(data => { const saved = data.deliveries.find(x => x.key === delivery.key)!; saved.state = "submitted"; saved.messageId = id; delete saved.error; delete saved.retryAt; });
        } catch (error) {
          await this.store.update(data => {
            const saved = data.deliveries.find(x => x.key === delivery.key)!;
            saved.state = error instanceof TelegramApiError && error.outcome === "not_sent" ? "failed" : "unknown";
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
