import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

export const WEB_FETCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_MAX_RESPONSE_BYTES = 512 * 1024;
export const WEB_FETCH_MAX_TEXT_BYTES = 64 * 1024;

export const webFetchErrorCodes = [
  "INVALID_URL",
  "TARGET_BLOCKED",
  "REDIRECT_LIMIT",
  "ORIGIN_NOT_AUTHORIZED",
  "HTTP_STATUS",
  "UNSUPPORTED_CONTENT_TYPE",
  "TIMEOUT",
  "NETWORK_ERROR",
] as const;
export type WebFetchErrorCode = (typeof webFetchErrorCodes)[number];

export interface WebFetchInput {
  url: string;
}

export interface WebFetchSuccess {
  ok: true;
  value: {
    requestedUrl: string;
    finalUrl: string;
    status: number;
    contentType: string;
    fetchedAt: string;
    text: string;
    truncated: boolean;
  };
}

export interface WebFetchFailure {
  ok: false;
  error: {
    code: WebFetchErrorCode;
    message: string;
    status?: number;
    finalUrl?: string;
  };
}

export type WebFetchResult = WebFetchSuccess | WebFetchFailure;

export const webFetchInputSchema: z.ZodType<WebFetchInput> = z
  .object({ url: z.string().min(1) })
  .strict();

export const webFetchResultSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({
      ok: z.literal(true),
      value: z.object({
        requestedUrl: z.string(),
        finalUrl: z.string(),
        status: z.number().int(),
        contentType: z.string(),
        fetchedAt: z.string(),
        text: z.string(),
        truncated: z.boolean(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: z.enum(webFetchErrorCodes),
        message: z.string(),
        status: z.number().int().optional(),
        finalUrl: z.string().optional(),
      }),
    }),
  ],
);

export type ResolveWebHost = (
  hostname: string,
  options: { all: true; verbatim: true; signal: AbortSignal },
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export interface WebFetchOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  now?: () => Date;
  resolveHost?: ResolveWebHost;
  /** Test helper for redirect pinning. TUI Run authorization must not use this. */
  allowedOrigins?: readonly string[];
  /** Test-only override; production callers use the 20 second default. */
  timeoutMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function failure(
  code: WebFetchErrorCode,
  message: string,
  details: { status?: number; finalUrl?: string } = {},
): WebFetchFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details.status === undefined ? {} : { status: details.status }),
      ...(details.finalUrl === undefined ? {} : { finalUrl: details.finalUrl }),
    },
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function parseIpv6(value: string): readonly number[] | undefined {
  let input = value.toLowerCase();
  const zoneIndex = input.indexOf("%");
  if (zoneIndex >= 0) input = input.slice(0, zoneIndex);
  const sections = input.split("::");
  if (sections.length > 2) return undefined;

  const parseSection = (section: string): number[] | undefined => {
    if (section === "") return [];
    const values: number[] = [];
    for (const part of section.split(":")) {
      if (part.includes(".")) {
        const bytes = parseIpv4(part);
        if (bytes === undefined) return undefined;
        values.push(
          ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
          ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
        );
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        values.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return values;
  };

  const left = parseSection(sections[0] ?? "");
  const right = parseSection(sections.length === 2 ? sections[1] ?? "" : "");
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || missing < 0) return undefined;
  return [
    ...left,
    ...(sections.length === 2 ? Array.from({ length: missing }, () => 0) : []),
    ...right,
  ];
}

function ipv4InRange(bytes: readonly number[], base: readonly number[], mask: number): boolean {
  const value =
    ((bytes[0] ?? 0) << 24) |
    ((bytes[1] ?? 0) << 16) |
    ((bytes[2] ?? 0) << 8) |
    (bytes[3] ?? 0);
  const baseValue =
    ((base[0] ?? 0) << 24) |
    ((base[1] ?? 0) << 16) |
    ((base[2] ?? 0) << 8) |
    (base[3] ?? 0);
  const bitMask = mask === 0 ? 0 : (-1 << (32 - mask)) | 0;
  return (value & bitMask) === (baseValue & bitMask);
}

function ipv6Prefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 1) {
    const value = (bytes[Math.floor(bit / 8)] ?? 0) & (0x80 >> (bit % 8));
    const expected = (prefix[Math.floor(bit / 8)] ?? 0) & (0x80 >> (bit % 8));
    if ((value !== 0) !== (expected !== 0)) return false;
  }
  return true;
}

