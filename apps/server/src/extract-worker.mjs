import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const input = JSON.parse(await readStdin());
const sourceType = normalizeSourceType(input.sourceType) ?? inferSourceType(input.url);
const extracted = sourceType === "video" ? await fetchVideoMetadata(input.url) : await fetchReadable(input.url, sourceType);

process.stdout.write(JSON.stringify(extracted ?? {}));

async function fetchReadable(rawUrl, sourceType) {
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
    const article = new Readability(doc).parse();

    return {
      title: article?.title ?? meta(doc, "og:title") ?? doc.title,
      author: article?.byline ?? meta(doc, "author") ?? meta(doc, "article:author"),
      siteName: meta(doc, "og:site_name"),
      description: article?.excerpt ?? meta(doc, "description") ?? meta(doc, "og:description"),
      contentText: article?.textContent ?? doc.body?.textContent ?? "",
      thumbnailUrl: meta(doc, "og:image"),
      publishedAt: meta(doc, "article:published_time"),
    };
  } catch {
    return null;
  }
}

async function fetchVideoMetadata(rawUrl) {
  if (!isYouTubeUrl(rawUrl)) return null;

  try {
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(rawUrl)}`;
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    return {
      title: data.title ?? "",
      author: data.author_name ?? "",
      siteName: data.provider_name ?? "YouTube",
      description: "",
      contentText: "",
      thumbnailUrl: data.thumbnail_url ?? "",
      publishedAt: "",
    };
  } catch {
    return null;
  }
}

function meta(doc, name) {
  return (
    doc.querySelector(`meta[name="${name}"]`)?.content ||
    doc.querySelector(`meta[property="${name}"]`)?.content ||
    ""
  );
}

function normalizeSourceType(value) {
  if (value === "blog") return "article";
  if (["article", "thread", "video", "other"].includes(value)) return value;
  return null;
}

function inferSourceType(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be" || host.endsWith("youtube.com")) return "video";
  if (host === "x.com" || host.endsWith("twitter.com")) return "thread";
  return "article";
}

function isYouTubeUrl(rawUrl) {
  const host = new URL(rawUrl).hostname.replace(/^www\./, "");
  return host === "youtu.be" || host.endsWith("youtube.com");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

