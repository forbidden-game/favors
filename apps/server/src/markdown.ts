import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtractedContent } from "./extract.js";
import type { ItemInput, SaveRequest } from "./types.js";

export function buildItem(input: SaveRequest, extracted: ExtractedContent, itemDir: string): ItemInput {
  const canonicalUrl = canonicalize(input.url);
  const id = createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
  const savedAt = new Date().toISOString();
  const markdownPath = path.join(itemDir, `${savedAt.slice(0, 10)}-${id}.md`);
  const summary = extracted.description || summarize(extracted.contentText);

  const item: ItemInput = {
    id,
    url: input.url,
    canonical_url: canonicalUrl,
    source_type: extracted.sourceType,
    title: extracted.title,
    author: extracted.author,
    site_name: extracted.siteName,
    summary,
    content_text: extracted.contentText,
    markdown_path: markdownPath,
    thumbnail_url: extracted.thumbnailUrl,
    saved_at: savedAt,
    published_at: extracted.publishedAt,
    tags: "[]",
  };

  mkdirSync(itemDir, { recursive: true });
  writeFileSync(markdownPath, renderMarkdown(item), "utf8");
  return item;
}

export function canonicalize(rawUrl: string) {
  const url = new URL(rawUrl);
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.startsWith("utm_") ||
      ["fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "ref"].includes(key)
    ) {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}

function renderMarkdown(item: ItemInput) {
  return `---
id: ${JSON.stringify(item.id)}
url: ${JSON.stringify(item.url)}
canonical_url: ${JSON.stringify(item.canonical_url)}
source_type: ${JSON.stringify(item.source_type)}
title: ${JSON.stringify(item.title)}
author: ${JSON.stringify(item.author)}
site_name: ${JSON.stringify(item.site_name)}
saved_at: ${JSON.stringify(item.saved_at)}
published_at: ${JSON.stringify(item.published_at)}
thumbnail_url: ${JSON.stringify(item.thumbnail_url)}
---

# ${item.title}

${item.summary ? `> ${item.summary}\n` : ""}
[Open Source](${item.url})

${toMarkdownBody(item.content_text)}
`;
}

function toMarkdownBody(value: string) {
  const paragraphs = value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.join("\n\n");
}

function summarize(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 320);
}

