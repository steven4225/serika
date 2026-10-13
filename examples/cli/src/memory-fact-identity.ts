/** Small optional identity vocabulary, not semantic proof or a second fact store. */
export interface MemoryFactIdentity {
  attribute: "response_language" | "review_format" | "coffee" | "residence";
  /** Legacy general/work/personal, or an exact bounded scene label from the user. */
  scenario: string;
  value: string;
}
const values: Partial<Record<MemoryFactIdentity["attribute"], readonly string[]>> = {
  response_language: ["zh", "en", "bilingual"],
  review_format: ["conclusion_first", "steps_first", "detailed"],
  coffee: ["unsweetened", "sweetened", "black", "none"],
};
export function validateFactIdentity(raw: unknown): MemoryFactIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Fact identity must be an object");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || Object.keys(input).some(key => !["attribute", "scenario", "value"].includes(key)) || !["response_language", "review_format", "coffee", "residence"].includes(String(input.attribute)) || typeof input.scenario !== "string" || !input.scenario.trim() || Buffer.byteLength(input.scenario) > 96 || /[\r\n\u0000]/.test(input.scenario) || typeof input.value !== "string") throw new Error("Unsupported fact identity");
  const value = input.value.normalize("NFKC").trim().toLowerCase();
  const attribute = input.attribute as MemoryFactIdentity["attribute"];
  if (!value || Buffer.byteLength(value) > 96 || values[attribute] && !values[attribute]!.includes(value)) throw new Error("Unsupported fact identity value");
  return { attribute, scenario: input.scenario.trim(), value };
}
export function sameFactSlot(left: MemoryFactIdentity | undefined, right: MemoryFactIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.attribute === right.attribute && left.scenario === right.scenario;
}
export function sameFact(left: MemoryFactIdentity | undefined, right: MemoryFactIdentity | undefined): boolean {
  return sameFactSlot(left, right) && left!.value === right!.value;
}
