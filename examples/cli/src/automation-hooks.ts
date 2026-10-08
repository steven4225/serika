import { z } from "zod";

export const HOOK_EVENTS = ["thread.ready", "primary.completed"] as const;
export const MAX_HOOK_RULES = 32;

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a non-empty identifier",
});

const hookRuleSchema = z.object({
  id: nonEmptyString,
  event: z.enum(HOOK_EVENTS),
  enabled: z.boolean().optional(),
  match: z.object({
    phase: z.enum(["primary", "consolidation"]).optional(),
    status: z.enum(["completed", "failed", "cancelled", "timed_out"]).optional(),
    agentId: nonEmptyString.optional(),
  }).strict().optional(),
  handler: z.object({ type: z.literal("skill"), id: nonEmptyString }).strict(),
}).strict().superRefine((rule, context) => {
  if (rule.event === "thread.ready") {
    for (const key of ["phase", "status"] as const) {
      if (rule.match?.[key] !== undefined) {
        context.addIssue({
          code: "custom", path: ["match", key],
          message: `thread.ready cannot match ${key}`,
        });
      }
    }
  } else {
    if (rule.match?.phase !== undefined && rule.match.phase !== "primary") {
      context.addIssue({
        code: "custom", path: ["match", "phase"],
        message: "primary.completed can only match phase primary",
      });
    }
    if (rule.match?.status !== undefined && rule.match.status !== "completed") {
      context.addIssue({
        code: "custom", path: ["match", "status"],
        message: "primary.completed can only match status completed",
      });
    }
  }
});

/** Configuration is explicit: [] disables hooks; this schema supplies no defaults. */
export const hooksConfigSchema = z.array(hookRuleSchema).max(MAX_HOOK_RULES)
  .superRefine((rules, context) => {
    const ids = new Set<string>();
    rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom", path: [index, "id"],
          message: `Duplicate hook rule id: ${rule.id}`,
        });
      }
      ids.add(rule.id);
    });
  });

export type HookRule = z.infer<typeof hookRuleSchema>;

/** Host-owned lifecycle data, not a Core event or persisted execution record. */
export interface HookEvent {
  event: (typeof HOOK_EVENTS)[number];
  threadId: string;
  runId?: string;
  agentId?: string;
  phase?: "primary" | "consolidation";
  status?: "completed" | "failed" | "cancelled" | "timed_out";
}

export interface HookRequest {
  ruleId: string;
  skillId: string;
  event: HookEvent;
}

export interface CompiledHookRules {
  readonly rules: readonly (HookRule & { enabled: boolean })[];
  selectHookRequests(event: HookEvent): HookRequest[];
}

/** Validate once and snapshot the registry; dispatch/admission stay with the host. */
export function compileHookRules(
  rules: readonly HookRule[],
  knownSkills: ReadonlySet<string> | readonly string[],
): CompiledHookRules {
  const registered = new Set(knownSkills);
  const normalized = hooksConfigSchema.parse(rules).map((rule) => {
    if (!registered.has(rule.handler.id)) {
      throw new Error(`Unknown hook skill ${rule.handler.id} in rule ${rule.id}`);
    }
    return Object.freeze({
      ...rule,
      enabled: rule.enabled ?? true,
      ...(rule.match === undefined ? {} : { match: Object.freeze(rule.match) }),
      handler: Object.freeze(rule.handler),
    });
  });
  return {
    rules: Object.freeze(normalized),
    selectHookRequests(event) {
      // Auxiliary/failed runs can never masquerade as primary completion,
      // even if a configured rule omits a matcher.
      if (event.event === "primary.completed"
        && (event.phase !== "primary" || event.status !== "completed")) return [];
      return normalized.filter((rule) => rule.enabled && rule.event === event.event
        && (rule.match?.phase === undefined || rule.match.phase === event.phase)
        && (rule.match?.status === undefined || rule.match.status === event.status)
        && (rule.match?.agentId === undefined || rule.match.agentId === event.agentId))
        .map((rule) => ({ ruleId: rule.id, skillId: rule.handler.id, event: { ...event } }));
    },
  };
}

/** Legacy memory lifecycle defaults, only installed by the host when config is absent. */
export function builtinMemoryHookRules(skillId: string, agentId = "calculator"): HookRule[] {
  return hooksConfigSchema.parse([
    { id: "memory.thread-ready", event: "thread.ready", handler: { type: "skill", id: skillId } },
    {
      id: "memory.primary-completed", event: "primary.completed",
      match: { phase: "primary", status: "completed", agentId },
      handler: { type: "skill", id: skillId },
    },
  ]);
}
