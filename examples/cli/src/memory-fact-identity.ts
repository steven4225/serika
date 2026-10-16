/** Small optional identity vocabulary, not semantic proof or a second fact store. */
export interface LegacyMemoryFactIdentity {
  attribute: "response_language" | "review_format" | "coffee" | "residence";
  /** Legacy general/work/personal, or an exact bounded scene label from the user. */
  scenario: string;
  value: string;
}
export interface EverydayMemoryFactIdentity {
  version: 2;
  subject: "user";
  attribute: "diet_spiciness" | "notification_channel";
  scenario: string;
  value: string;
}
/** Literal, source-backed model classification; never semantic proof or authority. */
export interface GenericMemoryFactIdentity {
  version: 3;
  subject: string;
  attribute: string;
  scenario: string;
  value: string;
}
export type MemoryFactIdentity = LegacyMemoryFactIdentity | EverydayMemoryFactIdentity | GenericMemoryFactIdentity;
const values: Partial<Record<MemoryFactIdentity["attribute"], readonly string[]>> = {
  response_language: ["zh", "en", "bilingual"],
  review_format: ["conclusion_first", "steps_first", "detailed"],
  coffee: ["unsweetened", "sweetened", "black", "none"],
  diet_spiciness: ["none", "mild", "medium", "hot"],
  notification_channel: ["in_app", "system", "telegram"],
};
export function validateFactIdentity(raw: unknown): MemoryFactIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Fact identity must be an object");
  const input = raw as Record<string, unknown>;
  if (input.version === 3) {
    if (["response_language", "review_format", "coffee", "residence", "diet_spiciness", "notification_channel"].includes(String(input.attribute))) throw new Error("Keep existing fact identity versions");
    const fields = ["version", "subject", "attribute", "scenario", "value"];
    if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) ||
      fields.slice(1).some(key => typeof input[key] !== "string" || !(input[key] as string).trim() ||
        Buffer.byteLength(input[key] as string) > 96 || /[\r\n\u0000]/.test(input[key] as string))) throw new Error("Unsupported generic fact identity");
    return { version: 3, subject: (input.subject as string).trim(), attribute: (input.attribute as string).trim(),
      scenario: (input.scenario as string).trim(), value: (input.value as string).trim() };
  }
  const versioned = input.version === 2;
  const fields = versioned ? ["version", "subject", "attribute", "scenario", "value"] : ["attribute", "scenario", "value"];
  const attributes = versioned ? ["diet_spiciness", "notification_channel"] : ["response_language", "review_format", "coffee", "residence"];
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) ||
    versioned && input.subject !== "user" || !attributes.includes(String(input.attribute)) ||
    typeof input.scenario !== "string" || !input.scenario.trim() || Buffer.byteLength(input.scenario) > 96 || /[\r\n\u0000]/.test(input.scenario) || typeof input.value !== "string") throw new Error("Unsupported fact identity");
  const value = input.value.normalize("NFKC").trim().toLowerCase();
  const attribute = input.attribute as MemoryFactIdentity["attribute"];
  if (!value || Buffer.byteLength(value) > 96 || values[attribute] && !values[attribute]!.includes(value)) throw new Error("Unsupported fact identity value");
  return versioned ? { version: 2, subject: "user", attribute: attribute as EverydayMemoryFactIdentity["attribute"], scenario: input.scenario.trim(), value }
    : { attribute: attribute as LegacyMemoryFactIdentity["attribute"], scenario: input.scenario.trim(), value };
}
export function sameFactSlot(left: MemoryFactIdentity | undefined, right: MemoryFactIdentity | undefined): boolean {
  return left !== undefined && right !== undefined &&
    ("version" in left ? left.version : 1) === ("version" in right ? right.version : 1) &&
    ("subject" in left ? left.subject : "user") === ("subject" in right ? right.subject : "user") &&
    left.attribute === right.attribute && left.scenario === right.scenario;
}
export function sameFact(left: MemoryFactIdentity | undefined, right: MemoryFactIdentity | undefined): boolean {
  return sameFactSlot(left, right) && left!.value === right!.value;
}