function ipv6IsUnspecified(bytes: readonly number[]): boolean {
  return bytes.every((byte) => byte === 0);
}

function ipv6IsLoopback(bytes: readonly number[]): boolean {
  return bytes.slice(0, 7).every((word) => word === 0) && bytes[7] === 1;
}

function isPrivateIp(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    const ranges: readonly [number, number, number, number, number][] = [
      [0, 0, 0, 0, 8],
      [10, 0, 0, 0, 8],
      [100, 64, 0, 0, 10],
      [127, 0, 0, 0, 8],
      [169, 254, 0, 0, 16],
      [172, 16, 0, 0, 12],
      [192, 0, 0, 0, 24],
      [192, 0, 2, 0, 24],
      [192, 168, 0, 0, 16],
      [198, 18, 0, 0, 15],
      [198, 51, 100, 0, 24],
      [203, 0, 113, 0, 24],
      [224, 0, 0, 0, 4],
      [240, 0, 0, 0, 4],
    ];
    return ranges.some(([a, b, c, d, mask]) => ipv4InRange(ipv4, [a, b, c, d], mask));
  }

  if (isIP(address) !== 6) return false;
  const ipv6 = parseIpv6(address);
  if (ipv6 === undefined) return true;
  const bytes = ipv6.flatMap((word) => [word >> 8, word & 0xff]);
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped && isPrivateIp(bytes.slice(12).join("."))) return true;
  return (
    ipv6IsUnspecified(ipv6) ||
    ipv6IsLoopback(ipv6) ||
    ipv6Prefix(bytes, [0xfc], 7) ||
    ipv6Prefix(bytes, [0xfe, 0x80], 10) ||
    ipv6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) ||
    bytes[0] === 0xff
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata" ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.google" ||
    normalized.endsWith(".internal")
  );
}

