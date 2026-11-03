import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HerdrTarget } from "./herdr.js";
import { AUTONOMOUS_TOTAL_TIMEOUT_MS } from "./foreground-autonomy.js";

/** Same bound as an autonomous Run: an empty scope keeps grants for at most 30 minutes. */
export const TASK_TRUST_IDLE_MS = AUTONOMOUS_TOTAL_TIMEOUT_MS;

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

export function taskTrustKey(input: { threadId: string; workTaskId?: string | undefined }): string {
  return input.workTaskId ? `task:${input.workTaskId}` : `thread:${input.threadId}`;
}

export type TaskTrustKind = "files" | "host-shell" | "pi-target" | "pi-control" | "computer";

export interface TaskTrustGrant {
  id: string;
  scopeKey: string;
  kind: TaskTrustKind;
  label: string;
}

interface Grant extends TaskTrustGrant {
  path?: string;
  tool?: string;
  fingerprint?: string;
  bundleId?: string;
  target?: HerdrTarget;
}

interface Scope {
  key: string;
  threadId: string;
  workTaskId?: string;
  activityAt: number;
  runs: number;
  grants: Grant[];
}

function within(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function absoluteArgument(input: unknown, argument: string, workspace: string | undefined): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[argument];
  const path = typeof value === "string" && value.length > 0 ? value : undefined;
  if (argument === "cwd" && path === undefined) {
    const base = workspace;
    return base ? resolve(base, ".") : undefined;
  }
  if (path === undefined) return undefined;
  if (isAbsolute(path)) return resolve(path);
  const directory = (input as Record<string, unknown>).directory;
  const base = typeof directory === "string" && isAbsolute(directory) ? directory : workspace;
  return base ? resolve(base, path) : undefined;
}

/** Deepest configured allowlist root that contains this directory-scoped file call. */
export function fileAllowlistRoot(
  roots: readonly string[],
  input: unknown,
  workspace: string | undefined,
  scope: { kind: string; argument: string } | undefined,
): string | undefined {
  if (scope?.kind !== "directoryPath") return undefined;
  const path = absoluteArgument(input, scope.argument, workspace);
  if (!path) return undefined;
  return roots.map(root => resolve(root)).filter(root => within(root, path))
    .sort((left, right) => right.length - left.length)[0];
}

export function hostShellCwd(input: unknown, workspace: string | undefined): string | undefined {
  return absoluteArgument(input, "cwd", workspace);
}

export interface TaskTrust {
  key(input: { threadId: string; workTaskId?: string | undefined }): string;
  noteRunStart(input: { threadId: string; workTaskId?: string | undefined }): string;
  noteRunEnd(key: string | undefined): void;
  end(key: string): void;
  scopeKey(): string | undefined;
  allowsFile(key: string, root: string): boolean;
  grantFile(key: string, root: string): void;
  allowsHostShell(key: string, tool: string, cwd: string): boolean;
  grantHostShell(key: string, tool: string, cwd: string): void;
  pinnedTarget(key: string): HerdrTarget | undefined;
  pinTarget(key: string, target: HerdrTarget): void;
  clearPi(key: string): void;
  allowsPiControl(key: string, fingerprint: string): boolean;
  grantPiControl(key: string, fingerprint: string): void;
  allowsComputer(key: string, bundleId: string): boolean;
  grantComputer(key: string, bundleId: string): void;
  list(threadId: string): TaskTrustGrant[];
  forget(id: string): boolean;
}

