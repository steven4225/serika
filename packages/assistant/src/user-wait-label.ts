const WAIT_NAMES: Record<string, string> = {
  shell_exec: "执行命令",
  terminal_exec: "主机命令",
  herdr_pi_control: "向 Pi 发送",
  computer_action: "操作应用",
  write_file: "写入文件",
  edit_file: "修改文件",
  read_file: "读取文件",
  list_directory: "列出目录",
  search_files: "搜索文件",
};

/** Desktop and Telegram copy while a Run is blocked on the user. */
export function userWaitLabel(input: { herdr?: boolean; toolName?: string | undefined }): string | null {
  if (input.herdr) return "在等你：选 Pi 目标";
  if (!input.toolName) return null;
  return `在等你：批 ${WAIT_NAMES[input.toolName] ?? "这次操作"}`;
}
