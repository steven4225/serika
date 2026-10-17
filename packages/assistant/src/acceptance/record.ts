import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AcceptanceCaseResult, AcceptanceCheck } from "./contracts.js";
import { deriveCaseStatus } from "./contracts.js";
import { listAcceptanceCases } from "./cases.js";
import { writeAcceptanceReport } from "./report.js";
import { evidenceIdForPath, verifyCase } from "./verify.js";

const execFileAsync = promisify(execFile);

const reviewSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: z.string().min(1),
  attemptId: z.string().min(1),
  baseline: z.object({
    commit: z.string().min(1),
    dirty: z.boolean(),
    configDigest: z.string().min(1),
  }).strict(),
  modelId: z.string().min(1).nullable(),
  execution: z.object({
    entry: z.enum(["tui", "worker", "runtime_test"]),
    model: z.enum(["real", "mock"]),
    network: z.enum(["live", "controlled", "unused"]),
  }).strict(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  runIds: z.array(z.string().min(1)).default([]),
  threadIds: z.array(z.string().min(1)).default([]),
  humanChecks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["passed", "failed", "blocked", "not_run"]),
    evidenceIds: z.array(z.string().min(1)).default([]),
    note: z.string().default(""),
  }).strict()).default([]),
  evidence: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["terminal", "transcript", "artifact", "store_snapshot", "request_counter"]),
    path: z.string().min(1),
    sha256: z.string().optional(),
  }).strict()).default([]),
  failure: z.object({
    layer: z.enum(["configuration", "model", "tool", "persistence", "feedback", "verification", "unknown"]),
    code: z.string().optional(),
    message: z.string().min(1),
  }).strict().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).strict().nullable().default(null).refine(
    (value) => value === null || Object.values(value).some((count) => count !== undefined),
    "Use null when model usage is unavailable",
  ),
}).strict();

function redactConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfiguration);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [
    key,
    /key|token|secret|password|authorization/i.test(key) ? "<redacted>" : redactConfiguration(item),
  ]));
}

async function configurationDigest(configPath?: string): Promise<string> {
  if (configPath === undefined) return "none";
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return `sha256:${createHash("sha256").update(JSON.stringify(redactConfiguration(config))).digest("hex")}`;
}

function applyHumanReview(
  checks: AcceptanceCheck[],
  reviews: z.infer<typeof reviewSchema>["humanChecks"],
): AcceptanceCheck[] {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  if (byId.size !== reviews.length) throw new Error("Duplicate human check id in review.json");
  for (const review of reviews) {
    if (!checks.some((check) => check.id === review.id && check.method === "human")) {
      throw new Error(`Unknown or non-human check in review.json: ${review.id}`);
    }
  }
  return checks.map((check) => {
    const review = check.method === "human" ? byId.get(check.id) : undefined;
    return review === undefined ? check : {
      ...check,
      status: review.status,
      evidenceIds: review.evidenceIds,
      note: review.note,
    };
  });
}

