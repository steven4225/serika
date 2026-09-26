import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AcceptanceCheck, CheckStatus } from "./contracts.js";
import { getAcceptanceCase, type AssertionKind } from "./cases.js";

type JsonObject = Record<string, unknown>;

/** Stable report-safe ID for one relative evidence path. */
export function evidenceIdForPath(path: string): string {
  return `e-${createHash("sha256").update(path).digest("hex").slice(0, 20)}`;
}

interface FileAssertion {
  checkId: string;
  kind: "file_present" | "file_absent" | "file_sha256";
  path: string;
  sha256?: string;
}

interface JsonEqualsAssertion {
  checkId: string;
  kind: "json_equals";
  path: string;
  pointer: string;
  expected: unknown;
}

interface JsonCompareAssertion {
  checkId: string;
  kind: "json_compare";
  left: { path: string; pointer: string };
  right: { path: string; pointer: string };
  operator: "equal" | "not_equal";
}

type Assertion = FileAssertion | JsonEqualsAssertion | JsonCompareAssertion;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only relative paths inside the supplied attempt directory may be inspected. */
async function inspectPath(root: string, path: string): Promise<{ absolute: string; exists: boolean }> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
    /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Evidence path must be a plain relative path");
  }
  const absolute = resolve(root, path);
  const contained = relative(root, absolute);
  if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("Evidence path is outside the attempt directory");
  }

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Attempt directory must be a real directory");
  }

  const parts = contained.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return { absolute, exists: false };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Evidence path contains a symlink");
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error("Evidence path has a non-directory parent");
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error("Evidence path must name a regular file");
    }
  }
  return { absolute, exists: true };
}

