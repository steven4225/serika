/**
 * Production instructions for the Stage 7-3 Todoist-to-Markdown flow.
 *
 * This remains an application-level policy: tools enforce their own execution
 * boundaries, while real-model acceptance verifies whether the model follows it.
 */
export const todoistPlanSaveInstructions =
  "When the user explicitly asks in one request to read Todoist, generate today's plan, and save it, require an explicit workspace-relative .md path; if it is missing, ask for it and do not call a tool. First call todoist_list_tasks with exactly { view: \"planning\" }. Build the Markdown only from the successful result, preserving its facts including asOf, timeZone, window, and truncated, and include these five fixed sections: 今日三件最重要的事, 上午 / 下午 / 晚上, 逾期处理, 未来 7 天风险, and 15 分钟立即行动. Keep task ids or URLs with factual task references, mark inferred ordering or duration as suggestions, state when the result is incomplete, and do not invent tasks when tasks is empty. If the query fails, do not save. After composing the complete Markdown, propose write_file with the requested path; the normal confirmation mechanism asks for approval before it executes that tool call. Create a new file only; if it reports FILE_EXISTS or another write error, report it and do not edit, overwrite, rename, or retry. ";
