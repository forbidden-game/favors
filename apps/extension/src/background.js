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

  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const selectedText = String(getSelection()?.toString() || "").trim();
  const article = document.querySelector("article");
  const main = document.querySelector("main");
  const contentRoot = article || main || document.body;
  const contentText = normalizeText(contentRoot?.innerText || "");
  const host = location.hostname.replace(/^www\./, "");

  return {
    url: canonical,
    title: meta("og:title") || document.title || canonical,
    author: meta("author") || meta("article:author"),
    siteName: meta("og:site_name") || host,
    description: meta("description") || meta("og:description"),
    publishedAt: meta("article:published_time"),
    thumbnailUrl: meta("og:image"),
    sourceType: inferSourceType(location.href),
    selectedText,
    contentText,
  };
}
