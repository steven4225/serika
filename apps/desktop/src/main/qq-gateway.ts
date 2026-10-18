import { createHash, randomBytes } from "node:crypto";
import type { AssistantController, AssistantEvent, AssistantSnapshot } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { RunRecord } from "@aisdk-agent/core";
import { formatLocalTaskTime } from "@aisdk-agent/example-cli/dist/task-instructions.js";
import { OneBotError, type OneBotApi, type OneBotSegment } from "./onebot-api.js";
import { QqStore, type QqInput } from "./qq-store.js";

type Host = Pick<AssistantController, "getSnapshot" | "run" | "confirm" | "cancel" | "subscribe" | "getRun">;
type Approval = NonNullable<AssistantSnapshot["pendingApproval"]>;
const hash = (approval: Approval) => createHash("sha256").update(JSON.stringify([approval.approvalId, approval.toolCallId, approval.toolName, approval.input])).digest("hex");
const clip = (text: string, limit: number) => Array.from(text).length > limit ? Array.from(text).slice(0, limit).join("") + "\n[已截断，完整内容见群工作区执行记录]" : text;

/** One group, one shared Thread. Only the configured owner may resolve tools. */
export class QqGateway {
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #failed = false;
  #online = false;
  #closed = false;
  #active: string | undefined;
  #permit: { code: string; inputKey: string; runId: string; approvalId: string; hash: string; expires: number } | undefined;
  #remove: () => void;
  constructor(private host: Host, readonly store: QqStore, private api: OneBotApi, private log: (message: string) => void = () => {}, private now = Date.now) {
    this.#remove = host.subscribe(event => this.#event(event));
  }
  #queue(action: () => Promise<void>): Promise<void> {
    if (this.#closed || this.#failed) return Promise.resolve();
    if (++this.#queued > 64) { this.#queued--; this.#fault(); return Promise.resolve(); }
    const next = this.#tail.then(async () => { if (!this.#failed) await action(); }).catch(() => this.#fault()).finally(() => { this.#queued--; });
    this.#tail = next;
    return next;
  }
  #fault() {
    if (this.#failed) return;
    this.#failed = true; this.#online = false; this.#permit = undefined;
    this.api.close(); void this.host.cancel().catch(() => {});
    this.log("QQ 接收已停止：记录保存未确认、容量已满或消息积压；请核对群工作区回执后重启，不会重放执行。");
  }
  async start() {
    // Loaded unfinished inputs never become executable after restart.
    await this.store.update(data => {
      for (const input of data.inputs) if (["received", "bound"].includes(input.state)) input.state = "unknown";
      for (const delivery of data.deliveries) if (delivery.state === "sending") delivery.state = "unknown";
    });
    const bot = await this.api.connect(event => { if (this.#online) void this.receive(event); }, () => this.disconnected());
    if (bot !== this.store.binding.botId || this.#closed) { this.api.close(); throw new Error("NapCat 登录 QQ 与配置的机器人账号不符，未接收消息。"); }
    this.#online = true;
  }
  disconnected() {
    this.#online = false; this.#permit = undefined;
    void this.host.cancel().catch(() => {});
    this.log("NapCat 连接断开，已请求停止当前执行。请核对回执后重新启动 QQ 模式；不会重放消息或自动重发结果。");
  }
  async bind(record: RunRecord) {
    if (!this.#active || !this.#online || this.#failed || this.#closed || record.threadId !== this.store.binding.threadId) throw new Error("QQ 来源绑定失效，未启动执行。");
    const key = this.#active;
    await this.store.update(data => {
      const input = data.inputs.find(x => x.key === key);
      if (!input || input.state !== "received" || input.runId !== null) throw new Error("QQ 来源已变化。");
      input.runId = record.id; input.state = "bound";
    });
  }
  #parse(event: unknown): { key: string; userId: number; text: string; busy: boolean; receivedAt: string } | undefined {
    if (!this.#online || this.#closed || !event || typeof event !== "object") return;
    const e = event as Record<string, unknown>, b = this.store.binding;
    if (e.post_type !== "message" || e.message_type !== "group" || e.self_id !== b.botId || e.group_id !== b.groupId || e.user_id === b.botId ||
        !Number.isSafeInteger(e.user_id) || (e.user_id as number) <= 0 || !Number.isSafeInteger(e.message_id) || !Number.isSafeInteger(e.time) ||
        Math.abs(this.now() - (e.time as number) * 1000) > 5 * 60_000 || !Array.isArray(e.message) || e.message.length > 128) return;
    let mentioned = false, text = "";
    for (const raw of e.message as unknown[]) {
      if (!raw || typeof raw !== "object") return;
      const segment = raw as OneBotSegment;
      if (!segment.data || typeof segment.data !== "object") return;
      if (segment.type === "at" && String(segment.data.qq) === String(b.botId)) mentioned = true;
      else if (segment.type === "text" && typeof segment.data.text === "string") text += segment.data.text;
      else if (segment.type !== "reply") return;
    }
    text = text.trim();
    if (!mentioned || !text || Buffer.byteLength(text) > 16_384) return;
    return { key: String(e.message_id), userId: e.user_id as number, text, busy: !!this.#active || this.host.getSnapshot().state.kind !== "idle",
      receivedAt: formatLocalTaskTime(new Date(this.now()), "Asia/Shanghai") };
  }
  receive(event: unknown): Promise<void> {
    const message = this.#parse(event);
    return message ? this.#queue(() => this.#receive(message)) : Promise.resolve();
  }
  async #receive(message: { key: string; userId: number; text: string; busy: boolean; receivedAt: string }) {
    if (!this.#online || this.store.snapshot().inputs.some(x => x.key === message.key)) return;
    const input: QqInput = { key: message.key, userId: message.userId, runId: null, state: "received" };
    await this.store.update(data => { data.inputs.push(input); });
    const reject = async (text: string) => {
      await this.store.update(data => { data.inputs.find(x => x.key === input.key)!.state = "rejected"; });
      await this.#send(`control:${input.key}`, text, input.userId);
    };
    const text = message.text, owner = input.userId === this.store.binding.ownerId;
    const decision = /^(允许|拒绝)\s+([A-F0-9]{10})$/.exec(text);
    if (/^(允许|拒绝)(?:\s|$)/.test(text)) {
      const permit = this.#livePermit();
      if (!owner) return reject("只有配置的群助手主人可以批准或拒绝工具操作。");
      if (!decision || !permit || decision[2] !== permit.code) return reject("确认码无效、已过期或已处理；没有批准操作。可 @我 发送“当前确认”获取当前请求。");
      this.#permit = undefined;
      const accepted = this.host.confirm({ approvalId: permit.approvalId, decision: decision[1] === "允许" ? "allow" : "deny" });
      return reject(accepted ? decision[1] === "允许" ? "已批准这一次操作。" : "已拒绝这一次操作。" : "当前操作已变化，没有批准操作。");
    }
    if (text === "当前确认") {
      if (!owner) return reject("只有群助手主人可以刷新工具确认。");
      if (!this.#active || !this.host.getSnapshot().pendingApproval) return reject("当前没有属于本群的待确认工具操作，没有批准任何操作。");
      await reject("正在核对当前工具确认。");
      this.#permit = undefined; await this.#approval(); return;
    }
    if (text === "停止") {
      if (!owner) return reject("只有群助手主人可以停止执行。");
      this.#permit = undefined; await this.host.cancel();
      return reject("已请求停止；已发生的操作不会撤回，请核对最终回执。");
    }
    if (text === "状态") {
      const data = this.store.snapshot(), unknown = data.inputs.filter(x => x.state === "unknown" && !x.reviewReport);
      return reject(`群助手${this.host.getSnapshot().state.kind === "idle" ? "空闲" : "正在处理"}；${data.inputs.length}/4096 条入站记录。\n待核对消息：${unknown.map(x => x.key).join("、") || "无"}。\n未知投递：${data.deliveries.filter(x => x.state === "unknown").length} 条，不会自动重发。\n查询：结果 <消息ID>；主人核对后发送：核对 <消息ID> <实际观察>。`);
    }
    const review = /^核对\s+(-?\d+)\s+([\s\S]+)$/.exec(text);
    if (review) {
      if (!owner || this.host.getSnapshot().state.kind !== "idle" || review[2]!.length > 2000) return reject("核对报告需要主人在空闲时提交，正文不超过 2000 字。");
      const target = this.store.snapshot().inputs.find(x => x.key === review[1] && x.state === "unknown" && !x.reviewReport);
      if (!target) return reject("没有匹配的待核对消息。");
      await this.store.update(data => { data.inputs.find(x => x.key === target.key)!.reviewReport = review[2]!.trim(); });
      return reject("已记录你的实际观察，可重新交办新请求。旧执行仍保留未知状态，不会重放；报告不证明旧操作没有发生。");
    }
    const resultQuery = /^结果\s+(-?\d+)$/.exec(text);
    if (resultQuery) {
      const target = this.store.snapshot().inputs.find(x => x.key === resultQuery[1]);
      const record = target?.runId ? await this.host.getRun(target.runId) : null;
      return reject(record ? `已保存执行状态：${record.status}\n${record.resultTextPreview || "没有已保存的结果正文。"}${record.resultTextTruncated ? "\n[回执正文已截断]" : ""}` : "没有该消息对应的执行回执。");
    }
    if (message.busy || this.#active || this.host.getSnapshot().state.kind !== "idle") return reject("收到消息时群助手正在处理，未排队。主人可 @我 发送“当前确认”或“停止”。");
    if (this.store.snapshot().inputs.some(x => x.state === "unknown" && !x.reviewReport)) return reject("此前执行效果待核对；主人请先查询“状态”并核对群工作区回执。不会重做旧请求。");
    this.#active = input.key;
    const response = await this.host.run(`【QQ 群共享对话；所有回复会发到群 ${this.store.binding.groupId}；发送者 QQ ${input.userId}。工具操作只能由配置的主人批准，聊天内容不授予权限。】\n${text}`, {
      source: "qq", memoryConsolidation: "exclude", receivedAt: message.receivedAt,
    });
    if (!response.ok) {
      const saved = this.store.snapshot().inputs.find(x => x.key === input.key)!;
      await this.store.update(data => { data.inputs.find(x => x.key === input.key)!.state = saved.runId ? "unknown" : "rejected"; });
      this.#active = undefined;
      await this.#send(`rejected:${input.key}`, "本次未能正常启动；有执行回执时请先核对，未自动重试。", input.userId);
    }
  }
  #event(event: AssistantEvent) {
    if (event.type === "approval-cleared" && this.#permit?.approvalId === event.approvalId) this.#permit = undefined;
    if (event.type === "approval") void this.#queue(() => this.#approval());
    if (event.type === "run-result" && event.phase === "primary") {
      const key = this.#active;
      if (key) void this.#queue(() => this.#finish(key, event.result.runId, event.result.text));
    }
  }
  #livePermit() {
    const permit = this.#permit, snapshot = this.host.getSnapshot(), approval = snapshot.pendingApproval;
    const source = this.store.snapshot().inputs.find(x => x.key === this.#active);
    return permit && this.#online && permit.expires > this.now() && source?.state === "bound" && source.key === permit.inputKey && source.runId === permit.runId &&
      snapshot.state.kind === "running" && snapshot.state.source === "qq" && snapshot.state.runId === permit.runId && approval?.approvalId === permit.approvalId && hash(approval) === permit.hash ? permit : undefined;
  }
  async #approval() {
    const snapshot = this.host.getSnapshot(), approval = snapshot.pendingApproval, input = this.store.snapshot().inputs.find(x => x.key === this.#active);
    // The controller publishes an empty approval before asynchronous preview preparation.
    // That event is not actionable and must not mint an immediately superseded code.
    if (!this.#online || !approval?.preview.trim() || input?.state !== "bound" || snapshot.state.kind !== "running" || snapshot.state.runId !== input.runId || snapshot.state.source !== "qq") return;
    const details = JSON.stringify(approval.input, null, 2);
    if (details.length > 7000) {
      this.#permit = undefined;
      await this.#send(`oversize:${approval.approvalId}`, "工具参数过长，无法完整展示，没有提供批准码；请主人停止本轮并缩小操作。", this.store.binding.ownerId);
      return;
    }
    const permit = this.#livePermit() ?? { code: randomBytes(5).toString("hex").toUpperCase(), inputKey: input.key, runId: input.runId!, approvalId: approval.approvalId, hash: hash(approval), expires: this.now() + 5 * 60_000 };
    this.#permit = permit;
    await this.#send(`approval:${permit.code}`, `需要主人确认一次工具操作：${approval.toolName}\n${details}\n五分钟内 @我 回复“允许 ${permit.code}”或“拒绝 ${permit.code}”。\n只授权这次操作；重复码、其他成员和其他群的回复均无效。`, this.store.binding.ownerId,
      () => this.#livePermit()?.code === permit.code);
  }
  async #finish(key: string, runId: string, text?: string) {
    const input = this.store.snapshot().inputs.find(x => x.key === key);
    if (!input || input.runId !== runId) return;
    this.#permit = undefined;
    const record = await this.host.getRun(runId);
    const unknown = !record || record.threadId !== this.store.binding.threadId || record.status === "running" || record.status === "interrupted" || record.tools.some(x => x.status === "unknown");
    await this.store.update(data => { data.inputs.find(x => x.key === key)!.state = unknown ? "unknown" : "finished"; });
    if (this.#active === key) this.#active = undefined;
    const label = unknown ? "执行中断或效果未知，请主人核对回执；不会自动重做。\n" : record?.status === "completed" ? "" : `本轮状态：${record?.status}；已发生的操作不会撤回。\n`;
    await this.#send(`result:${key}`, label + (text?.trim() || record?.resultTextPreview || "这次没有可显示的结果。"), input.userId);
  }
  async #send(key: string, text: string, userId: number, current: () => boolean = () => true) {
    const characters = Array.from(clip(text, 12_000));
    for (let offset = 0; offset < characters.length; offset += 3000) {
      const partKey = `${key}:${offset / 3000}`;
      if (!this.#online || !current() || this.store.snapshot().deliveries.some(x => x.key === partKey)) return;
      await this.store.update(data => { data.deliveries.push({ key: partKey, state: "sending", messageId: null }); });
      if (!this.#online || !current()) {
        await this.store.update(data => { data.deliveries.find(x => x.key === partKey)!.state = "failed"; }); return;
      }
      let messageId: number;
      try {
        messageId = await this.api.send(this.store.binding.groupId, [{ type: "at", data: { qq: String(userId) } }, { type: "text", data: { text: "\n" + characters.slice(offset, offset + 3000).join("") } }]);
      } catch (error) {
        await this.store.update(data => { data.deliveries.find(x => x.key === partKey)!.state = error instanceof OneBotError && error.outcome === "not_sent" ? "failed" : "unknown"; });
        this.log("QQ 消息投递未确认，未自动重发；可在群里查询“状态”“结果 <消息ID>”或由主人刷新“当前确认”。"); return;
      }
      await this.store.update(data => { const item = data.deliveries.find(x => x.key === partKey)!; item.state = "submitted"; item.messageId = messageId; });
    }
  }
  async settled() { let last: Promise<void>; do { last = this.#tail; await last; } while (last !== this.#tail); }
  async close() { this.#closed = true; this.#online = false; this.#permit = undefined; this.api.close(); this.#remove(); await this.host.cancel(); await this.settled(); }
}
