import { createHash, randomBytes } from "node:crypto";
import type { PendingHerdrSelection, SelectHerdrTargetInput } from "@serika/assistant";
import type { TelegramDelivery } from "./telegram-store.js";

interface SelectionContext {
  runId: string;
  owner: { threadId: string; userId: number; chatId: number };
  selection: PendingHerdrSelection;
}

function fingerprint(context: SelectionContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export class TelegramHerdrSelection {
  #permit: { code: string; selectionId: string; chatId: number; fingerprint: string; expires: number } | undefined;
  constructor(private readonly options: {
    current: () => SelectionContext | undefined;
    now: () => number;
    choose: (input: SelectHerdrTargetInput) => { accepted: boolean };
    send: (key: string, chatId: number, text: string) => Promise<TelegramDelivery["state"] | undefined>;
  }) {}

  clear(selectionId?: string): void {
    if (selectionId === undefined || this.#permit?.selectionId === selectionId) this.#permit = undefined;
  }

  #live() {
    const context = this.options.current(), permit = this.#permit;
    return context && permit && permit.expires > this.options.now() && permit.fingerprint === fingerprint(context)
      ? { context, permit } : undefined;
  }

  deliveryIsLive(key: string, chatId: number): boolean {
    const live = this.#live();
    return !!live && live.permit.chatId === chatId && key === `selection:${live.permit.selectionId}:${live.permit.code}`;
  }

  async publish(expectedSelectionId: string, refresh = false): Promise<TelegramDelivery["state"] | undefined> {
    const context = this.options.current();
    if (!context || context.selection.selectionId !== expectedSelectionId) return;
    if (refresh) this.clear();
    const permit = this.#live()?.permit ?? {
      code: randomBytes(5).toString("hex").toUpperCase(), selectionId: context.selection.selectionId,
      chatId: context.owner.chatId, fingerprint: fingerprint(context), expires: this.options.now() + 5 * 60_000,
    };
    this.#permit = permit;
    const labels = { idle: "空闲", working: "正在执行", blocked: "等待答复", done: "上次执行已结束" };
    const choices = context.selection.candidates.map((candidate, index) =>
      `${index + 1}. ${candidate.title || candidate.target.session} · ${candidate.target.session} · ${labels[candidate.status]}`);
    return this.options.send(`selection:${permit.selectionId}:${permit.code}`, permit.chatId,
      ["选择本轮使用的 Pi：", ...choices, `发送“选择 ${permit.code} 序号”，或“取消选择 ${permit.code}”。`,
        "仅本轮使用。选择后继续当前任务，发送输入仍需另行确认。短码五分钟有效；发送 /confirm 可刷新当前选择。"].join("\n"));
  }

  resolve(text: string): string | undefined {
    const select = /^选择\s+([A-F0-9]{10})\s+([1-9][0-9]*)$/i.exec(text);
    const cancel = /^取消选择\s+([A-F0-9]{10})$/i.exec(text);
    if (!select && !cancel) return /^(?:选择|取消选择)(?:\s|$)/.test(text)
      ? "请完整发送“选择 短码 序号”或“取消选择 短码”。本条没有选择目标或发送输入。" : undefined;
    const live = this.#live(), submittedCode = (select?.[1] ?? cancel?.[1])!.toUpperCase();
    if (!live || live.permit.code !== submittedCode) return "目标选择已过期、已处理或不属于当前执行。没有选择目标或发送输入；发送 /confirm 查看当前选择。";
    const candidate = select ? live.context.selection.candidates[Number(select[2]) - 1] : undefined;
    if (select && !candidate) return "目标序号不在当前候选中。请按当前选择卡重选，本条没有发送输入。";
    this.#permit = undefined;
    const accepted = this.options.choose({ selectionId: live.permit.selectionId, candidateId: candidate?.candidateId ?? null }).accepted;
    return !accepted ? "这次目标选择已失效，没有选择新目标或发送输入。"
      : candidate ? "已提交本轮目标选择。宿主核对后继续，发送输入仍需另行确认。" : "已取消本轮目标选择，没有发送输入。";
  }
}
