export type SourceType = "article" | "thread" | "video" | "other";

export interface Item {
  id: string;
  url: string;
  canonical_url: string;
  source_type: SourceType;
  title: string;
  author: string | null;
  site_name: string | null;
  summary: string;
  content_text: string;
  markdown_path: string;
  thumbnail_url: string | null;
  saved_at: string;
  published_at: string | null;
  tags: string;
}

export interface Stats {
  total: number;
  savedToday: number;
  byType: Partial<Record<SourceType, number>>;
}
