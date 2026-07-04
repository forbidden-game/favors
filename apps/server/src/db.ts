import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ItemInput, ItemRecord, SourceType } from "./types.js";

interface ListOptions {
  q?: string;
  type?: SourceType | "all";
  limit?: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(private rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.db = new DatabaseSync(path.join(rootDir, "favors.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        site_name TEXT,
        summary TEXT NOT NULL,
        content_text TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        thumbnail_url TEXT,
        saved_at TEXT NOT NULL,
        published_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        content_text,
        author,
        site_name,
        url
      );

      UPDATE items SET source_type = 'article' WHERE source_type = 'blog';
    `);
  }

  upsert(item: ItemInput) {
    this.db
      .prepare(`
        INSERT INTO items (
          id, url, canonical_url, source_type, title, author, site_name,
          summary, content_text, markdown_path, thumbnail_url, saved_at,
          published_at, tags
        ) VALUES (
          $id, $url, $canonical_url, $source_type, $title, $author, $site_name,
          $summary, $content_text, $markdown_path, $thumbnail_url, $saved_at,
          $published_at, $tags
        )
        ON CONFLICT(canonical_url) DO UPDATE SET
          url = excluded.url,
          source_type = excluded.source_type,
          title = excluded.title,
          author = excluded.author,
          site_name = excluded.site_name,
          summary = excluded.summary,
          content_text = excluded.content_text,
          markdown_path = excluded.markdown_path,
          thumbnail_url = excluded.thumbnail_url,
          saved_at = excluded.saved_at,
          published_at = excluded.published_at,
          tags = excluded.tags
      `)
      .run(named(item));

    this.db.prepare("DELETE FROM items_fts WHERE id = ?").run(item.id);
    this.db
      .prepare(`
        INSERT INTO items_fts (id, title, summary, content_text, author, site_name, url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.title,
        item.summary,
        item.content_text,
        item.author ?? "",
        item.site_name ?? "",
        item.url,
      );
  }

  get(id: string) {
    return this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRecord | undefined;
  }

  list(options: ListOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
    const type = options.type && options.type !== "all" ? options.type : null;
    const query = toFtsQuery(options.q ?? "");

    if (query) {
      return this.db
        .prepare(`
          SELECT items.*
          FROM items
          JOIN items_fts ON items_fts.id = items.id
          WHERE items_fts MATCH ?
            AND (? IS NULL OR source_type = ?)
          ORDER BY bm25(items_fts), datetime(saved_at) DESC
          LIMIT ?
        `)
        .all(query, type, type, limit) as unknown as ItemRecord[];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM items
        WHERE (? IS NULL OR source_type = ?)
        ORDER BY datetime(saved_at) DESC
        LIMIT ?
      `)
      .all(type, type, limit) as unknown as ItemRecord[];
  }

  stats() {
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM items").get() as { count: number };
    const savedToday = this.db
      .prepare("SELECT COUNT(*) AS count FROM items WHERE date(saved_at) = date('now')")
      .get() as { count: number };
    const byType = this.db
      .prepare("SELECT source_type, COUNT(*) AS count FROM items GROUP BY source_type")
      .all() as Array<{ source_type: SourceType; count: number }>;

    return {
      total: total.count,
      savedToday: savedToday.count,
      byType: Object.fromEntries(byType.map((row) => [row.source_type, row.count])),
    };
  }
}

function named(item: ItemInput) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [`$${key}`, value]));
}

function toFtsQuery(value: string) {
  const tokens = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_\-\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);

  return tokens.map((token) => `${token}*`).join(" ");
}
