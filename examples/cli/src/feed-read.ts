import { SaxesParser } from "saxes";
import { z } from "zod";
import {
  WEB_FETCH_TIMEOUT_MS,
  fetchFeedDocument,
  validatePublicFeedItemUrl,
  webFetchErrorCodes,
  type WebFetchFailure,
  type WebFetchOptions,
} from "./web-fetch.js";

export const FEED_READ_TIMEOUT_MS = WEB_FETCH_TIMEOUT_MS;
export const FEED_DEFAULT_LIMIT = 10;
export const FEED_MAX_LIMIT = 20;
const TITLE_LIMIT = 300;
const SUMMARY_LIMIT = 2_000;
const ATOM_NS = "http://www.w3.org/2005/Atom";

export const feedReadErrorCodes = [
  ...webFetchErrorCodes,
  "FEED_INCOMPLETE",
  "INVALID_FEED",
  "UNSUPPORTED_ENCODING",
] as const;

export interface FeedReadInput {
  url: string;
  limit?: number | undefined;
}

export interface FeedItem {
  id: string | null;
  title: string;
  url: string | null;
  publishedAt: string | null;
  summary: string | null;
}

export type FeedReadResult =
  | {
      ok: true;
      value: {
        requestedUrl: string;
        finalUrl: string;
        fetchedAt: string;
        format: "rss2" | "atom";
        feedTitle: string | null;
        items: FeedItem[];
        /** More titled entries were parsed than the local limit, not feed completeness. */
        truncated: boolean;
      };
    }
  | WebFetchFailure
  | { ok: false; error: { code: "FEED_INCOMPLETE" | "INVALID_FEED" | "UNSUPPORTED_ENCODING"; message: string } };

export const feedReadInputSchema: z.ZodType<FeedReadInput> = z.object({
  url: z.string().min(1),
  limit: z.number().int().min(1).max(FEED_MAX_LIMIT).optional(),
}).strict();

export const feedReadResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      requestedUrl: z.string(),
      finalUrl: z.string(),
      fetchedAt: z.string(),
      format: z.enum(["rss2", "atom"]),
      feedTitle: z.string().nullable(),
      items: z.array(z.object({
        id: z.string().nullable(),
        title: z.string(),
        url: z.string().nullable(),
        publishedAt: z.string().nullable(),
        summary: z.string().nullable(),
      })),
      truncated: z.boolean(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(feedReadErrorCodes),
      message: z.string(),
      status: z.number().int().optional(),
      finalUrl: z.string().optional(),
    }),
  }),
]);

