import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentDefinition, AgentLimits } from "@serika/core";
import { z } from "zod";

export type SkillKind = "text" | "memory-consolidate";

export interface SkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly kind: SkillKind;
  readonly instructions: string;
  readonly hash: string;
  readonly tools: readonly string[];
  readonly limits: Readonly<AgentLimits>;
  readonly agentId: string;
}

export interface SkillPackageRegistration {
  id: string;
  directory: string;
  expectedHash?: string | undefined;
}

export interface BuiltinSkillInput {
  id: string;
  description: string;
  kind: SkillKind;
  instructions: string;
  tools?: readonly string[];
  limits?: Partial<AgentLimits>;
  agentId?: string;
  /** Host-owned memory extraction only; external packages cannot request this workflow. */
  hostExtraction?: boolean;
}

export const SKILL_PACKAGE_MAX_COUNT = 32;
export const SKILL_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
export const SKILL_MANIFEST_MAX_BYTES = 16 * 1024;

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const limitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(4).optional(),
  totalTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  stepTimeoutMs: z.number().int().min(1).max(30_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(8192).optional(),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  description: z.string().min(1).max(512).refine(value => value.trim().length > 0),
  kind: z.enum(["text", "memory-consolidate"]),
  tools: z.array(z.string()).max(2).optional(),
  limits: limitsSchema.optional(),
}).strict();
export const skillPackageRegistrationsSchema = z.array(z.object({
  id: idSchema,
  directory: z.string().min(1).refine(value => isAbsolute(value) && !value.includes("\0"),
    "Skill directory must be an explicit absolute path"),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/, "Expected Skill hash must be a SHA-256 hex digest").optional(),
}).strict()).max(SKILL_PACKAGE_MAX_COUNT);
const MEMORY_TOOLS = ["memory_prepare_consolidation", "memory_stage_candidates"] as const;

function descriptor(manifest: z.infer<typeof manifestSchema>, instructions: string, agentId: string, hostExtraction = false): SkillDescriptor {
  if (instructions.trim().length === 0 || Buffer.byteLength(instructions, "utf8") > SKILL_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(`Skill ${manifest.id}: instructions must be nonempty and at most ${SKILL_INSTRUCTIONS_MAX_BYTES} bytes`);
  }
  const tools: string[] = manifest.kind === "text" || hostExtraction ? [] : [...MEMORY_TOOLS];
  if (manifest.tools !== undefined && (manifest.tools.length !== tools.length ||
    new Set(manifest.tools).size !== tools.length || manifest.tools.some(tool => !tools.includes(tool)))) {
    throw new Error(`Skill ${manifest.id}: ${manifest.kind} cannot request additional tools; expected ${tools.join(", ") || "no tools"}`);
  }
  const maxSteps = manifest.limits?.maxSteps ?? (manifest.kind === "text" ? 4 : 3);
  if (manifest.kind === "memory-consolidate" && maxSteps > 3) {
    throw new Error(`Skill ${manifest.id}: memory-consolidate maxSteps cannot exceed 3`);
  }
  const limits: AgentLimits = {
    maxSteps,
    totalTimeoutMs: manifest.limits?.totalTimeoutMs ?? 120_000,
    stepTimeoutMs: manifest.limits?.stepTimeoutMs ?? 30_000,
    ...(manifest.limits?.maxOutputTokens === undefined ? {} : { maxOutputTokens: manifest.limits.maxOutputTokens }),
  };
  // Fixed property order and host-derived tools/limits make JSON formatting and
  // manifest key order irrelevant, while binding every execution input.
  const hash = createHash("sha256").update(JSON.stringify({
    version: 1, id: manifest.id, description: manifest.description,
    kind: manifest.kind, tools, limits, instructions,
  }), "utf8").digest("hex");
  return Object.freeze({ id: manifest.id, description: manifest.description, kind: manifest.kind,
    instructions, hash, tools: Object.freeze(tools), limits: Object.freeze(limits), agentId });
}

/** Host-owned instruction strings only; this creates no runtime or tool implementation. */
export function createBuiltinSkill(input: BuiltinSkillInput): SkillDescriptor {
  const manifest = manifestSchema.parse({ version: 1, id: input.id, description: input.description,
    kind: input.kind, ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.limits === undefined ? {} : { limits: input.limits }) });
  const agentId = input.agentId ?? `skill:${manifest.id}`;
  if (agentId.trim().length === 0 || agentId.length > 128) throw new Error("Invalid Skill agentId");
  if (input.hostExtraction && (input.kind !== "memory-consolidate" || input.limits?.maxSteps !== 1)) throw new Error("Host extraction requires a one-step memory Skill");
  return descriptor(manifest, input.instructions, agentId, input.hostExtraction);
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

async function readBoundedFile(directory: string, name: string, maxBytes: number): Promise<string> {
  const path = join(directory, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Skill ${name} must be a regular non-symlink file`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw new Error(`Skill ${name} exceeds ${maxBytes} bytes or is not a regular file`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new Error(`Skill ${name} exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally {
    await handle.close();
  }
}

/**
 * The caller must supply registrations from trusted external configuration.
 * There is no workspace discovery: at most two bounded files per registration
 * are read, and scripts, assets and other package contents are never loaded.
 * Parent symlinks (e.g. macOS /tmp) are canonicalized; package/file symlinks are rejected.
 */
export async function loadSkillPackages(
  registrations: readonly SkillPackageRegistration[],
  authorizedDirectory: string,
): Promise<SkillDescriptor[]> {
  const parsed = skillPackageRegistrationsSchema.parse(registrations);
  const ids = new Set<string>();
  for (const registration of parsed) {
    if (ids.has(registration.id)) throw new Error(`Duplicate Skill id: ${registration.id}`);
    ids.add(registration.id);
  }
  if (parsed.length === 0) return [];
  const workspace = await realpath(authorizedDirectory);
  const skills: SkillDescriptor[] = [];
  for (const registration of parsed) {
    try {
      const requestedDirectory = resolve(registration.directory);
      if (inside(resolve(authorizedDirectory), requestedDirectory)) throw new Error("Skill packages must be outside the workspace");
      const info = await lstat(requestedDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill directory must be a non-symlink directory");
      const directory = await realpath(requestedDirectory);
      if (inside(workspace, directory)) throw new Error("Skill packages must be outside the workspace");
      const manifest = manifestSchema.parse(JSON.parse(await readBoundedFile(directory, "skill.json", SKILL_MANIFEST_MAX_BYTES)) as unknown);
      if (manifest.id !== registration.id) throw new Error(`Manifest id ${manifest.id} does not match registered id ${registration.id}`);
      const instructions = await readBoundedFile(directory, "SKILL.md", SKILL_INSTRUCTIONS_MAX_BYTES);
      const skill = descriptor(manifest, instructions, `skill:${manifest.id}`);
      if (registration.expectedHash !== undefined && skill.hash !== registration.expectedHash) {
        throw new Error(`Skill hash mismatch: expected ${registration.expectedHash}, received ${skill.hash}`);
      }
      skills.push(skill);
    } catch (error) {
      throw new Error(`Cannot load Skill ${registration.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return skills;
}

/** Adapt instructions to the existing AgentLoop; context/tools are never inherited. */
export function skillAgentDefinition(skill: SkillDescriptor, modelAlias: string): AgentDefinition {
  return { id: skill.agentId, version: skill.hash, instructions: skill.instructions,
    model: modelAlias, tools: [...skill.tools], limits: { ...skill.limits } };
}