export function createTaskTrust(now: () => number = Date.now): TaskTrust {
  const scopes = new Map<string, Scope>();
  let nextId = 1;
  let activeKey: string | undefined;

  const drop = (key: string): void => { scopes.delete(key); };

  const live = (key: string): Scope | undefined => {
    const scope = scopes.get(key);
    if (!scope) return undefined;
    if (scope.runs === 0 && now() - scope.activityAt > TASK_TRUST_IDLE_MS) {
      drop(key);
      return undefined;
    }
    return scope;
  };

  const ensure = (key: string): Scope | undefined => {
    const existing = live(key);
    if (existing) return existing;
    return undefined;
  };

  const open = (input: { threadId: string; workTaskId?: string | undefined }): Scope => {
    const key = taskTrustKey(input);
    const existing = scopes.get(key);
    if (existing && !(existing.runs === 0 && now() - existing.activityAt > TASK_TRUST_IDLE_MS)) {
      existing.activityAt = now();
      return existing;
    }
    const created: Scope = {
      key, threadId: input.threadId, ...(input.workTaskId ? { workTaskId: input.workTaskId } : {}),
      activityAt: now(), runs: 0, grants: [],
    };
    scopes.set(key, created);
    return created;
  };

  const add = (key: string, grant: Omit<Grant, "id" | "scopeKey">): void => {
    const scope = ensure(key);
    if (!scope || scope.runs === 0) return;
    if (scope.grants.some(item => item.kind === grant.kind && item.path === grant.path && item.tool === grant.tool &&
      item.fingerprint === grant.fingerprint && item.bundleId === grant.bundleId)) return;
    scope.activityAt = now();
    scope.grants.push({ id: `t${nextId++}`, scopeKey: key, ...grant, ...(grant.target ? { target: structuredClone(grant.target) } : {}) });
  };

  return {
    key: taskTrustKey,
    noteRunStart(input) {
      const scope = open(input);
      scope.runs += 1;
      scope.activityAt = now();
      activeKey = scope.key;
      return scope.key;
    },
    noteRunEnd(key) {
      if (!key) return;
      const scope = scopes.get(key);
      if (!scope) return;
      scope.runs = Math.max(0, scope.runs - 1);
      scope.activityAt = now();
      if (activeKey === key) activeKey = undefined;
    },
    end(key) { drop(key); if (activeKey === key) activeKey = undefined; },
    scopeKey: () => activeKey,
    allowsFile(key, root) {
      const scope = live(key);
      return !!scope && scope.grants.some(grant => grant.kind === "files" && grant.path !== undefined && within(grant.path, root));
    },
    grantFile(key, root) {
      const path = resolve(root);
      add(key, { kind: "files", path, label: `本任务内，授权目录 ${path} 下的文件不再逐次确认` });
    },
    allowsHostShell(key, tool, cwd) {
      const scope = live(key);
      return !!scope && scope.grants.some(grant => grant.kind === "host-shell" && grant.tool === tool &&
        grant.path !== undefined && within(grant.path, cwd));
    },
    grantHostShell(key, tool, cwd) {
      const path = resolve(cwd);
      add(key, { kind: "host-shell", tool, path, label: `本任务内，${tool} 在 ${path} 及其子目录不再逐次确认` });
    },
    pinnedTarget(key) {
      const grant = live(key)?.grants.find(item => item.kind === "pi-target" && item.target);
      return grant?.target ? structuredClone(grant.target) : undefined;
    },
    pinTarget(key, target) {
      const scope = ensure(key);
      if (!scope || scope.runs === 0) return;
      scope.grants = scope.grants.filter(grant => grant.kind !== "pi-target");
      scope.activityAt = now();
      scope.grants.push({ id: `t${nextId++}`, scopeKey: key, kind: "pi-target", target: structuredClone(target),
        label: `本任务内沿用 Pi ${target.session}（${target.paneId} / ${target.terminalId}），直到身份变化` });
    },
    clearPi(key) {
      const scope = scopes.get(key);
      if (!scope) return;
      scope.grants = scope.grants.filter(grant => grant.kind !== "pi-target" && grant.kind !== "pi-control");
    },
    allowsPiControl(key, fingerprint) {
      return !!live(key)?.grants.some(grant => grant.kind === "pi-control" && grant.fingerprint === fingerprint);
    },
    grantPiControl(key, fingerprint) {
      add(key, { kind: "pi-control", fingerprint, label: "本任务内，同一 Pi 目标的 prompt/input/stop 不再逐次确认" });
    },
    allowsComputer(key, bundleId) {
      return !!live(key)?.grants.some(grant => grant.kind === "computer" && grant.bundleId === bundleId);
    },
    grantComputer(key, bundleId) {
      add(key, { kind: "computer", bundleId, label: `本任务内，操作 ${bundleId} 不再逐次确认` });
    },
    list(threadId) {
      return [...scopes.values()].filter(scope => scope.threadId === threadId && live(scope.key))
        .flatMap(scope => scope.grants.map(({ id, scopeKey, kind, label }) => ({ id, scopeKey, kind, label })));
    },
    forget(id) {
      for (const scope of scopes.values()) {
        const index = scope.grants.findIndex(grant => grant.id === id);
        if (index < 0) continue;
        const grant = scope.grants[index]!;
        if (grant.kind === "pi-target") scope.grants = scope.grants.filter(item => item.kind !== "pi-target" && item.kind !== "pi-control");
        else scope.grants.splice(index, 1);
        return true;
      }
      return false;
    },
  };
}
