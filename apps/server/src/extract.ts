import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { SaveRequest, SourceType } from "./types.js";

export interface ExtractedContent {
  sourceType: SourceType;
  title: string;
  author: string | null;
  siteName: string | null;
  description: string;
  contentText: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

export async function extractContent(input: SaveRequest): Promise<ExtractedContent> {
  const sourceType = normalizeSourceType(input.sourceType) ?? inferSourceType(input.url);
  const fetched = await fetchReadable(input.url, sourceType);

  const contentText = normalizeText(
    [input.selectedText, fetched?.textContent, input.contentText].find((value) => value && value.length > 120) ??
      input.contentText ??
      input.selectedText ??
      "",
  );

  const description = normalizeText(input.description || fetched?.excerpt || firstSentenceBlock(contentText));

  return {
    sourceType,
    title: cleanTitle(input.title || fetched?.title || input.url),
    author: emptyToNull(input.author || fetched?.byline),
    siteName: emptyToNull(input.siteName || fetched?.siteName || new URL(input.url).hostname),
    description,
    contentText,
    thumbnailUrl: emptyToNull(input.thumbnailUrl || fetched?.image),
    publishedAt: emptyToNull(input.publishedAt),
  };
}

export function inferSourceType(rawUrl: string): SourceType {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be" || host.endsWith("youtube.com")) return "video";
  if (host === "x.com" || host.endsWith("twitter.com")) return "thread";
  return "article";
}

function normalizeSourceType(value: unknown): SourceType | null {
  if (value === "blog") return "article";
  if (value === "article" || value === "thread" || value === "video" || value === "other") return value;
  return null;
}

function cleanTitle(value: string) {
  return normalizeText(value).replace(/\s+[|·-]\s+$/, "") || "Untitled";
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function firstSentenceBlock(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.slice(0, 320);
}

function emptyToNull(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function fetchReadable(rawUrl: string, sourceType: SourceType) {
  if (sourceType === "thread") return null;

  try {
    const response = await fetch(rawUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Favors/0.1",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(8000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/html")) return null;

    const html = await response.text();
    const dom = new JSDOM(html, { url: rawUrl });
    const doc = dom.window.document;
    const reader = new Readability(doc);
    const article = reader.parse();

    return {
      title: article?.title ?? meta(doc, "og:title") ?? doc.title,
      byline: article?.byline ?? meta(doc, "author") ?? meta(doc, "article:author"),
      excerpt: article?.excerpt ?? meta(doc, "description") ?? meta(doc, "og:description"),
      textContent: article?.textContent ?? doc.body?.textContent ?? "",
      siteName: meta(doc, "og:site_name"),
      image: meta(doc, "og:image"),
    };
  } catch {
    return null;
  }
}

function meta(doc: Document, name: string) {
  return (
    doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ||
    doc.querySelector<HTMLMetaElement>(`meta[property="${name}"]`)?.content ||
    ""
  );
}
