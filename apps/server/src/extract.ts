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
  const fetched = sourceType === "video" ? await fetchVideoMetadata(input.url) : await fetchReadable(input.url, sourceType);

  const contentText = normalizeText(
    [input.selectedText, fetched?.textContent, input.contentText].find((value) => value && value.length > 120) ??
      input.contentText ??
      input.selectedText ??
      "",
  );

  const description = chooseDescription(input.description, fetched?.excerpt, contentText, sourceType);

  return {
    sourceType,
    title: cleanTitle(chooseTitle(input.title, fetched?.title, input.url, sourceType)),
    author: emptyToNull(input.author || fetched?.byline),
    siteName: emptyToNull(input.siteName || fetched?.siteName || new URL(input.url).hostname),
    description,
    contentText,
    thumbnailUrl: emptyToNull(chooseThumbnail(input.thumbnailUrl, fetched?.image, sourceType)),
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

function chooseTitle(inputTitle: string | undefined, fetchedTitle: string | undefined, fallback: string, sourceType: SourceType) {
  if (isGenericTitle(inputTitle, sourceType) && fetchedTitle) return fetchedTitle;
  return inputTitle || fetchedTitle || fallback;
}

function chooseDescription(
  inputDescription: string | undefined,
  fetchedDescription: string | undefined,
  contentText: string,
  sourceType: SourceType,
) {
  if (!isGenericDescription(inputDescription, sourceType)) {
    return normalizeText(inputDescription || fetchedDescription || firstSentenceBlock(contentText));
  }

  return normalizeText(fetchedDescription || firstSentenceBlock(contentText));
}

function chooseThumbnail(inputImage: string | undefined, fetchedImage: string | undefined, sourceType: SourceType) {
  if (isGenericThumbnail(inputImage, sourceType) && fetchedImage) return fetchedImage;
  return inputImage || fetchedImage;
}

function isGenericTitle(value: string | undefined, sourceType: SourceType) {
  return sourceType === "video" && (!value || ["youtube", "youtube music"].includes(value.trim().toLowerCase()));
}

function isGenericDescription(value: string | undefined, sourceType: SourceType) {
  if (sourceType !== "video" || !value) return false;
  return /YouTube 上畅享你喜爱的视频|Enjoy the videos and music you love|上传原创内容|upload original content/i.test(
    value,
  );
}

function isGenericThumbnail(value: string | undefined, sourceType: SourceType) {
  return sourceType === "video" && Boolean(value?.includes("/img/desktop/yt_"));
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

async function fetchVideoMetadata(rawUrl: string) {
  if (!isYouTubeUrl(rawUrl)) return null;

  try {
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(rawUrl)}`;
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      title?: string;
      author_name?: string;
      provider_name?: string;
      thumbnail_url?: string;
    };

    return {
      title: data.title ?? "",
      byline: data.author_name ?? "",
      excerpt: "",
      textContent: "",
      siteName: data.provider_name ?? "YouTube",
      image: data.thumbnail_url ?? "",
    };
  } catch {
    return null;
  }
}

function isYouTubeUrl(rawUrl: string) {
  const host = new URL(rawUrl).hostname.replace(/^www\./, "");
  return host === "youtu.be" || host.endsWith("youtube.com");
}

function meta(doc: Document, name: string) {
  return (
    doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ||
    doc.querySelector<HTMLMetaElement>(`meta[property="${name}"]`)?.content ||
    ""
  );
}
