import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TODOIST_MAX_PAGES,
  TODOIST_MAX_RESULT_BYTES,
  TODOIST_MAX_TASKS,
  queryTodoistTasks,
  type QueryTodoistTasksOptions,
} from "./todoist.js";

const NOW = new Date("2026-09-11T04:00:00.000Z");

function task(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    project_id: "project-1",
    responsible_uid: "user-1",
    checked: false,
    is_deleted: false,
    content: `Task ${id}`,
    priority: 1,
    due: null,
    deadline: null,
    ignored_upstream_field: "discard me",
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queuedFetch(responses: readonly Response[]): {
  fetch: typeof globalThis.fetch;
  urls: string[];
} {
  const queue = [...responses];
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: string | URL | Request) => {
      urls.push(String(input));
      const response = queue.shift();
      assert.ok(response, "unexpected Todoist request");
      return response;
    }) as typeof globalThis.fetch,
  };
}

function options(fetch: typeof globalThis.fetch): QueryTodoistTasksOptions {
  return {
    apiToken: "secret-token",
    timeZone: "Asia/Shanghai",
    signal: new AbortController().signal,
    now: () => NOW,
    fetch,
  };
}

describe("queryTodoistTasks", () => {
  it("filters identity and state, normalizes dates, deduplicates, and sorts", async () => {
    const source = queuedFetch([
      json({ id: "user-1", token: "must not escape" }),
      json({
        results: [
          task("other", {
            responsible_uid: "user-2",
            due: { date: "not-a-date", is_recurring: false },
          }),
          task("checked", {
            checked: true,
            due: { date: "2026-09-11", is_recurring: false },
          }),
          task("no-date", { responsible_uid: null }),
          task("b", {
            responsible_uid: null,
            priority: 3,
            content: "Unassigned shared task",
            due: {
              date: "2026-09-11T09:30:00",
              is_recurring: true,
              timezone: null,
            },
          }),
          task("a", {
            responsible_uid: "",
            priority: 4,
            due: { date: "2026-09-10", is_recurring: false },
          }),
          task("instant", {
            priority: 4,
            due: {
              date: "2026-09-10T18:00:00Z",
              is_recurring: false,
              timezone: "UTC",
            },
          }),
          task("deadline", {
            due: { date: "2026-09-30", is_recurring: false },
            deadline: { date: "2026-09-12" },
          }),
          task("b", {
            responsible_uid: null,
            priority: 2,
            content: "Later duplicate wins",
            due: { date: "2026-09-11", is_recurring: false },
          }),
        ],
        next_cursor: null,
      }),
    ]);

    const result = await queryTodoistTasks({ view: "planning" }, options(source.fetch));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.window, {
      fromInclusive: null,
      toExclusive: "2026-09-19",
    });
    assert.deepEqual(
      result.value.tasks.map(({ id }) => id),
      ["a", "instant", "b", "deadline"],
    );
    assert.deepEqual(result.value.tasks[1]?.due, {
      kind: "instant",
      date: "2026-09-11",
      time: "02:00:00",
      at: "2026-09-10T18:00:00.000Z",
      sourceTimeZone: "UTC",
      isRecurring: false,
    });
    assert.deepEqual(result.value.tasks[2]?.due, {
      kind: "date",
      date: "2026-09-11",
      isRecurring: false,
    });
    assert.equal(result.value.tasks[2]?.title, "Later duplicate wins");
    assert.equal(result.value.tasks[3]?.deadlineDate, "2026-09-12");
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(result.value.truncated, false);
  });

  it("uses frozen day-level view boundaries in the planning time zone", async () => {
    const page = {
      results: [
        task("yesterday", { due: { date: "2026-09-10", is_recurring: false } }),
        task("today", { due: { date: "2026-09-11", is_recurring: false } }),
        task("tomorrow", { due: { date: "2026-09-12", is_recurring: false } }),
        task("day-seven", { due: { date: "2026-09-18", is_recurring: false } }),
        task("day-eight", { due: { date: "2026-09-19", is_recurring: false } }),
      ],
      next_cursor: null,
    };

    for (const [view, expected] of [
      ["today", ["today"]],
      ["overdue", ["yesterday"]],
      ["upcoming", ["tomorrow", "day-seven"]],
    ] as const) {
      const source = queuedFetch([json({ id: "user-1" }), json(page)]);
      const result = await queryTodoistTasks({ view }, options(source.fetch));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(
          result.value.tasks.map(({ id }) => id),
          expected,
        );
      }
    }
  });

  it("marks a fifth-page cursor as incomplete without fetching a sixth page", async () => {
    const responses = [json({ id: "user-1" })];
    for (let page = 1; page <= TODOIST_MAX_PAGES; page += 1) {
      responses.push(json({ results: [], next_cursor: `cursor-${page}` }));
    }
    const source = queuedFetch(responses);

    const result = await queryTodoistTasks({}, options(source.fetch));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
    assert.deepEqual(result.value.tasks, []);
    assert.equal(source.urls.length, TODOIST_MAX_PAGES + 1);
    assert.match(source.urls[1] ?? "", /limit=200/);
    assert.match(source.urls[2] ?? "", /cursor=cursor-1/);
  });

  it("returns the longest sorted prefix within count and byte budgets", async () => {
    const many = Array.from({ length: TODOIST_MAX_TASKS + 1 }, (_, index) =>
      task(String(index).padStart(3, "0"), {
        due: { date: "2026-09-11", is_recurring: false },
      }),
    );
    const countSource = queuedFetch([
      json({ id: "user-1" }),
      json({ results: many, next_cursor: null }),
    ]);
    const countResult = await queryTodoistTasks({}, options(countSource.fetch));
    assert.equal(countResult.ok, true);
    if (countResult.ok) {
      assert.equal(countResult.value.tasks.length, TODOIST_MAX_TASKS);
      assert.equal(countResult.value.truncated, true);
    }

    const bytesSource = queuedFetch([
      json({ id: "user-1" }),
      json({
        results: [
          task("huge", {
            content: "x".repeat(TODOIST_MAX_RESULT_BYTES),
            due: { date: "2026-09-11", is_recurring: false },
          }),
        ],
        next_cursor: null,
      }),
    ]);
    const bytesResult = await queryTodoistTasks({}, options(bytesSource.fetch));
    assert.equal(bytesResult.ok, true);
    if (bytesResult.ok) {
      assert.deepEqual(bytesResult.value.tasks, []);
      assert.equal(bytesResult.value.truncated, true);
      assert.ok(
        Buffer.byteLength(JSON.stringify(bytesResult), "utf8") <=
          TODOIST_MAX_RESULT_BYTES,
      );
    }
  });

  it("fails the whole query for a mid-pagination HTTP error or invalid date", async () => {
    const failedPage = queuedFetch([
      json({ id: "user-1" }),
      json({ results: [], next_cursor: "next" }),
      json({ message: "do not expose" }, 429),
    ]);
    assert.deepEqual(await queryTodoistTasks({}, options(failedPage.fetch)), {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Todoist rate limit exceeded",
      },
    });

    const invalidDate = queuedFetch([
      json({ id: "user-1" }),
      json({
        results: [
          task("bad", {
            due: { date: "2026-02-30", is_recurring: false },
          }),
        ],
        next_cursor: null,
      }),
    ]);
    assert.deepEqual(await queryTodoistTasks({}, options(invalidDate.fetch)), {
      ok: false,
      error: {
        code: "INVALID_RESPONSE",
        message: "Todoist returned an invalid task date",
      },
    });
  });

  it("rejects invalid input locally and preserves abort semantics", async () => {
    let called = false;
    const fetch = (async () => {
      called = true;
      return json({});
    }) as typeof globalThis.fetch;
    assert.deepEqual(await queryTodoistTasks({ view: "all" }, options(fetch)), {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Todoist query input is invalid" },
    });
    assert.equal(called, false);

    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    controller.abort(reason);
    await assert.rejects(
      queryTodoistTasks({}, { ...options(fetch), signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(called, false);
  });
});
