const API_URL = "http://127.0.0.1:8123/api/save";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  await setBadge("...", "#454545");

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageSnapshot,
    });

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Save failed with ${response.status}`);
    }

    await setBadge("OK", "#00952d");
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
  } catch (error) {
    console.error(error);
    await setBadge("ERR", "#e2162a");
  }
});

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function collectPageSnapshot() {
  const normalizeText = (value) =>
    value
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 60000);

  const inferSourceType = (url) => {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be" || host.endsWith("youtube.com")) return "video";
    if (host === "x.com" || host.endsWith("twitter.com")) return "thread";
    return "article";
  };

  const meta = (name) =>
    document.querySelector(`meta[name="${name}"]`)?.content ||
    document.querySelector(`meta[property="${name}"]`)?.content ||
    "";

  const firstUseful = (...values) => values.map((value) => normalizeText(String(value || ""))).find(Boolean) || "";
  const stripYouTubeSuffix = (value) => normalizeText(value).replace(/\s+-\s+YouTube$/i, "");
  const sourceType = inferSourceType(location.href);
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const youtube = sourceType === "video" ? collectYouTubeSnapshot() : null;
  const selectedText = String(getSelection()?.toString() || "").trim();
  const article = document.querySelector("article");
  const main = document.querySelector("main");
  const contentRoot = article || main || document.body;
  const contentText = normalizeText(contentRoot?.innerText || "");
  const host = location.hostname.replace(/^www\./, "");

  return {
    url: youtube?.url || canonical,
    title: youtube?.title || firstUseful(meta("og:title"), stripYouTubeSuffix(document.title), canonical),
    author: youtube?.author || meta("author") || meta("article:author"),
    siteName: youtube?.siteName || meta("og:site_name") || host,
    description: youtube?.description || meta("description") || meta("og:description"),
    publishedAt: meta("article:published_time"),
    thumbnailUrl: youtube?.thumbnailUrl || meta("og:image"),
    sourceType,
    selectedText,
    contentText,
  };

  function collectYouTubeSnapshot() {
    const videoId = getYouTubeVideoId(location.href);
    const metaTitle = meta("og:title");
    const domTitle = firstUseful(
      text("ytd-watch-metadata h1 yt-formatted-string"),
      text("ytd-watch-metadata h1"),
      text("#title h1 yt-formatted-string"),
      stripYouTubeSuffix(document.title),
      isGenericYouTubeTitle(metaTitle) ? "" : metaTitle,
    );
    const description = firstUseful(
      text("#description-inline-expander yt-attributed-string"),
      text("#description-inline-expander"),
      isGenericYouTubeDescription(meta("description")) ? "" : meta("description"),
      isGenericYouTubeDescription(meta("og:description")) ? "" : meta("og:description"),
    );
    const image = firstUseful(
      isGenericYouTubeImage(meta("og:image")) ? "" : meta("og:image"),
      videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
    );

    return {
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : canonical,
      title: isGenericYouTubeTitle(domTitle) ? "" : domTitle,
      author: firstUseful(
        text("ytd-watch-metadata ytd-channel-name a"),
        text("ytd-video-owner-renderer ytd-channel-name a"),
        text("#owner #channel-name a"),
      ),
      siteName: "YouTube",
      description,
      thumbnailUrl: image,
    };
  }

  function text(selector) {
    return document.querySelector(selector)?.textContent || "";
  }

  function getYouTubeVideoId(rawUrl) {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");

    const [, kind, id] = parsed.pathname.split("/");
    if (["shorts", "embed", "live"].includes(kind)) return id || "";
    return "";
  }

  function isGenericYouTubeTitle(value) {
    return ["", "youtube", "youtube music"].includes(normalizeText(value).toLowerCase());
  }

  function isGenericYouTubeDescription(value) {
    return /YouTube 上畅享你喜爱的视频|Enjoy the videos and music you love|上传原创内容|upload original content/i.test(
      value || "",
    );
  }

  function isGenericYouTubeImage(value) {
    return Boolean(value?.includes("/img/desktop/yt_"));
  }
}
