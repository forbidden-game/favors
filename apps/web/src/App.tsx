import {
  ArrowUpRight,
  FileText,
  MessageSquareText,
  RefreshCw,
  Search,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { fetchItems, fetchStats } from "./api";
import type { Item, SourceType, Stats } from "./types";

const filters: Array<{ value: SourceType | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "article", label: "Articles" },
  { value: "thread", label: "Threads" },
  { value: "video", label: "Videos" },
];

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({ total: 0, savedToday: 0, byType: {} });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceType | "all">("all");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void load();
  }, [filter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const selected = useMemo(() => {
    return items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  }, [items, selectedId]);

  async function load() {
    startTransition(async () => {
      try {
        const [nextItems, nextStats] = await Promise.all([fetchItems(query, filter), fetchStats()]);
        setItems(nextItems);
        setStats(nextStats);
        setSelectedId((current) => current && nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? null);
        setError("");
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load");
      }
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <h1>Favors</h1>
          <p>Local saved content</p>
        </div>

        <div className="metric">
          <span>Total</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="metric">
          <span>Saved Today</span>
          <strong>{stats.savedToday}</strong>
        </div>

        <nav className="type-nav" aria-label="Content filters">
          {filters.map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? "active" : ""}
              type="button"
              onClick={() => setFilter(item.value)}
            >
              <TypeIcon type={item.value} />
              <span>{item.label}</span>
              <small>{item.value === "all" ? stats.total : stats.byType[item.value] ?? 0}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        <header className="toolbar">
          <label className="search-box">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search saved content"
            />
          </label>
          <button className="icon-button" type="button" onClick={() => void load()} title="Refresh Content">
            <RefreshCw size={16} aria-hidden="true" className={isPending ? "spin" : ""} />
          </button>
        </header>

        <nav className="filter-tabs" aria-label="Content type tabs">
          {filters.map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? "active" : ""}
              type="button"
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {error ? <div className="error">{error}</div> : null}

        <div className="workspace">
          <section className="item-list" aria-label="Saved content">
            {items.length ? (
              <>
                <div className="list-head" aria-hidden="true">
                  <span>Title</span>
                  <span>Source</span>
                  <span>Type</span>
                  <span>Saved</span>
                  <span>Summary</span>
                </div>

                {items.map((item) => (
                  <article
                    key={item.id}
                    className={selected?.id === item.id ? "item-row selected" : "item-row"}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelectedId(item.id);
                    }}
                  >
                    <span className="item-icon">
                      <TypeIcon type={item.source_type} />
                    </span>
                    <span className="item-title-cell">
                      <a href={item.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                        {item.title}
                      </a>
                    </span>
                    <span className="item-source">{item.site_name || hostname(item.url)}</span>
                    <span className="type-badge">{typeLabel(item.source_type)}</span>
                    <span className="item-saved">{formatDate(item.saved_at)}</span>
                    <span className="item-summary">{item.summary || "No summary yet"}</span>
                    <a
                      className="row-link"
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open Source"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  </article>
                ))}
              </>
            ) : (
              <div className="empty-state">No saved content yet. Click the Chrome extension button to save a page.</div>
            )}
          </section>

          <DetailPanel item={selected} />
        </div>
      </section>
    </main>
  );
}

function DetailPanel({ item }: { item: Item | null }) {
  if (!item) {
    return (
      <aside className="detail-panel">
        <div className="empty-detail">Select an item</div>
      </aside>
    );
  }

  return (
    <aside className="detail-panel">
      {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" /> : null}
      <div className="detail-header">
        <span>{typeLabel(item.source_type)}</span>
        <a href={item.url} target="_blank" rel="noreferrer">
          Open Source
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      <h2>{item.title}</h2>
      <p>{item.summary || "No summary yet"}</p>

      <dl>
        <div>
          <dt>Source</dt>
          <dd>{item.site_name || hostname(item.url)}</dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{item.author || "Unknown"}</dd>
        </div>
        <div>
          <dt>Saved</dt>
          <dd>{formatDate(item.saved_at)}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd title={item.markdown_path}>{item.markdown_path.split("/").slice(-1)[0]}</dd>
        </div>
      </dl>
    </aside>
  );
}

function TypeIcon({ type }: { type: SourceType | "all" }) {
  if (type === "thread") return <MessageSquareText size={16} aria-hidden="true" />;
  if (type === "video") return <Video size={16} aria-hidden="true" />;
  return <FileText size={16} aria-hidden="true" />;
}

function typeLabel(type: SourceType) {
  return {
    article: "Article",
    thread: "Thread",
    video: "Video",
    other: "Other",
  }[type];
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