async function readAttemptJson(attempt: string, name: "review.json" | "verification.json"): Promise<unknown> {
  const path = join(attempt, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function automaticEvidencePaths(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null ||
      !("assertions" in manifest) || !Array.isArray(manifest.assertions)) return [];
  const paths = ["verification.json"];
  for (const assertion of manifest.assertions as unknown[]) {
    if (typeof assertion !== "object" || assertion === null) continue;
    const fields = assertion as Record<string, unknown>;
    if (typeof fields.path === "string") paths.push(fields.path);
    for (const side of ["left", "right"] as const) {
      const value = fields[side];
      if (typeof value === "object" && value !== null &&
          "path" in value && typeof value.path === "string") {
        paths.push(value.path);
      }
    }
  }
  return paths;
}

/** Finalize one operator-created attempt after the task and evidence capture. */
export async function recordAcceptanceAttempt(
  attemptDirectory: string,
): Promise<AcceptanceCaseResult> {
  const attempt = resolve(attemptDirectory);
  const review = reviewSchema.parse(await readAttemptJson(attempt, "review.json"));
  if (basename(attempt) !== review.attemptId || basename(dirname(attempt)) !== review.caseId) {
    throw new Error("Attempt directory must be <output>/<caseId>/<attemptId>");
  }
  const checks = await verifyCase(review.caseId, attempt);
  const reviewedChecks = applyHumanReview(checks, review.humanChecks);
  let manifest: unknown;
  if (checks.some((check) => check.method === "automatic" && check.evidenceIds.length > 0)) {
    manifest = await readAttemptJson(attempt, "verification.json");
  }
  const referencedAutomaticIds = new Set(checks.flatMap((check) => check.evidenceIds));
  const automaticEvidence = automaticEvidencePaths(manifest)
    .filter((path) => referencedAutomaticIds.has(evidenceIdForPath(path)))
    .map((path) => ({
      id: evidenceIdForPath(path),
      kind: "store_snapshot" as const,
      path,
    }));
  const reviewEvidence = review.evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    path: item.path,
    ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
  }));
  const evidence = [...reviewEvidence];
  for (const item of automaticEvidence) {
    const existing = evidence.find((candidate) => candidate.id === item.id);
    if (existing !== undefined && existing.path !== item.path) {
      throw new Error(`Evidence id ${item.id} conflicts with the verified path`);
    }
    if (existing === undefined) evidence.push(item);
  }
  const finishedAt = review.finishedAt ?? new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(review.startedAt);
  if (durationMs < 0) throw new Error("finishedAt must be no earlier than startedAt");
  const result: AcceptanceCaseResult = {
    schemaVersion: 1,
    caseId: review.caseId,
    attemptId: review.attemptId,
    baseline: { ...review.baseline, modelId: review.modelId },
    execution: review.execution,
    startedAt: review.startedAt,
    finishedAt,
    runIds: review.runIds,
    threadIds: review.threadIds,
    status: deriveCaseStatus(reviewedChecks),
    checks: reviewedChecks,
    evidence,
    ...(review.failure === undefined ? {} : {
      failure: {
        layer: review.failure.layer,
        message: review.failure.message,
        ...(review.failure.code === undefined ? {} : { code: review.failure.code }),
      },
    }),
    durationMs,
    usage: review.usage === null ? null : {
      ...(review.usage.inputTokens === undefined ? {} : { inputTokens: review.usage.inputTokens }),
      ...(review.usage.outputTokens === undefined ? {} : { outputTokens: review.usage.outputTokens }),
      ...(review.usage.totalTokens === undefined ? {} : { totalTokens: review.usage.totalTokens }),
    },
  };
  await writeAcceptanceReport(result, dirname(dirname(attempt)));
  return result;
}

export async function startAcceptanceAttempt(input: {
  outputDirectory: string;
  caseId: string;
  attemptId: string;
  modelId: string | null;
  entry: AcceptanceCaseResult["execution"]["entry"];
  model: AcceptanceCaseResult["execution"]["model"];
  network: AcceptanceCaseResult["execution"]["network"];
  configPath?: string;
  repositoryDirectory?: string;
}): Promise<string> {
  if (!listAcceptanceCases().some((item) => item.id === input.caseId)) {
    throw new Error(`Unknown acceptance case: ${input.caseId}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.attemptId)) {
    throw new Error("attemptId must be a short alphanumeric name");
  }
  const repository = resolve(input.repositoryDirectory ?? process.cwd());
  const [head, status, configDigest] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository }),
    execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repository }),
    configurationDigest(input.configPath),
  ]);
  const caseDirectory = join(resolve(input.outputDirectory), input.caseId);
  const attemptDirectory = join(caseDirectory, input.attemptId);
  await mkdir(caseDirectory, { recursive: true });
  await mkdir(attemptDirectory);
  const review = {
    schemaVersion: 1,
    caseId: input.caseId,
    attemptId: input.attemptId,
    baseline: {
      commit: head.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
      configDigest,
    },
    modelId: input.modelId,
    execution: { entry: input.entry, model: input.model, network: input.network },
    startedAt: new Date().toISOString(),
    runIds: [],
    threadIds: [],
    humanChecks: [],
    evidence: [],
    usage: null,
  };
  await writeFile(join(attemptDirectory, "review.json"), `${JSON.stringify(review, null, 2)}\n`, { flag: "wx" });
  return attemptDirectory;
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "start" && (args.length === 8 || args.length === 9)) {
    const [, outputDirectory, caseId, attemptId, modelId, entry, model, network, configPath] = args;
    const attempt = await startAcceptanceAttempt({
      outputDirectory: outputDirectory!, caseId: caseId!, attemptId: attemptId!,
      modelId: modelId === "none" ? null : modelId!,
      entry: z.enum(["tui", "worker", "runtime_test"]).parse(entry),
      model: z.enum(["real", "mock"]).parse(model),
      network: z.enum(["live", "controlled", "unused"]).parse(network),
      ...(configPath === undefined ? {} : { configPath }),
    });
    process.stdout.write(`${attempt}\n`);
    return;
  }
  if (args[0] === "finish" && args.length === 2) {
    const result = await recordAcceptanceAttempt(args[1]!);
    process.stdout.write(`${result.caseId}/${result.attemptId}: ${result.status}\n`);
    return;
  }
  throw new Error("Usage: record.js start <output-root> <case-id> <attempt-id> <model-id|none> <tui|worker|runtime_test> <real|mock> <live|controlled|unused> [config.json] | finish <attempt-directory>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
