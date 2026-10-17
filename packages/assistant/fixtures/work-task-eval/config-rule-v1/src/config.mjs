export function parseConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("config must be an object");
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  const mode = input.mode === undefined ? "brief" : input.mode;
  if (mode !== "brief" && mode !== "full") throw new TypeError("mode must be brief or full");
  return { enabled, mode };
}
