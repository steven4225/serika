import { tool } from "ai";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import {
  queryTodoistTasks,
  todoistListInputSchema,
  todoistListResultSchema,
  todoistViews,
  type QueryTodoistTasksOptions,
  type TodoistDue,
  type TodoistListInput,
  type TodoistListResult,
  type TodoistTaskSummary,
  type TodoistView,
} from "../todoist.js";

const COMMAND_TIMEOUT_MS = 20_000;
const TODOIST_COMMAND_USAGE =
  "Usage: /todoist list [planning|today|overdue|upcoming]";

const todoistListMetadata: RegisteredTool["metadata"] = {
  name: "todoist_list_tasks",
  version: "1",
  risk: "read",
  timeoutMs: COMMAND_TIMEOUT_MS,
  idempotent: true,
};

const neverAborted = new AbortController().signal;

export interface TodoistModuleOptions {
  apiToken: string;
  timeZone: string;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}

function isTodoistView(value: string): value is TodoistView {
  return todoistViews.includes(value as TodoistView);
}

function queryOptions(
  options: TodoistModuleOptions,
  signal: AbortSignal,
): QueryTodoistTasksOptions {
  return {
    apiToken: options.apiToken,
    timeZone: options.timeZone,
    signal,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}

function escapeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function dateInTimeZone(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function renderWindow(window: {
  fromInclusive: string | null;
  toExclusive: string;
}): string {
  return window.fromInclusive === null
    ? `(-∞, ${window.toExclusive})`
    : `[${window.fromInclusive}, ${window.toExclusive})`;
}

function renderDue(due: TodoistDue | null, timeZone: string): string {
  if (due === null) return "—";
  const recurring = due.isRecurring ? "，重复" : "";
  if (due.kind === "date") return `${due.date}（全天${recurring}）`;
  if (due.kind === "floating") {
    return `${due.date} ${due.time}（${escapeTerminalText(timeZone)} 浮动时间${recurring}）`;
  }
  const source =
    due.sourceTimeZone === null
      ? "—"
      : escapeTerminalText(due.sourceTimeZone);
  return `${due.date} ${due.time}（固定时刻 ${due.at}，来源时区 ${source}${recurring}）`;
}

function renderTask(task: TodoistTaskSummary, timeZone: string): string[] {
  return [
    `- ${escapeTerminalText(task.title)}`,
    `  ID: ${escapeTerminalText(task.id)}`,
    `  项目 ID: ${escapeTerminalText(task.projectId)}`,
    `  优先级: ${task.priority}`,
    `  安排: ${renderDue(task.due, timeZone)}`,
    `  截止日期: ${task.deadlineDate ?? "—"}`,
    `  来源: ${escapeTerminalText(task.url)}`,
  ];
}

function renderSuccess(result: Extract<TodoistListResult, { ok: true }>): string {
  const { value } = result;
  const lines = [
    `Todoist 视图: ${value.view}`,
    `规划时区: ${escapeTerminalText(value.timeZone)}`,
    `基准日期: ${dateInTimeZone(value.asOf, value.timeZone)}`,
    `日期范围: ${renderWindow(value.window)}`,
    `返回任务数: ${value.tasks.length}`,
    value.truncated
      ? "完整性: 不完整（查询预算已耗尽，请到 Todoist 查看完整任务）"
      : "完整性: 完整",
  ];

  if (value.tasks.length === 0) {
    lines.push(
      value.truncated
        ? "未返回任务；结果不完整，不能据此判断没有任务。"
        : "此日期范围内没有匹配任务。",
    );
    return lines.join("\n");
  }

  for (const task of value.tasks) lines.push("", ...renderTask(task, value.timeZone));
  return lines.join("\n");
}

function renderResult(result: TodoistListResult): string {
  if (result.ok) return renderSuccess(result);
  return `Todoist 查询失败（${result.error.code}）：${escapeTerminalText(result.error.message)}`;
}

/** Register one read-only Todoist tool and its direct inspection command. */
export function createTodoistModule(options: TodoistModuleOptions): AgentModule {
  return {
    id: "todoist",
    setup(ctx) {
      const lifecycle = new AbortController();
      const commandTimeouts = new Set<ReturnType<typeof setTimeout>>();
      let disposed = false;

      const listTool = tool({
        description:
          "List active Todoist tasks assigned to the current user or unassigned, filtered into planning, today, overdue, or upcoming date views.",
        inputSchema: todoistListInputSchema,
        outputSchema: todoistListResultSchema,
        execute: async (
          input: TodoistListInput,
          { abortSignal },
        ): Promise<TodoistListResult> =>
          queryTodoistTasks(
            input,
            queryOptions(
              options,
              AbortSignal.any([
                lifecycle.signal,
                abortSignal ?? neverAborted,
              ]),
            ),
          ),
      });

      ctx.registerTool({ metadata: todoistListMetadata, tool: listTool });
      ctx.registerCommand({
        name: "todoist",
        execute(args) {
          if (disposed) return;
          const parts = args.trim() === "" ? [] : args.trim().split(/\s+/);
          const [action, viewText, ...extra] = parts;
          if (
            action !== "list" ||
            extra.length > 0 ||
            (viewText !== undefined && !isTodoistView(viewText))
          ) {
            ctx.notify(TODOIST_COMMAND_USAGE);
            return;
          }

          const view = viewText ?? "planning";
          const controller = new AbortController();
          let timedOut = false;
          const abortForDispose = (): void => {
            controller.abort(lifecycle.signal.reason);
          };
          lifecycle.signal.addEventListener("abort", abortForDispose, {
            once: true,
          });
          let finishTimeout!: () => void;
          const timeoutDone = new Promise<void>((resolve) => {
            finishTimeout = resolve;
          });
          const timeout = setTimeout(() => {
            commandTimeouts.delete(timeout);
            timedOut = true;
            controller.abort(new DOMException("Todoist query timed out", "TimeoutError"));
            if (!disposed) ctx.notify("Todoist 查询超时。");
            finishTimeout();
          }, COMMAND_TIMEOUT_MS);
          commandTimeouts.add(timeout);

          const queryDone = queryTodoistTasks(
            { view },
            queryOptions(options, controller.signal),
          )
            .then(
              (result) => {
                if (disposed || timedOut) return;
                ctx.notify(renderResult(result));
              },
              () => {
                if (disposed || timedOut) return;
                ctx.notify("Todoist 查询失败。");
              },
            );
          return Promise.race([queryDone, timeoutDone])
            .finally(() => {
              clearTimeout(timeout);
              commandTimeouts.delete(timeout);
              lifecycle.signal.removeEventListener("abort", abortForDispose);
            });
        },
      });

      return () => {
        disposed = true;
        lifecycle.abort(new DOMException("Todoist module disposed", "AbortError"));
        for (const timeout of commandTimeouts) clearTimeout(timeout);
        commandTimeouts.clear();
      };
    },
  };
}
