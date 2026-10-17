import { z } from "zod";

export const TODOIST_API_BASE_URL = "https://api.todoist.com/api/v1";
export const TODOIST_PAGE_SIZE = 200;
export const TODOIST_MAX_PAGES = 5;
export const TODOIST_MAX_TASKS = 100;
export const TODOIST_MAX_RESULT_BYTES = 32_768;

export const todoistViews = ["planning", "today", "overdue", "upcoming"] as const;
export type TodoistView = (typeof todoistViews)[number];

export interface TodoistListInput {
  view?: TodoistView | undefined;
}

export type TodoistDue =
  | {
      kind: "date";
      date: string;
      isRecurring: boolean;
    }
  | {
      kind: "floating";
      date: string;
      time: string;
      isRecurring: boolean;
    }
  | {
      kind: "instant";
      date: string;
      time: string;
      at: string;
      sourceTimeZone: string | null;
      isRecurring: boolean;
    };

export interface TodoistTaskSummary {
  id: string;
  title: string;
  projectId: string;
  priority: "p1" | "p2" | "p3" | "p4";
  due: TodoistDue | null;
  deadlineDate: string | null;
  url: string;
}

export const todoistErrorCodes = [
  "INVALID_INPUT",
  "AUTH_FAILED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "REQUEST_FAILED",
  "INVALID_RESPONSE",
] as const;
export type TodoistErrorCode = (typeof todoistErrorCodes)[number];

export interface TodoistListSuccess {
  ok: true;
  value: {
    view: TodoistView;
    asOf: string;
    timeZone: string;
    window: {
      fromInclusive: string | null;
      toExclusive: string;
    };
    tasks: TodoistTaskSummary[];
    truncated: boolean;
  };
}

export interface TodoistListFailure {
  ok: false;
  error: {
    code: TodoistErrorCode;
    message: string;
  };
}

export type TodoistListResult = TodoistListSuccess | TodoistListFailure;

export interface QueryTodoistTasksOptions {
  apiToken: string;
  timeZone: string;
  signal: AbortSignal;
  now?: (() => Date) | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export const todoistListInputSchema: z.ZodType<TodoistListInput> = z
  .object({ view: z.enum(todoistViews).optional() })
  .strict();

const todoistDueSchema: z.ZodType<TodoistDue> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("date"),
    date: z.string(),
    isRecurring: z.boolean(),
  }),
  z.object({
    kind: z.literal("floating"),
    date: z.string(),
    time: z.string(),
    isRecurring: z.boolean(),
  }),
  z.object({
    kind: z.literal("instant"),
    date: z.string(),
    time: z.string(),
    at: z.string(),
    sourceTimeZone: z.string().nullable(),
    isRecurring: z.boolean(),
  }),
]);

const todoistTaskSummarySchema: z.ZodType<TodoistTaskSummary> = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  priority: z.enum(["p1", "p2", "p3", "p4"]),
  due: todoistDueSchema.nullable(),
  deadlineDate: z.string().nullable(),
  url: z.string(),
});

export const todoistListResultSchema: z.ZodType<TodoistListResult> =
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      value: z.object({
        view: z.enum(todoistViews),
        asOf: z.string(),
        timeZone: z.string(),
        window: z.object({
          fromInclusive: z.string().nullable(),
          toExclusive: z.string(),
        }),
        tasks: z.array(todoistTaskSummarySchema),
        truncated: z.boolean(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: z.enum(todoistErrorCodes),
        message: z.string(),
      }),
    }),
  ]);

const userResponseSchema = z.object({ id: z.string().min(1) });
const apiDueSchema = z.object({
  date: z.string(),
  is_recurring: z.boolean(),
  timezone: z.string().nullable().optional(),
});
const apiDeadlineSchema = z.object({ date: z.string() });
const apiTaskSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  responsible_uid: z.string().nullable(),
  checked: z.boolean(),
  is_deleted: z.boolean(),
  content: z.string(),
  priority: z.number().int().min(1).max(4),
  due: apiDueSchema.nullable(),
  deadline: apiDeadlineSchema.nullable(),
});
const taskPageSchema = z.object({
  results: z.array(apiTaskSchema),
  next_cursor: z.string().nullable(),
});

type ApiTask = z.infer<typeof apiTaskSchema>;

interface CalendarParts {
  date: string;
  time: string;
}

interface NormalizedTask {
  summary: TodoistTaskSummary;
  relevantDates: string[];
}