interface XmlNode {
  local: string;
  uri: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(text: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let error: Error | undefined;
  parser.on("xmldecl", (decl) => {
    if (decl.encoding !== undefined && !/^utf-?8$/i.test(decl.encoding)) {
      error = new Error("Feed XML declares a non-UTF-8 encoding");
    }
  });
  parser.on("doctype", () => { error = new Error("Feed XML DTD is not allowed"); });
  parser.on("error", (cause) => { error = cause; });
  parser.on("opentag", (tag) => {
    if (stack.length >= 64) throw new Error("Feed XML nesting is too deep");
    const attrs: Record<string, string> = {};
    for (const attr of Object.values(tag.attributes)) attrs[attr.local] = attr.value;
    const node: XmlNode = {
      local: tag.local,
      uri: tag.uri,
      attrs,
      children: [],
      text: "",
    };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const addText = (value: string) => {
    const current = stack[stack.length - 1];
    if (current !== undefined) current.text += value;
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  parser.on("closetag", () => {
    const completed = stack.pop();
    const parent = stack[stack.length - 1];
    if (completed !== undefined && parent !== undefined) parent.text += completed.text;
  });
  parser.write(text).close();
  if (error !== undefined) throw error;
  if (root === undefined) throw new Error("Feed XML has no root element");
  return root;
}

function child(node: XmlNode, name: string, uri = ""): XmlNode | undefined {
  return node.children.find((entry) => entry.local === name && entry.uri === uri);
}

function children(node: XmlNode, name: string, uri = ""): XmlNode[] {
  return node.children.filter((entry) => entry.local === name && entry.uri === uri);
}

function content(node: XmlNode | undefined, max: number): string | null {
  if (node === undefined) return null;
  const value = node.text.replace(/\s+/g, " ").trim();
  return value === "" ? null : Array.from(value).slice(0, max).join("");
}

function rawContent(node: XmlNode | undefined): string | null {
  return content(node, 8_192);
}

function atomLink(node: XmlNode, base: string): string | null {
  const links = children(node, "link", ATOM_NS)
    .map((link) => ({ href: link.attrs.href, rel: link.attrs.rel ?? "alternate" }))
    .filter((link): link is { href: string; rel: string } =>
      link.href !== undefined && itemUrl(link.href, base) !== null);
  return links.find((link) => link.rel === "alternate")?.href ?? links[0]?.href ?? null;
}

function itemUrl(raw: string | null, base: string): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function readEntries(root: XmlNode, finalUrl: string): {
  format: "rss2" | "atom";
  feedTitle: string | null;
  items: FeedItem[];
} {
  if (root.local === "rss" && root.uri === "" && root.attrs.version === "2.0") {
    const channel = child(root, "channel");
    if (channel === undefined) throw new Error("RSS 2.0 channel is missing");
    const items = children(channel, "item").flatMap((node): FeedItem[] => {
      const title = content(child(node, "title"), TITLE_LIMIT);
      if (title === null) return [];
      return [{
        id: rawContent(child(node, "guid")),
        title,
        url: itemUrl(rawContent(child(node, "link")), finalUrl),
        publishedAt: rawContent(child(node, "pubDate")),
        summary: content(child(node, "description"), SUMMARY_LIMIT),
      }];
    });
    return { format: "rss2", feedTitle: content(child(channel, "title"), TITLE_LIMIT), items };
  }
  if (root.local === "feed" && root.uri === ATOM_NS) {
    const items = children(root, "entry", ATOM_NS).flatMap((node): FeedItem[] => {
      const title = content(child(node, "title", ATOM_NS), TITLE_LIMIT);
      if (title === null) return [];
      return [{
        id: rawContent(child(node, "id", ATOM_NS)),
        title,
        url: itemUrl(atomLink(node, finalUrl), finalUrl),
        publishedAt: rawContent(child(node, "published", ATOM_NS)) ??
          rawContent(child(node, "updated", ATOM_NS)),
        summary: content(child(node, "summary", ATOM_NS), SUMMARY_LIMIT),
      }];
    });
    return {
      format: "atom",
      feedTitle: content(child(root, "title", ATOM_NS), TITLE_LIMIT),
      items,
    };
  }
  throw new Error("Only RSS 2.0 and Atom feeds are supported");
}

/** Read a public feed as discovery data. Article content still requires web_fetch. */
export async function readFeed(
  input: FeedReadInput,
  options: WebFetchOptions = {},
): Promise<FeedReadResult> {
  const limit = input.limit ?? FEED_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) {
    return { ok: false, error: { code: "INVALID_FEED", message: "Feed limit must be 1 through 20" } };
  }
  const document = await fetchFeedDocument({ url: input.url }, options);
  if (!document.ok) return document;
  if (document.value.truncated) {
    return { ok: false, error: { code: "FEED_INCOMPLETE", message: "Feed exceeded the response size limit" } };
  }
  let parsed: ReturnType<typeof readEntries>;
  try {
    parsed = readEntries(parseXml(document.value.text), document.value.finalUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed XML could not be parsed";
    return {
      ok: false,
      error: {
        code: message.includes("non-UTF-8") ? "UNSUPPORTED_ENCODING" : "INVALID_FEED",
        message,
      },
    };
  }
  const items = await Promise.all(parsed.items.slice(0, limit).map(async (item) => ({
    ...item,
    url: item.url === null ? null : await validatePublicFeedItemUrl(item.url, options),
  })));
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
  }
  return {
    ok: true,
    value: {
      requestedUrl: document.value.requestedUrl,
      finalUrl: document.value.finalUrl,
      fetchedAt: document.value.fetchedAt,
      format: parsed.format,
      feedTitle: parsed.feedTitle,
      items,
      truncated: parsed.items.length > limit,
    },
  };
}
