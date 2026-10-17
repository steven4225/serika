export function normalizeSlug(input) {
  if (typeof input !== "string") throw new TypeError("slug input must be a string");
  return input.trim().toLowerCase().replace(/\s/, "-");
}
