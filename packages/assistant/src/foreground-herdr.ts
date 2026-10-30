import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { AgentError, hashCanonicalJson, type BeforeToolExecute, type BeforeToolExecuteInput, type ToolExecutionDecision } from "@serika/core";
import { HerdrClient, herdrControlSchema, herdrReadSchema, type HerdrAction, type HerdrCandidate, type HerdrDiscovery, type HerdrTarget } from "./herdr.js";

export interface HerdrSelectionCandidate extends HerdrCandidate { candidateId: string }
export interface PendingHerdrSelection {
  selectionId: string;
  toolCallId: string;
  candidates: HerdrSelectionCandidate[];
}
export interface SelectHerdrTargetInput { selectionId: string; candidateId: string | null }
type Failure = { ok: false; error: { code: string; message: string } };
const failure = (code: string, message: string): Failure => ({ ok: false, error: { code, message } });
type FrozenCall = { kind: "ready"; target: HerdrTarget; action: HerdrAction; selectionVersion: number; inputHash: string }
  | { kind: "failed"; result: Failure };
type RunTarget = {
  request: string;
  requestId: string | undefined;
  discovery?: HerdrDiscovery;
  candidates: HerdrSelectionCandidate[];
  adopted?: HerdrSelectionCandidate;
  version: number;
  calls: Map<string, FrozenCall>;
  halted: boolean;
  requested?: Partial<Pick<HerdrTarget, "session" | "paneId" | "terminalId">>;
  steers: Set<string>;
  needsSelection: boolean;
};
type SelectionWait = { selection: PendingHerdrSelection; settle(candidateId: string | null): void; abort(): void };

