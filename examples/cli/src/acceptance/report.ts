import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { deriveCaseStatus, type AcceptanceCaseResult } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function safeId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field} must be a safe, non-empty path component`);
}

function safeRelativePath(value: string): string[] {
  if (
    value.length === 0 || isAbsolute(value) || value.includes("\\") ||
    value.includes("\0") || /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Evidence path must be relative to this attempt: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Evidence path must not traverse directories: ${value}`);
  }
  return parts;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Acceptance directory is not a regular directory: ${path}`);
  }
}

async function verifyEvidencePath(attemptDirectory: string, relativePath: string): Promise<string> {
  const parts = safeRelativePath(relativePath);
  let current = attemptDirectory;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Evidence path contains a symlink: ${relativePath}`);
    const last = index === parts.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Evidence path is not a regular file: ${relativePath}`);
    }
  }
  return current;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function renderMarkdown(result: AcceptanceCaseResult): string {
  const checks = result.checks.map((check) =>
    `| ${markdownCell(check.id)} | ${check.required ? "yes" : "no"} | ${check.method} | ${check.status} | ${markdownCell(check.note)} |`,
  );
  const evidence = result.evidence.map((item) =>
    `| ${markdownCell(item.id)} | ${item.kind} | ${markdownCell(item.path)} |`,
  );
  return [
    `# ${markdownCell(result.caseId)} · ${markdownCell(result.attemptId)}`,
    "",
    `Status: **${result.status}**`,
    `Code: ${markdownCell(result.baseline.commit)}${result.baseline.dirty ? " (dirty)" : ""}`,
    `Execution: ${result.execution.entry}, ${result.execution.model} model, ${result.execution.network} network`,
    `Started: ${markdownCell(result.startedAt)}`,
    `Finished: ${result.finishedAt ?? "not finished"}`,
    `Duration: ${result.durationMs === null ? "unavailable" : `${result.durationMs} ms`}`,
    `Usage: ${result.usage === null ? "unavailable" : markdownCell(JSON.stringify(result.usage))}`,
    ...(result.failure ? [
      `Failure: ${result.failure.layer}${result.failure.code ? ` / ${markdownCell(result.failure.code)}` : ""} — ${markdownCell(result.failure.message)}`,
    ] : []),
    "",
    "## Checks",
    "",
    "| ID | Required | Method | Status | Note |",
    "| --- | --- | --- | --- | --- |",
    ...checks,
    "",
    "## Evidence",
    "",
    "| ID | Kind | Relative path |",
    "| --- | --- | --- |",
    ...evidence,
    "",
  ].join("\n");
}

/** Append one attempt without replacing any earlier result or evidence. */
export async function writeAcceptanceReport(
  result: AcceptanceCaseResult,
  outputDirectory: string,
): Promise<{ resultPath: string; reportPath: string }> {
  if (result.schemaVersion !== 1) throw new Error("Unsupported acceptance schema version");
  safeId(result.caseId, "caseId");
  safeId(result.attemptId, "attemptId");
  const derivedStatus = deriveCaseStatus(result.checks);
  if (result.status !== derivedStatus) {
    throw new Error(`Case status ${result.status} disagrees with required checks: ${derivedStatus}`);
  }
  if (result.status === "failed" && result.failure === undefined) {
    throw new Error("A failed case requires a failure layer and message");
  }

  const checkIds = new Set<string>();
  for (const check of result.checks) {
    safeId(check.id, "check id");
    if (checkIds.has(check.id)) throw new Error(`Duplicate check id: ${check.id}`);
    checkIds.add(check.id);
    if (check.required && check.status === "passed" && check.evidenceIds.length === 0) {
      throw new Error(`Passed required check has no evidence: ${check.id}`);
    }
  }
  const evidenceIds = new Set<string>();
  for (const item of result.evidence) {
    safeId(item.id, "evidence id");
    safeRelativePath(item.path);
    if (evidenceIds.has(item.id)) throw new Error(`Duplicate evidence id: ${item.id}`);
    if (item.sha256 !== undefined && !SHA256.test(item.sha256)) {
      throw new Error(`Invalid evidence sha256: ${item.id}`);
    }
    evidenceIds.add(item.id);
  }
  for (const check of result.checks) {
    for (const id of check.evidenceIds) {
      if (!evidenceIds.has(id)) throw new Error(`Unknown evidence id ${id} in check ${check.id}`);
    }
  }

  const root = resolve(outputDirectory);
  const caseDirectory = join(root, result.caseId);
  const attemptDirectory = join(caseDirectory, result.attemptId);
  await ensureDirectory(root);
  await ensureDirectory(caseDirectory);
  await ensureDirectory(attemptDirectory);
  for (const item of result.evidence) {
    const path = await verifyEvidencePath(attemptDirectory, item.path);
    if (item.sha256 !== undefined && (await hashFile(path)) !== item.sha256) {
      throw new Error(`Evidence digest mismatch: ${item.id}`);
    }
  }

  const resultPath = join(attemptDirectory, "result.json");
  const reportPath = join(attemptDirectory, "report.md");
  const resultHandle = await open(resultPath, "wx");
  try {
    await resultHandle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
  } finally {
    await resultHandle.close();
  }
  const reportHandle = await open(reportPath, "wx");
  try {
    await reportHandle.writeFile(renderMarkdown(result), "utf8");
  } finally {
    await reportHandle.close();
  }
  return { resultPath, reportPath };
}