interface DatedTask extends NormalizedTask {
  sortDate: string;
}

type JsonRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: TodoistListFailure };

function failure(code: TodoistErrorCode, message: string): TodoistListFailure {
  return { ok: false, error: { code, message } };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Todoist query aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export function canonicalTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const monthDays = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (monthDays[month - 1] ?? 0);
}

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarParts(
  value: Date,
  formatter: Intl.DateTimeFormat,
): CalendarParts {
  const parts = new Map(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return {
    date: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    time: `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`,
  };
}

function normalizeDue(
  due: ApiTask["due"],
  formatter: Intl.DateTimeFormat,
): TodoistDue | null | undefined {
  if (due === null) return null;
  if (isValidDate(due.date)) {
    return { kind: "date", date: due.date, isRecurring: due.is_recurring };
  }

  const floating = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(
    due.date,
  );
  if (floating) {
    const date = floating[1];
    const time = floating[2];
    if (!date || !time || !isValidDate(date) || !isValidTime(time)) return undefined;
    return {
      kind: "floating",
      date,
      time,
      isRecurring: due.is_recurring,
    };
  }

  const instant = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    due.date,
  );
  if (!instant || !instant[1] || !instant[2]) return undefined;
  if (!isValidDate(instant[1]) || !isValidTime(instant[2])) return undefined;
  const parsed = new Date(due.date);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const local = calendarParts(parsed, formatter);
  return {
    kind: "instant",
    date: local.date,
    time: local.time,
    at: parsed.toISOString(),
    sourceTimeZone: due.timezone ?? null,
    isRecurring: due.is_recurring,
  };
}

function normalizeTask(
  task: ApiTask,
  formatter: Intl.DateTimeFormat,
): NormalizedTask | undefined {
  const due = normalizeDue(task.due, formatter);
  if (due === undefined) return undefined;
  const deadlineDate = task.deadline?.date ?? null;
  if (deadlineDate !== null && !isValidDate(deadlineDate)) return undefined;

  return {
    summary: {
      id: task.id,
      title: task.content,
      projectId: task.project_id,
      priority: ({ 4: "p1", 3: "p2", 2: "p3", 1: "p4" } as const)[task.priority]!,
      due,
      deadlineDate,
      url: `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`,
    },
    relevantDates: [due?.date, deadlineDate].filter(
      (value): value is string => value !== null && value !== undefined,
    ),
  };
}

function isEligibleTask(task: ApiTask, userId: string): boolean {
  return (
    !task.checked &&
    !task.is_deleted &&
    (task.responsible_uid === null ||
      task.responsible_uid === "" ||
      task.responsible_uid === userId)
  );
}

function windowFor(view: TodoistView, today: string): TodoistListSuccess["value"]["window"] {
  switch (view) {
    case "today":
      return { fromInclusive: today, toExclusive: addDays(today, 1) };
    case "overdue":
      return { fromInclusive: null, toExclusive: today };
    case "upcoming":
      return { fromInclusive: addDays(today, 1), toExclusive: addDays(today, 8) };
    case "planning":
      return { fromInclusive: null, toExclusive: addDays(today, 8) };
  }
}

function dateInWindow(
  date: string,
  window: TodoistListSuccess["value"]["window"],
): boolean {
  return (window.fromInclusive === null || date >= window.fromInclusive) && date < window.toExclusive;
}

function priorityRank(priority: TodoistTaskSummary["priority"]): number {
  return Number(priority.slice(1));
}

async function requestJson(
  url: string,
  apiToken: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<JsonRequestResult> {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted) throw abortReason(signal);
    return { ok: false, error: failure("REQUEST_FAILED", "Todoist request failed") };
  }

  throwIfAborted(signal);
  if (!response.ok) {
    if (response.status === 401) {
      return { ok: false, error: failure("AUTH_FAILED", "Todoist authentication failed") };
    }
    if (response.status === 403) {
      return { ok: false, error: failure("FORBIDDEN", "Todoist request is forbidden") };
    }
    if (response.status === 429) {
      return { ok: false, error: failure("RATE_LIMITED", "Todoist rate limit exceeded") };
    }
    return {
      ok: false,
      error: failure("REQUEST_FAILED", `Todoist request failed with HTTP ${response.status}`),
    };
  }

  try {
    return { ok: true, value: await response.json() };
  } catch {
    if (signal.aborted) throw abortReason(signal);
    return {
      ok: false,
      error: failure("INVALID_RESPONSE", "Todoist returned an invalid response"),
    };
  }
}

