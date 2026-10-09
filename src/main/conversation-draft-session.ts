import type { AppInfo } from "../shared/ui-contract.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { draftScope, sameDraftScope, type ConversationDraftScope, type ConversationDraft, type DesktopSteerInput, type DesktopSteerResponse } from "../shared/conversation-drafts.js";
import type { TaskDraftUpdate } from "../shared/conversation-drafts.js";

/** Persist UI intent before dispatch. Neither loading nor acknowledging it replays a tool/Run. */
export class ConversationDraftSession {
  constructor(private host: { info(): AppInfo; current: Pick<RuntimeBridge, "snapshot" | "steer" | "getRun"> }, private store: ConversationDraftStore) {}

  #scope(expected: ConversationDraftScope) {
    const scope = draftScope(this.host.info());
    if (!expected || !sameDraftScope(scope, expected)) throw new Error("会话已切换，旧草稿没有写入当前对话");
    return scope;
  }

  load(expected: ConversationDraftScope) { return this.store.load(this.#scope(expected)); }
  save(expected: ConversationDraftScope, draft: ConversationDraft) { return this.store.saveDraft(this.#scope(expected), draft); }
  saveTask(expected: ConversationDraftScope, update: TaskDraftUpdate) { return this.store.saveTaskDraft(this.#scope(expected), update); }
  flush() { return this.store.flush(); }

  async steer(input: DesktopSteerInput): Promise<DesktopSteerResponse> {
    const scope = this.#scope(input?.scope);
    let pending;
    try { pending = (await this.store.load(scope)).uncertainSteer; }
    catch { return { ok: false, reason: "storage" }; }
    if (pending) return { ok: false, reason: "unresolved" };
    try {
      await this.store.saveUncertainSteer(scope, { id: input.id, runId: input.expectedRunId, text: input.text, ...(input.taskId ? { taskId: input.taskId } : {}) });
    } catch { return { ok: false, reason: "storage" }; }
    // Selection may have changed while persistence was pending. Do not route it to the new controller.
    if (!sameDraftScope(scope, this.host.info())) {
      await this.store.clearUncertainSteer(scope, input.id);
      throw new Error("会话已切换，补充未发送");
    }
    const result = await this.host.current.steer(input);
    // A definitive rejection was not dispatched. 'failed'/IPC rejection is uncertain and stays locked.
    if (!result.ok && result.reason !== "failed") await this.store.clearUncertainSteer(scope, input.id);
    return result;
  }

  async acknowledge(expected: ConversationDraftScope, id: string) {
    const scope = this.#scope(expected);
    const pending = (await this.store.load(scope)).uncertainSteer;
    if (!pending || pending.id !== id) return null;
    const result = await this.host.current.getRun(pending.runId);
    this.#scope(expected);
    if (!result.ok) throw new Error("接收凭证暂不可用，草稿保持锁定");
    const run = result.run;
    if (!run || run.runId !== pending.runId || run.threadId !== scope.threadId || run.phase !== "primary") return null;
    const receipt = run.steers?.find(record => record.id === id && record.runId === pending.runId && record.text === pending.text);
    if (!receipt) return null;
    await this.store.acknowledgeSteer(scope, id, { clearMatchingDraft: receipt.status !== "not_applied" });
    return receipt;
  }

  async release(expected: ConversationDraftScope, id: string) {
    const scope = this.#scope(expected);
    if (this.host.current.snapshot().state.kind !== "idle") throw new Error("本轮还在运行，请先核对接收状态");
    const state = await this.store.load(scope);
    if (!state.uncertainSteer) return true;
    if (state.uncertainSteer?.id !== id) return false;
    if (state.uncertainSteer.taskId) {
      const pending = state.uncertainSteer;
      const existing = state.taskDrafts?.instructions[pending.taskId!];
      if (existing?.trim() && existing.trim() !== pending.text.trim()) throw new Error("原任务另有新草稿，请先保存两份内容；本次没有清除任何内容。");
      if (!existing) await this.store.saveTaskDraft(scope, { kind: "instruction", taskId: pending.taskId!, text: pending.text });
      await this.store.saveTaskDraft(scope, { kind: "composer", taskId: pending.taskId! });
      return this.store.clearUncertainSteer(scope, id);
    }
    if (state.draft.text.trim() && state.draft.text.trim() !== state.uncertainSteer.text.trim()) {
      throw new Error("输入框另有一份草稿。请先复制保存它，再把待核对补充移回输入框；本次没有清除任何内容。");
    }
    // Explicitly preserve the text for a later manual action, never start another Run here.
    if (!state.draft.text) await this.store.saveDraft(scope, { text: state.uncertainSteer.text, excludeFromMemory: false });
    return this.store.clearUncertainSteer(scope, id);
  }
}