function parsePointer(value: unknown): readonly string[] {
  if (typeof value !== "string" || (value !== "" && !value.startsWith("/"))) {
    throw new Error("JSON pointer must be empty or start with /");
  }
  if (value === "") return [];
  return value.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("Invalid JSON pointer escape");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function selectPointer(document: unknown, pointer: string): { found: boolean; value: unknown } {
  let current = document;
  for (const key of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[Number(key)];
    } else if (isObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

async function readJson(root: string, path: string): Promise<unknown> {
  const located = await inspectPath(root, path);
  if (!located.exists) throw new Error(`Evidence file is missing: ${path}`);
  return JSON.parse(await readFile(located.absolute, "utf8")) as unknown;
}

function parseAssertion(value: unknown): Assertion {
  if (!isObject(value) || typeof value.checkId !== "string") {
    throw new Error("Assertion requires checkId");
  }
  if (value.kind === "file_present" || value.kind === "file_absent" || value.kind === "file_sha256") {
    if (typeof value.path !== "string") throw new Error("File assertion requires path");
    if (value.kind === "file_sha256" &&
      (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sha256))) {
      throw new Error("file_sha256 requires a SHA-256 hex digest");
    }
    return value as unknown as FileAssertion;
  }
  if (value.kind === "json_equals") {
    if (typeof value.path !== "string" || typeof value.pointer !== "string" ||
      !Object.hasOwn(value, "expected")) {
      throw new Error("json_equals requires path, pointer, and expected");
    }
    parsePointer(value.pointer);
    return value as unknown as JsonEqualsAssertion;
  }
  if (value.kind === "json_compare") {
    for (const side of [value.left, value.right]) {
      if (!isObject(side) || typeof side.path !== "string" || typeof side.pointer !== "string") {
        throw new Error("json_compare requires left and right path/pointer pairs");
      }
      parsePointer(side.pointer);
    }
    if (value.operator !== "equal" && value.operator !== "not_equal") {
      throw new Error("json_compare requires equal or not_equal");
    }
    return value as unknown as JsonCompareAssertion;
  }
  throw new Error("Unknown assertion kind");
}

function assertCaseExpectation(checkId: string, assertion: Assertion): void {
  if (checkId === "check_exit" || checkId === "denied_request_count") {
    if (assertion.kind !== "json_equals" || assertion.expected !== 0) {
      throw new Error(`${checkId} must compare with numeric zero`);
    }
  }
  if (checkId === "task_state") {
    if (assertion.kind !== "json_equals" || assertion.expected !== "completed") {
      throw new Error("task_state must compare with completed");
    }
  }
  if (checkId === "task_id_stable") {
    if (assertion.kind !== "json_compare" || assertion.operator !== "equal") {
      throw new Error("task_id_stable must compare equal values");
    }
  }
  if (checkId === "run_at_changed") {
    if (assertion.kind !== "json_compare" || assertion.operator !== "not_equal") {
      throw new Error("run_at_changed must compare different values");
    }
  }
}

async function evaluate(
  root: string,
  assertion: Assertion,
): Promise<{ status: CheckStatus; note: string; evidenceIds: string[] }> {
  if (assertion.kind === "file_present" || assertion.kind === "file_absent" || assertion.kind === "file_sha256") {
    const located = await inspectPath(root, assertion.path);
    const evidenceIds = located.exists
      ? [evidenceIdForPath("verification.json"), evidenceIdForPath(assertion.path)]
      : [evidenceIdForPath("verification.json")];
    if (assertion.kind === "file_absent") {
      return {
        status: located.exists ? "failed" : "passed",
        note: located.exists ? "Captured target exists" : "Captured target is absent",
        evidenceIds,
      };
    }
    if (!located.exists) return { status: "failed", note: "Captured artifact is missing", evidenceIds };
    if (assertion.kind === "file_present") {
      return { status: "passed", note: "Captured artifact exists", evidenceIds };
    }
    const digest = createHash("sha256").update(await readFile(located.absolute)).digest("hex");
    return {
      status: digest === assertion.sha256?.toLowerCase() ? "passed" : "failed",
      note: digest === assertion.sha256?.toLowerCase() ? "Captured artifact digest matches" : "Captured artifact digest differs",
      evidenceIds,
    };
  }
  if (assertion.kind === "json_equals") {
    const document = await readJson(root, assertion.path);
    const actual = selectPointer(document, assertion.pointer);
    const passed = actual.found && isDeepStrictEqual(actual.value, assertion.expected);
    return {
      status: passed ? "passed" : "failed",
      note: passed ? "Captured JSON field matches" : "Captured JSON field is missing or differs",
      evidenceIds: [evidenceIdForPath("verification.json"), evidenceIdForPath(assertion.path)],
    };
  }

  if (assertion.kind !== "json_compare") throw new Error("Unsupported assertion kind");

  const left = selectPointer(await readJson(root, assertion.left.path), assertion.left.pointer);
  const right = selectPointer(await readJson(root, assertion.right.path), assertion.right.pointer);
  const equal = left.found && right.found && isDeepStrictEqual(left.value, right.value);
  const passed = left.found && right.found &&
    (assertion.operator === "equal" ? equal : !equal);
  return {
    status: passed ? "passed" : "failed",
    note: passed ? "Captured JSON values satisfy comparison" : "Captured JSON values are missing or differ from comparison",
    evidenceIds: [
      evidenceIdForPath("verification.json"),
      evidenceIdForPath(assertion.left.path),
      evidenceIdForPath(assertion.right.path),
    ],
  };
}

/**
 * Check operator-supplied expectations against captured artifacts. This does not
 * establish that a snapshot reflects the live workspace or that a model answer
 * is correct; required human checks in the case registry cover those questions.
 */
export async function verifyCase(caseId: string, attemptDirectory: string): Promise<AcceptanceCheck[]> {
  const definition = getAcceptanceCase(caseId);
  if (!definition) throw new Error(`Unknown acceptance case: ${caseId}`);
  const root = resolve(attemptDirectory);
  let assertions: Assertion[] | null = null;
  let manifestError: string | null = null;
  try {
    const manifestPath = await inspectPath(root, "verification.json");
    if (manifestPath.exists) {
      const manifest = JSON.parse(await readFile(manifestPath.absolute, "utf8")) as unknown;
      if (!isObject(manifest) || manifest.schemaVersion !== 1 || manifest.caseId !== caseId ||
        !Array.isArray(manifest.assertions)) {
        throw new Error("verification.json must contain schemaVersion 1, matching caseId, and assertions");
      }
      assertions = manifest.assertions.map(parseAssertion);
      const ids = assertions.map((assertion) => assertion.checkId);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate assertion checkId");
      if (ids.some((id) => !definition.checks.some((check) => check.id === id && check.method === "automatic"))) {
        throw new Error("Assertion refers to an unknown or human check");
      }
    }
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }

  const checks: AcceptanceCheck[] = [];
  for (const check of definition.checks) {
    const base = { id: check.id, method: check.method, required: check.required };
    if (check.method === "human") {
      checks.push({ ...base, status: "not_run", evidenceIds: [], note: check.description });
      continue;
    }
    if (manifestError) {
      checks.push({ ...base, status: "blocked", evidenceIds: [], note: `Invalid evidence manifest: ${manifestError}` });
      continue;
    }
    const assertion = assertions?.find((item) => item.checkId === check.id);
    if (!assertion) {
      checks.push({ ...base, status: "not_run", evidenceIds: [], note: `No assertion supplied for ${check.id}` });
      continue;
    }
    if (!check.assertionKinds?.includes(assertion.kind as AssertionKind)) {
      checks.push({ ...base, status: "blocked", evidenceIds: [], note: `Assertion kind is not valid for ${check.id}` });
      continue;
    }
    try {
      assertCaseExpectation(check.id, assertion);
      checks.push({ ...base, ...await evaluate(root, assertion) });
    } catch (error) {
      checks.push({ ...base, status: "blocked", evidenceIds: [], note: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}
