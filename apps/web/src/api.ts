import type { Item, SourceType, Stats } from "./types";

export async function fetchItems(q: string, type: SourceType | "all") {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (type !== "all") params.set("type", type);

  const response = await fetch(`/api/items?${params}`);
  if (!response.ok) throw new Error("Failed to load saved content");
  return (await response.json()) as Item[];
}

export async function fetchStats() {
  const response = await fetch("/api/stats");
  if (!response.ok) throw new Error("Failed to load stats");
  return (await response.json()) as Stats;
}