function successResult(
  value: Omit<TodoistListSuccess["value"], "tasks" | "truncated">,
  tasks: readonly TodoistTaskSummary[],
  scanTruncated: boolean,
): TodoistListSuccess {
  const countTruncated = tasks.length > TODOIST_MAX_TASKS;
  const candidates = tasks.slice(0, TODOIST_MAX_TASKS);
  if (!scanTruncated && !countTruncated) {
    const complete: TodoistListSuccess = {
      ok: true,
      value: { ...value, tasks: candidates, truncated: false },
    };
    if (Buffer.byteLength(JSON.stringify(complete), "utf8") <= TODOIST_MAX_RESULT_BYTES) {
      return complete;
    }
  }

  const included: TodoistTaskSummary[] = [];
  for (const task of candidates) {
    const candidate: TodoistListSuccess = {
      ok: true,
      value: { ...value, tasks: [...included, task], truncated: true },
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > TODOIST_MAX_RESULT_BYTES) break;
    included.push(task);
  }
  return { ok: true, value: { ...value, tasks: included, truncated: true } };
}

/** Query the fixed Todoist read API and return planning-time-zone task facts. */
export async function queryTodoistTasks(
  input: unknown,
  options: QueryTodoistTasksOptions,
): Promise<TodoistListResult> {
  const parsedInput = todoistListInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return failure("INVALID_INPUT", "Todoist query input is invalid");
  }
  if (options.apiToken.trim().length === 0) {
    return failure("INVALID_INPUT", "Todoist API token must be non-empty");
  }
  const timeZone = canonicalTimeZone(options.timeZone);
  if (!timeZone) {
    return failure("INVALID_INPUT", "Todoist planning time zone is invalid");
  }

  throwIfAborted(options.signal);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    return failure("INVALID_INPUT", "Todoist query clock is invalid");
  }
  const asOf = now.toISOString();
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const today = calendarParts(now, formatter).date;
  const view = parsedInput.data.view ?? "planning";
  const window = windowFor(view, today);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const userRequest = await requestJson(
    `${TODOIST_API_BASE_URL}/user`,
    options.apiToken,
    options.signal,
    fetchImpl,
  );
  if (!userRequest.ok) return userRequest.error;
  const user = userResponseSchema.safeParse(userRequest.value);
  if (!user.success) {
    return failure("INVALID_RESPONSE", "Todoist returned an invalid user response");
  }

  const tasksById = new Map<string, ApiTask>();
  let cursor: string | null = null;
  let scanTruncated = false;
  for (let pageNumber = 0; pageNumber < TODOIST_MAX_PAGES; pageNumber += 1) {
    const url = new URL(`${TODOIST_API_BASE_URL}/tasks`);
    url.searchParams.set("limit", String(TODOIST_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const pageRequest = await requestJson(
      url.toString(),
      options.apiToken,
      options.signal,
      fetchImpl,
    );
    if (!pageRequest.ok) return pageRequest.error;
    const parsedPage = taskPageSchema.safeParse(pageRequest.value);
    if (!parsedPage.success) {
      return failure("INVALID_RESPONSE", "Todoist returned an invalid task response");
    }

    for (const task of parsedPage.data.results) {
      tasksById.set(task.id, task);
    }
    cursor = parsedPage.data.next_cursor;
    if (cursor === null) break;
    if (pageNumber === TODOIST_MAX_PAGES - 1) scanTruncated = true;
  }

  const matched: DatedTask[] = [];
  for (const source of tasksById.values()) {
    if (!isEligibleTask(source, user.data.id)) continue;
    const task = normalizeTask(source, formatter);
    if (!task) {
      return failure("INVALID_RESPONSE", "Todoist returned an invalid task date");
    }
    const dates = task.relevantDates.filter((date) => dateInWindow(date, window));
    if (dates.length > 0) matched.push({ ...task, sortDate: dates.sort()[0]! });
  }
  matched.sort(
    (left, right) =>
      left.sortDate.localeCompare(right.sortDate) ||
      priorityRank(left.summary.priority) - priorityRank(right.summary.priority) ||
      left.summary.id.localeCompare(right.summary.id),
  );

  return successResult(
    { view, asOf, timeZone, window },
    matched.map((task) => task.summary),
    scanTruncated,
  );
}
