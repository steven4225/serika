import type { BeforeRunFinish, BeforeRunFinishInput, RunFinishDecision } from "@aisdk-agent/core";
import type { WorkTaskStore } from "./work-task-store.js";
import { verifyAutomaticCriterion, type VerificationEnvironment } from "./work-task-verification.js";

export const WORK_TASK_MAX_CORRECTIONS = 2;
/** No new model loop, tool, permission, or persisted plan. Checks only the current owned Run. */
export function createWorkTaskFinishCheck(env: VerificationEnvironment & { workTasks: WorkTaskStore | undefined }): BeforeRunFinish {
  return async (input: BeforeRunFinishInput): Promise<RunFinishDecision | undefined> => {
    const context = input.context as { workTaskId?: unknown; completionCheck?: unknown } | undefined;
    if (typeof context?.workTaskId !== "string" || context.completionCheck === false) return undefined;
    input.signal.throwIfAborted();
    const found = await env.workTasks?.get(context.workTaskId);
    if (!found?.ok || found.value.threadId !== input.threadId || found.value.status !== "running" || found.value.runIds.at(-1) !== input.runId) {
      return { kind: "stop", reason: "needs_review" };
    }
    const task = found.value;
    const run = await env.executionRecords.getRun(input.threadId, input.runId);
    if (!run || run.workTaskId !== task.id || run.phase !== "primary" || run.status !== "running" ||
        run.tools.some(tool => ["unknown", "started", "requested"].includes(tool.status))) return { kind: "stop", reason: "needs_review" };
    const required = task.acceptance.filter(criterion => criterion.required && criterion.method === "automatic");
    if (!required.length) return { kind: "stop", reason: "needs_information" };
    const checks = await Promise.all(required.map(async criterion => ({ criterion, result: await verifyAutomaticCriterion(env, task, criterion, { runId: input.runId, signal: input.signal }) })));
    input.signal.throwIfAborted();
    const missing = checks.filter(check => check.result.status !== "passed");
    if (!missing.length) return { kind: "stop", reason: "delivered" };
    let lastUser = input.messages.length - 1;
    while (lastUser >= 0 && input.messages[lastUser]?.role !== "user") lastUser -= 1;
    const denied = input.messages.slice(lastUser).some(message => message.parts.some(part => part.type === "dynamic-tool" && part.state === "output-error" && part.errorText.startsWith("TOOL_DENIED")));
    if (denied) return { kind: "stop", reason: "needs_confirmation" };
    if (missing.some(({ criterion, result }) => result.status === "blocked" ||
      (criterion.verification.kind === "artifact_exists" && criterion.verification.requireReadback === true && !input.definition.tools.includes("read_file")) ||
      (criterion.verification.kind === "shell_exit_zero" ? !input.definition.tools.includes("shell_exec") :
        !input.definition.tools.some(tool => ["write_file", "edit_file"].includes(tool))))) return { kind: "stop", reason: "needs_information" };
    if (input.corrections >= WORK_TASK_MAX_CORRECTIONS || input.remainingSteps <= 0) return { kind: "stop", reason: "budget_exhausted" };
    return { kind: "continue", feedback: [
      "Do not end this WorkTask yet: the following required program checks are not satisfied. Correct only these missing steps within the original goal and constraints, then finish again.",
      "Read current files before editing. New tool calls still require their original confirmation. Never replay unknown effects or repeat a denied call; do not self-accept human quality.",
      ...missing.map(({ criterion, result }) => JSON.stringify({ id: criterion.id, verification: criterion.verification, status: result.status, note: result.note })),
    ].join("\n").slice(0, 8192) };
  };
}