function validateUrl(value: unknown): URL | WebFetchFailure {
  if (typeof value !== "string" || value.trim() === "") {
    return failure("INVALID_URL", "URL must be a non-empty HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure("INVALID_URL", "URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failure("INVALID_URL", "Only http:// and https:// URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    return failure("INVALID_URL", "URL credentials are not allowed");
  }
  if (isBlockedHostname(url.hostname) || isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) {
    return failure("TARGET_BLOCKED", "The URL targets a local or private host");
  }
  return url;
}

async function assertPublicTarget(
  url: URL,
  signal: AbortSignal,
  resolveHost: ResolveWebHost,
): Promise<WebFetchFailure | undefined> {
  if (isBlockedHostname(url.hostname)) {
    return failure("TARGET_BLOCKED", "The URL targets a local or private host", {
      finalUrl: url.toString(),
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateIp(host)) {
    return failure("TARGET_BLOCKED", "The URL targets a local or private host", {
      finalUrl: url.toString(),
    });
  }
  if (isIP(host) !== 0) return undefined;
  let addresses: readonly { address: string; family: 4 | 6 }[];
  try {
    addresses = await resolveHost(host, { all: true, verbatim: true, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return failure("NETWORK_ERROR", "Could not resolve the URL host", {
      finalUrl: url.toString(),
    });
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    return failure("TARGET_BLOCKED", "The URL resolves to a local or private host", {
      finalUrl: url.toString(),
    });
  }
  return undefined;
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = WEB_FETCH_MAX_RESPONSE_BYTES - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, Math.max(0, remaining)));
        total = WEB_FETCH_MAX_RESPONSE_BYTES;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|header|footer)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function isSupportedContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/json" ||
    contentType === "application/xml"
  );
}

function contentTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function isTimeoutError(error: unknown, timeoutSignal: AbortSignal): boolean {
  return timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError");
}

function isAllowedOrigin(url: URL, allowedOrigins: readonly string[] | undefined): boolean {
  return allowedOrigins === undefined || allowedOrigins.includes(url.origin);
}

/** Fetch one public HTTP(S) URL, following and re-validating up to five redirects. */
export async function fetchWebPage(
  input: WebFetchInput,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const initial = validateUrl(input?.url);
  if (!(initial instanceof URL)) return initial;
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
  }
  const requestedUrl = initial.toString();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new DOMException("Web fetch timed out", "TimeoutError")),
    options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS,
  );
  const signal = options.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([options.signal, timeoutController.signal]);
  const resolveHost: ResolveWebHost = options.resolveHost ?? (async (hostname, resolveOptions) =>
    (await lookup(hostname, {
      all: resolveOptions.all,
      verbatim: resolveOptions.verbatim,
    })).map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })));

  let current = initial;
  let redirects = 0;
  try {
    while (true) {
      if (!isAllowedOrigin(current, options.allowedOrigins)) {
        return failure(
          "ORIGIN_NOT_AUTHORIZED",
          "The URL is outside the authorized web origins",
          { finalUrl: current.toString() },
        );
      }
      const blocked = await assertPublicTarget(current, signal, resolveHost);
      if (blocked !== undefined) return blocked;

      let response: Response;
      try {
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { accept: "text/html, text/plain, application/json, application/xhtml+xml, application/xml" },
        });
      } catch (error) {
        if (isTimeoutError(error, timeoutController.signal)) {
          return failure("TIMEOUT", "Web request timed out", { finalUrl: current.toString() });
        }
        if (options.signal?.aborted) throw error;
        if (signal.aborted) {
          return failure("NETWORK_ERROR", "Web request was cancelled", { finalUrl: current.toString() });
        }
        return failure("NETWORK_ERROR", "Web request failed", { finalUrl: current.toString() });
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (location === null) {
          return failure("HTTP_STATUS", "Redirect response did not include a Location header", {
            status: response.status,
            finalUrl: current.toString(),
          });
        }
        if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
          return failure("REDIRECT_LIMIT", "Too many redirects", {
            status: response.status,
            finalUrl: current.toString(),
          });
        }
        try {
          current = new URL(location, current);
        } catch {
          return failure("NETWORK_ERROR", "Redirect Location was not a valid URL", {
            status: response.status,
            finalUrl: current.toString(),
          });
        }
        const redirectUrl = validateUrl(current.toString());
        if (!(redirectUrl instanceof URL)) {
          return {
            ...redirectUrl,
            error: { ...redirectUrl.error, finalUrl: current.toString() },
          };
        }
        current = redirectUrl;
        redirects += 1;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return failure("HTTP_STATUS", `Web request returned HTTP ${response.status}`, {
          status: response.status,
          finalUrl: current.toString(),
        });
      }

      const contentType = contentTypeOf(response);
      if (!isSupportedContentType(contentType)) {
        return failure("UNSUPPORTED_CONTENT_TYPE", `Unsupported content type: ${contentType || "unknown"}`, {
          status: response.status,
          finalUrl: current.toString(),
        });
      }

      const body = await readBody(response, signal);
      const decoder = new TextDecoder("utf-8");
      let text = decoder.decode(body.bytes);
      if (contentType === "text/html" || contentType === "application/xhtml+xml") {
        text = htmlToText(text);
      }
      const textBytes = new TextEncoder().encode(text);
      let truncated = body.truncated;
      if (textBytes.byteLength > WEB_FETCH_MAX_TEXT_BYTES) {
        text = decoder.decode(textBytes.subarray(0, WEB_FETCH_MAX_TEXT_BYTES));
        truncated = true;
      }
      return {
        ok: true,
        value: {
          requestedUrl,
          finalUrl: current.toString(),
          status: response.status,
          contentType,
          fetchedAt: now().toISOString(),
          text,
          truncated,
        },
      };
    }
  } catch (error) {
    if (isTimeoutError(error, timeoutController.signal)) {
      return failure("TIMEOUT", "Web request timed out", { finalUrl: current.toString() });
    }
    if (options.signal?.aborted) throw error;
    if (signal.aborted) {
      return failure("NETWORK_ERROR", "Web request was cancelled", { finalUrl: current.toString() });
    }
    return failure("NETWORK_ERROR", "Web response could not be read", { finalUrl: current.toString() });
  } finally {
    clearTimeout(timeout);
  }
}