export class ForegroundHerdrTargets {
  readonly #client: HerdrClient;
  #run: RunTarget | undefined;
  #pending: SelectionWait | undefined;
  readonly #listeners = new Set<(selection: PendingHerdrSelection | undefined) => void>();
  constructor(private readonly options: { directory: string; env: NodeJS.ProcessEnv; configuredTarget?: HerdrTarget | undefined }) {
    this.#client = new HerdrClient({ cwd: options.directory, authorizedDirectory: options.directory, env: options.env });
  }
  begin(request?: UIMessage): void {
    this.end();
    this.#run = { requestId: request?.id, request: request?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "",
      candidates: [], version: 0, calls: new Map(), halted: false, steers: new Set(), needsSelection: false };
  }
  observeSteers(messages: readonly UIMessage[]): void {
    const run = this.#run;
    if (!run) return;
    const start = messages.findIndex(message => message.id === run.requestId && message.role === "user");
    if (start < 0) return;
    for (const message of messages.slice(start + 1)) {
      if (message.role !== "user" || (message.metadata as { source?: unknown } | undefined)?.source !== "steer" || run.steers.has(message.id)) continue;
      run.steers.add(message.id);
      run.request += "\n" + message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      delete run.adopted;
      delete run.requested;
      run.version++;
      run.calls.clear();
      run.needsSelection = true;
    }
  }
  end(): void {
    this.#run = undefined;
    this.#pending?.abort();
    this.#pending = undefined;
    this.#notify();
  }
  getPending(): PendingHerdrSelection | undefined { return this.#pending ? structuredClone(this.#pending.selection) : undefined; }
  subscribe(listener: (selection: PendingHerdrSelection | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #notify(): void { for (const listener of this.#listeners) listener(this.getPending()); }
  select(input: SelectHerdrTargetInput): boolean {
    const pending = this.#pending;
    if (!this.#run || !pending || pending.selection.selectionId !== input.selectionId ||
      input.candidateId !== null && !pending.selection.candidates.some(candidate => candidate.candidateId === input.candidateId)) return false;
    pending.settle(input.candidateId);
    return true;
  }
  snapshot() {
    const run = this.#run;
    return { configuredTarget: this.options.configuredTarget ?? null,
      checkedCandidates: structuredClone(run?.candidates ?? []),
      adoptedTarget: run?.adopted ? structuredClone(run.adopted) : null,
      selectionVersion: run?.version ?? 0, halted: run?.halted ?? false,
      requestedTarget: structuredClone(run?.requested ?? null),
      failures: structuredClone(run?.discovery?.failures ?? []) };
  }
  async discover(input: { refresh?: boolean | undefined; requested?: { session?: string | undefined; paneId?: string | undefined; terminalId?: string | undefined; sourceQuote: string } | undefined }, signal?: AbortSignal) {
    const run = this.#run;
    if (!run) return failure("HERDR_FOREGROUND_REQUIRED", "只能在当前前台 Run 中发现并采用 Pi 目标");
    if (run.halted) return failure("HERDR_RUN_HALTED", "本轮出现未知结果，须由用户核对后再决定下一步");
    if (!run.discovery || input.refresh) {
      const discovery = await this.#client.discover(signal);
      signal?.throwIfAborted();
      if (this.#run !== run) return failure("HERDR_RUN_CHANGED", "原 Run 已结束，发现结果未采用");
      run.discovery = discovery;
      run.candidates = discovery.candidates.map(candidate => ({ ...candidate, candidateId: randomUUID() }));
      if (run.adopted && !run.candidates.some(candidate => hashCanonicalJson(candidate.target) === hashCanonicalJson(run.adopted!.target))) {
        delete run.adopted;
        run.version++;
      }
    }
    let matches = run.candidates;
    if (input.requested) {
      const { sourceQuote, ...selector } = input.requested;
      const fields = Object.entries(selector).filter((entry): entry is [string, string] => entry[1] !== undefined);
      if (!sourceQuote || !run.request.includes(sourceQuote) || !fields.length || fields.some(([, value]) => !sourceQuote.includes(value))) {
        return failure("HERDR_REQUEST_EVIDENCE_INVALID", "明确目标须附本轮用户原话及其中的准确目标标识；否则由用户选择");
      }
      run.requested = Object.fromEntries(fields);
    }
    if (run.requested) {
      matches = run.candidates.filter(candidate => Object.entries(run.requested!).every(([key, value]) => candidate.target[key as keyof HerdrTarget] === value));
      if (run.adopted && (matches.length !== 1 || hashCanonicalJson(matches[0]!.target) !== hashCanonicalJson(run.adopted.target))) {
        delete run.adopted;
        run.version++;
      }
      if (!matches.length) return failure("HERDR_REQUESTED_TARGET_NOT_FOUND", "本轮明确指定的 Pi 目标未通过核对，不会采用其他终端");
    }
    const sameConfigured = !this.options.configuredTarget || matches[0] && hashCanonicalJson(matches[0].target) === hashCanonicalJson(this.options.configuredTarget);
    if ((!run.adopted || input.requested) && matches.length === 1 && (run.requested || sameConfigured && !run.needsSelection)) {
      const failed = await this.#adopt(run, matches[0]!, signal);
      if (failed) return failed;
    }
    return { ok: true as const, value: this.snapshot() };
  }
  async #adopt(run: RunTarget, candidate: HerdrSelectionCandidate, signal?: AbortSignal): Promise<Failure | undefined> {
    const checked = await this.#client.execute(candidate.target, { action: "get" }, signal);
    signal?.throwIfAborted();
    if (this.#run !== run) return failure("HERDR_RUN_CHANGED", "原 Run 已结束，目标未采用");
    if (!checked.ok) {
      delete run.discovery;
      return checked;
    }
    run.adopted = structuredClone(candidate);
    run.version++;
    run.needsSelection = false;
    return undefined;
  }
  async #choose(run: RunTarget, input: BeforeToolExecuteInput): Promise<Failure | undefined> {
    if (!run.discovery) {
      const result = await this.discover({}, input.signal);
      if (!result.ok) return result;
    }
    if (!run.candidates.length) return failure("HERDR_NO_PI_TARGET", "未发现已核对的 Pi 目标；请查看发现失败原因，不会启动服务或改发其他终端");
    const candidates = run.requested ? run.candidates.filter(candidate => Object.entries(run.requested!).every(([key, value]) => candidate.target[key as keyof HerdrTarget] === value)) : run.candidates;
    if (!candidates.length) return failure("HERDR_REQUESTED_TARGET_NOT_FOUND", "本轮明确指定的 Pi 目标未通过核对，不会采用其他终端");
    if (run.adopted) return undefined;
    const signal = input.steerSignal ? AbortSignal.any([input.signal, input.steerSignal]) : input.signal;
    const candidateId = await new Promise<string | null>((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener("abort", abort);
        if (this.#pending === entry) { this.#pending = undefined; this.#notify(); }
      };
      const abort = () => { clear(); reject(signal.reason ?? new DOMException("Run ended", "AbortError")); };
      const entry: SelectionWait = { selection: { selectionId: randomUUID(), toolCallId: input.toolCallId, candidates: structuredClone(candidates) },
        settle: id => { clear(); resolve(id); }, abort };
      this.#pending = entry;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else this.#notify();
    });
    if (candidateId === null) return failure("HERDR_TARGET_SELECTION_CANCELLED", "已取消本轮目标选择，没有发送输入");
    const candidate = run.candidates.find(value => value.candidateId === candidateId);
    if (!candidate) return failure("HERDR_TARGET_CHANGED", "候选已变化，请重新发现并选择");
    return this.#adopt(run, candidate, signal);
  }
  async beforeToolExecute(input: BeforeToolExecuteInput, next: BeforeToolExecute): Promise<ToolExecutionDecision> {
    if (input.toolName !== "herdr_pi_read" && input.toolName !== "herdr_pi_control") return next(input);
    const run = this.#run;
    if (!run || run.halted) return { allow: false, reason: run ? "HERDR_RUN_HALTED: 本轮未知结果须人工核对" : "HERDR_FOREGROUND_REQUIRED: 需要当前前台 Run" };
    const parsed = input.toolName === "herdr_pi_read" ? herdrReadSchema.safeParse(input.input) : herdrControlSchema.safeParse(input.input);
    if (!parsed.success) return { allow: false, reason: "HERDR_INVALID_ACTION: 操作参数无效" };
    const signal = input.steerSignal ? AbortSignal.any([input.signal, input.steerSignal]) : input.signal;
    const failed = await this.#choose(run, { ...input, signal });
    signal.throwIfAborted();
    if (failed) {
      run.calls.set(input.toolCallId, { kind: "failed", result: failed });
      return { allow: true };
    }
    run.calls.set(input.toolCallId, { kind: "ready", target: structuredClone(run.adopted!.target), action: structuredClone(parsed.data),
      selectionVersion: run.version, inputHash: hashCanonicalJson(parsed.data) });
    try {
      const decision = await next(input);
      if (!decision.allow) run.calls.delete(input.toolCallId);
      return decision;
    } catch (error) { run.calls.delete(input.toolCallId); throw error; }
  }
  confirmation(toolCallId: string) {
    const call = this.#run?.calls.get(toolCallId);
    return call?.kind === "ready" ? structuredClone({ target: call.target, action: herdrControlSchema.parse(call.action), selectionVersion: call.selectionVersion }) : undefined;
  }
  async execute(toolCallId: string, action: HerdrAction, signal?: AbortSignal) {
    const run = this.#run, call = run?.calls.get(toolCallId);
    run?.calls.delete(toolCallId);
    if (!run || !call) return failure("HERDR_CALL_SNAPSHOT_REQUIRED", "没有本次调用的已冻结目标，不会发送输入");
    if (run.halted) return failure("HERDR_RUN_HALTED", "本轮未知结果须人工核对");
    if (call.kind === "failed") return call.result;
    if (run.version !== call.selectionVersion || hashCanonicalJson(action) !== call.inputHash) return failure("HERDR_TARGET_CHANGED", "目标选择或操作已变化，旧批准不可用");
    try {
      const result = await this.#client.execute(call.target, call.action, signal);
      if (!result.ok && ["HERDR_TARGET_CHANGED", "HERDR_NOT_PI", "HERDR_STATE_UNKNOWN"].includes(result.error.code)) {
        delete run.adopted;
        delete run.discovery;
        run.version++;
      }
      return result;
    } catch (error) {
      if (error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN") run.halted = true;
      throw error;
    }
  }
}
