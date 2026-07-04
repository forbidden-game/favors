use html_escape::decode_html_entities;
use percent_encoding::percent_decode_str;
use readability::{extract as extract_readable, ExtractOptions};
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::{FromRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::{form_urlencoded, Url};

const DEFAULT_ADDR: &str = "127.0.0.1:8123";
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Favors/0.1";

type AppResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone)]
struct App {
    root: PathBuf,
    data_dir: PathBuf,
    item_dir: PathBuf,
    asset_dir: PathBuf,
    web_dir: PathBuf,
    socket_activated: bool,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    extra_headers: Vec<(String, String)>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    url: String,
    title: Option<String>,
    author: Option<String>,
    site_name: Option<String>,
    description: Option<String>,
    published_at: Option<String>,
    thumbnail_url: Option<String>,
    source_type: Option<String>,
    content_text: Option<String>,
    selected_text: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Extracted {
    title: Option<String>,
    author: Option<String>,
    site_name: Option<String>,
    description: Option<String>,
    content_text: Option<String>,
    thumbnail_url: Option<String>,
    published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Item {
    id: String,
    url: String,
    canonical_url: String,
    source_type: String,
    title: String,
    author: Option<String>,
    site_name: Option<String>,
    summary: String,
    content_text: String,
    markdown_path: String,
    thumbnail_url: Option<String>,
    saved_at: String,
    published_at: Option<String>,
    tags: String,
}

fn main() -> AppResult<()> {
    let (listener, socket_activated) = listener()?;
    let app = App::new(socket_activated)?;
    app.prepare()?;

    listener.set_nonblocking(true)?;
    eprintln!(
        "favorsd listening on {}{}",
        listener.local_addr()?,
        if socket_activated {
            " via systemd socket"
        } else {
            ""
        }
    );

    serve(listener, app)
}

impl App {
    fn new(socket_activated: bool) -> AppResult<Self> {
        let root = env::var("FAVORS_ROOT")
            .map(PathBuf::from)
            .unwrap_or(default_root()?);
        let data_dir = env::var("FAVORS_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root.join("data"));
        let web_dir = env::var("FAVORS_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_web_dir(&root));

        Ok(Self {
            item_dir: data_dir.join("items"),
            asset_dir: data_dir.join("assets"),
            web_dir,
            root,
            data_dir,
            socket_activated,
        })
    }

    fn prepare(&self) -> AppResult<()> {
        fs::create_dir_all(&self.item_dir)?;
        fs::create_dir_all(&self.asset_dir)?;
        self.with_db(|db| {
            init_db(db)?;
            Ok(())
        })
    }

    fn with_db<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let db = Connection::open(self.data_dir.join("favors.sqlite"))?;
        f(&db)
    }

    fn route(&self, req: &HttpRequest) -> HttpResponse {
        if req.method == "OPTIONS" {
            return empty(204);
        }

        let result = match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api/health") => self.health(),
            ("GET", "/api/stats") => self.stats(),
            ("GET", "/api/items") => self.items(req),
            ("POST", "/api/save") => self.save(req),
            ("GET", path) if path.starts_with("/api/items/") => {
                self.item(path.trim_start_matches("/api/items/"))
            }
            ("GET", _) => self.static_file(&req.path),
            _ => Ok(json_response(404, json!({ "error": "Not found" }))),
        };

        result.unwrap_or_else(|err| json_response(500, json!({ "error": err.to_string() })))
    }

    fn health(&self) -> AppResult<HttpResponse> {
        Ok(json_response(
            200,
            json!({
                "ok": true,
                "root": self.root,
                "dataDir": self.data_dir,
                "webDistDir": self.web_dir,
                "socketActivated": self.socket_activated,
            }),
        ))
    }

    fn stats(&self) -> AppResult<HttpResponse> {
        let stats = self.with_db(|db| {
            let total: i64 = db.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
            let saved_today: i64 = db.query_row(
                "SELECT COUNT(*) FROM items WHERE date(saved_at) = date('now')",
                [],
                |row| row.get(0),
            )?;

            let mut by_type = BTreeMap::new();
            let mut stmt =
                db.prepare("SELECT source_type, COUNT(*) FROM items GROUP BY source_type")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (source_type, count) = row?;
                by_type.insert(source_type, count);
            }

            Ok(json!({ "total": total, "savedToday": saved_today, "byType": by_type }))
        })?;

        Ok(json_response(200, stats))
    }

    fn items(&self, req: &HttpRequest) -> AppResult<HttpResponse> {
        let q = req.query.get("q").map(String::as_str).unwrap_or("");
        let source_type = req
            .query
            .get("type")
            .and_then(|value| normalize_filter(value));
        let limit = req
            .query
            .get("limit")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(100)
            .clamp(1, 300);

        let items = self.with_db(|db| list_items(db, q, source_type.as_deref(), limit))?;
        Ok(json_response(200, serde_json::to_value(items)?))
    }

    fn item(&self, id: &str) -> AppResult<HttpResponse> {
        let item = self.with_db(|db| get_item(db, id))?;
        let Some(item) = item else {
            return Ok(json_response(404, json!({ "error": "Item not found" })));
        };

        let markdown = fs::read_to_string(&item.markdown_path).unwrap_or_default();
        let mut value = serde_json::to_value(item)?;
        value["markdown"] = Value::String(markdown);
        Ok(json_response(200, value))
    }

    fn save(&self, req: &HttpRequest) -> AppResult<HttpResponse> {
        let input: SaveRequest = serde_json::from_slice(&req.body)?;
        Url::parse(&input.url)?;

        let source_type = normalize_source_type(input.source_type.as_deref())
            .unwrap_or_else(|| infer_source_type(&input.url));
        let fetched = if source_type == "thread" {
            Extracted::default()
        } else {
            extract_remote(&input.url, &source_type).unwrap_or_default()
        };
        let item = build_item(&self.item_dir, input, fetched, source_type)?;

        self.with_db(|db| {
            upsert_item(db, &item)?;
            Ok(())
        })?;

        Ok(json_response(201, json!({ "ok": true, "item": item })))
    }

    fn static_file(&self, raw_path: &str) -> AppResult<HttpResponse> {
        let path = if raw_path == "/" {
            "/index.html"
        } else {
            raw_path
        };
        let rel = percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy();
        if rel.split('/').any(|part| part == "..") {
            return Ok(json_response(404, json!({ "error": "Not found" })));
        }

        let file = self.web_dir.join(rel.as_ref());
        if file.is_file() {
            return file_response(&file);
        }

        let index = self.web_dir.join("index.html");
        if index.is_file() {
            return file_response(&index);
        }

        Ok(json_response(404, json!({ "error": "Not found" })))
    }
}

fn default_root() -> AppResult<PathBuf> {
    let cwd = env::current_dir()?;
    if cwd.join("apps/web/dist").is_dir() || cwd.join("web").is_dir() {
        return Ok(cwd);
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            if let Some(root) = bin_dir.parent() {
                if root.join("web").is_dir() || root.join("apps/web/dist").is_dir() {
                    return Ok(root.to_path_buf());
                }
            }
        }
    }

    Ok(cwd)
}

fn default_web_dir(root: &Path) -> PathBuf {
    let dev = root.join("apps/web/dist");
    if dev.is_dir() {
        dev
    } else {
        root.join("web")
    }
}

fn listener() -> AppResult<(TcpListener, bool)> {
    let listen_fds = env::var("LISTEN_FDS")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    let listen_pid = env::var("LISTEN_PID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    let pid_matches = listen_pid
        .map(|pid| pid == std::process::id())
        .unwrap_or(true);

    if listen_fds > 0 && pid_matches {
        let listener = unsafe { TcpListener::from_raw_fd(3 as RawFd) };
        return Ok((listener, true));
    }

    let addr = env::var("FAVORS_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());
    Ok((TcpListener::bind(addr)?, false))
}

fn serve(listener: TcpListener, app: App) -> AppResult<()> {
    let idle_seconds = env::var("FAVORS_IDLE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| app.socket_activated.then_some(300));
    let mut last_activity = Instant::now();

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Err(err) = handle_stream(&mut stream, &app) {
                    let response = json_response(500, json!({ "error": err.to_string() }));
                    let _ = write_response(&mut stream, response);
                }
                last_activity = Instant::now();
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if let Some(seconds) = idle_seconds {
                    if last_activity.elapsed() >= Duration::from_secs(seconds) {
                        eprintln!("favorsd idle for {seconds}s; exiting");
                        return Ok(());
                    }
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(Box::new(err)),
        }
    }
}

fn handle_stream(stream: &mut TcpStream, app: &App) -> AppResult<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let req = read_request(stream)?;
    let response = app.route(&req);
    write_response(stream, response)?;
    Ok(())
}

fn read_request(stream: &mut TcpStream) -> AppResult<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("request too large".into());
        }

        if header_end.is_none() {
            header_end = find_header_end(&buffer);
            if let Some(end) = header_end {
                let headers = String::from_utf8_lossy(&buffer[..end]);
                content_length = parse_content_length(&headers);
            }
        }

        if let Some(end) = header_end {
            if buffer.len() >= end + 4 + content_length {
                break;
            }
        }
    }

    let header_end = header_end.ok_or("malformed HTTP request")?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing method")?.to_string();
    let target = parts.next().ok_or("missing target")?.to_string();

    let (path, query) = split_target(&target);
    let body_start = header_end + 4;
    let body_end = body_start + content_length;
    let body = buffer
        .get(body_start..body_end)
        .unwrap_or_default()
        .to_vec();

    Ok(HttpRequest {
        method,
        path,
        query,
        body,
    })
}

fn split_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    (path.to_string(), query)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn write_response(stream: &mut TcpStream, response: HttpResponse) -> std::io::Result<()> {
    let status_text = match response.status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };

    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\n",
        response.status,
        status_text,
        response.content_type,
        response.body.len()
    )?;
    for (key, value) in response.extra_headers {
        write!(stream, "{key}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.write_all(&response.body)
}

fn empty(status: u16) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "text/plain; charset=utf-8".to_string(),
        body: Vec::new(),
        extra_headers: Vec::new(),
    }
}

fn json_response(status: u16, value: Value) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "application/json; charset=utf-8".to_string(),
        body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
        extra_headers: Vec::new(),
    }
}

fn file_response(path: &Path) -> AppResult<HttpResponse> {
    Ok(HttpResponse {
        status: 200,
        content_type: mime(path).to_string(),
        body: fs::read(path)?,
        extra_headers: vec![("Cache-Control".to_string(), "public, max-age=0".to_string())],
    })
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn init_db(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        r#"
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
        "#,
    )?;
    Ok(())
}

fn upsert_item(db: &Connection, item: &Item) -> AppResult<()> {
    db.execute(
        r#"
        INSERT INTO items (
          id, url, canonical_url, source_type, title, author, site_name,
          summary, content_text, markdown_path, thumbnail_url, saved_at,
          published_at, tags
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
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
        "#,
        params![
            item.id,
            item.url,
            item.canonical_url,
            item.source_type,
            item.title,
            item.author,
            item.site_name,
            item.summary,
            item.content_text,
            item.markdown_path,
            item.thumbnail_url,
            item.saved_at,
            item.published_at,
            item.tags,
        ],
    )?;

    db.execute("DELETE FROM items_fts WHERE id = ?1", params![item.id])?;
    db.execute(
        r#"
        INSERT INTO items_fts (id, title, summary, content_text, author, site_name, url)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            item.id,
            item.title,
            item.summary,
            item.content_text,
            item.author.clone().unwrap_or_default(),
            item.site_name.clone().unwrap_or_default(),
            item.url,
        ],
    )?;

    Ok(())
}

fn get_item(db: &Connection, id: &str) -> AppResult<Option<Item>> {
    db.query_row(
        "SELECT * FROM items WHERE id = ?1",
        params![id],
        row_to_item,
    )
    .optional()
    .map_err(Into::into)
}

fn list_items(
    db: &Connection,
    q: &str,
    source_type: Option<&str>,
    limit: i64,
) -> AppResult<Vec<Item>> {
    let fts_query = to_fts_query(q);

    if let Some(fts) = fts_query {
        let mut stmt = db.prepare(
            r#"
            SELECT items.*
            FROM items
            JOIN items_fts ON items_fts.id = items.id
            WHERE items_fts MATCH ?1
              AND (?2 IS NULL OR source_type = ?2)
            ORDER BY bm25(items_fts), datetime(saved_at) DESC
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![fts, source_type, limit], row_to_item)?;
        collect_rows(rows)
    } else {
        let mut stmt = db.prepare(
            r#"
            SELECT *
            FROM items
            WHERE (?1 IS NULL OR source_type = ?1)
            ORDER BY datetime(saved_at) DESC
            LIMIT ?2
            "#,
        )?;
        let rows = stmt.query_map(params![source_type, limit], row_to_item)?;
        collect_rows(rows)
    }
}

fn collect_rows(rows: impl IntoIterator<Item = rusqlite::Result<Item>>) -> AppResult<Vec<Item>> {
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        id: row.get("id")?,
        url: row.get("url")?,
        canonical_url: row.get("canonical_url")?,
        source_type: row.get("source_type")?,
        title: row.get("title")?,
        author: row.get("author")?,
        site_name: row.get("site_name")?,
        summary: row.get("summary")?,
        content_text: row.get("content_text")?,
        markdown_path: row.get("markdown_path")?,
        thumbnail_url: row.get("thumbnail_url")?,
        saved_at: row.get("saved_at")?,
        published_at: row.get("published_at")?,
        tags: row.get("tags")?,
    })
}

fn to_fts_query(value: &str) -> Option<String> {
    let tokens: Vec<String> = value
        .split_whitespace()
        .filter_map(|token| {
            let clean: String = token
                .chars()
                .filter(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '-')
                .collect();
            (!clean.is_empty()).then(|| format!("{clean}*"))
        })
        .take(12)
        .collect();

    (!tokens.is_empty()).then(|| tokens.join(" "))
}

fn build_item(
    item_dir: &Path,
    input: SaveRequest,
    fetched: Extracted,
    source_type: String,
) -> AppResult<Item> {
    let canonical_url = canonicalize(&input.url)?;
    let id = hash_id(&canonical_url);
    let saved_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let markdown_path = item_dir.join(format!("{}-{}.md", &saved_at[..10], id));

    let content_text = normalize_text(first_long([
        input.selected_text.as_deref(),
        fetched.content_text.as_deref(),
        input.content_text.as_deref(),
    ]));
    let summary = choose_description(
        input.description.as_deref(),
        fetched.description.as_deref(),
        &content_text,
        &source_type,
    );
    let title = clean_title(&choose_title(
        input.title.as_deref(),
        fetched.title.as_deref(),
        &input.url,
        &source_type,
    ));
    let thumbnail_url = empty_to_none(choose_thumbnail(
        input.thumbnail_url.as_deref(),
        fetched.thumbnail_url.as_deref(),
        &source_type,
    ));

    let item = Item {
        id,
        url: input.url,
        canonical_url,
        source_type,
        title,
        author: empty_to_none(input.author.as_deref().or(fetched.author.as_deref())),
        site_name: empty_to_none(input.site_name.as_deref().or(fetched.site_name.as_deref())),
        summary,
        content_text,
        markdown_path: markdown_path.to_string_lossy().to_string(),
        thumbnail_url,
        saved_at,
        published_at: empty_to_none(
            input
                .published_at
                .as_deref()
                .or(fetched.published_at.as_deref()),
        ),
        tags: "[]".to_string(),
    };

    fs::create_dir_all(item_dir)?;
    fs::write(&item.markdown_path, render_markdown(&item))?;
    Ok(item)
}

fn first_long(values: [Option<&str>; 3]) -> &str {
    values
        .iter()
        .flatten()
        .copied()
        .find(|value| value.trim().len() > 120)
        .or_else(|| {
            values
                .iter()
                .flatten()
                .copied()
                .find(|value| !value.trim().is_empty())
        })
        .unwrap_or("")
}

fn canonicalize(raw_url: &str) -> AppResult<String> {
    let mut url = Url::parse(raw_url)?;
    url.set_fragment(None);
    let had_query = url.query().is_some();
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter_map(|(key, value)| {
            let should_strip = key.starts_with("utm_")
                || matches!(
                    key.as_ref(),
                    "fbclid" | "gclid" | "mc_cid" | "mc_eid" | "igshid" | "ref"
                );
            (!should_strip).then(|| (key.into_owned(), value.into_owned()))
        })
        .collect();
    if had_query {
        url.set_query(None);
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs);
        }
    }
    Ok(url.to_string())
}

fn hash_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn choose_title<'a>(
    input: Option<&'a str>,
    fetched: Option<&'a str>,
    fallback: &'a str,
    source_type: &str,
) -> String {
    if is_generic_title(input, source_type) {
        if let Some(fetched) = fetched.filter(|value| !value.trim().is_empty()) {
            return fetched.to_string();
        }
    }
    input
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fetched.filter(|value| !value.trim().is_empty()))
        .unwrap_or(fallback)
        .to_string()
}

fn choose_description(
    input: Option<&str>,
    fetched: Option<&str>,
    content_text: &str,
    source_type: &str,
) -> String {
    if !is_generic_description(input, source_type) {
        return normalize_text(
            input
                .or(fetched)
                .unwrap_or_else(|| first_sentence_block(content_text)),
        );
    }
    normalize_text(fetched.unwrap_or_else(|| first_sentence_block(content_text)))
}

fn choose_thumbnail<'a>(
    input: Option<&'a str>,
    fetched: Option<&'a str>,
    source_type: &str,
) -> Option<&'a str> {
    if is_generic_thumbnail(input, source_type) {
        return fetched;
    }
    input.or(fetched)
}

fn is_generic_title(value: Option<&str>, source_type: &str) -> bool {
    source_type == "video"
        && value
            .map(|value| {
                let title = value.trim().to_ascii_lowercase();
                title.is_empty() || title == "youtube" || title == "youtube music"
            })
            .unwrap_or(true)
}

fn is_generic_description(value: Option<&str>, source_type: &str) -> bool {
    if source_type != "video" {
        return false;
    }
    value
        .map(|value| {
            value.contains("YouTube 上畅享你喜爱的视频")
                || value.contains("上传原创内容")
                || value
                    .to_ascii_lowercase()
                    .contains("enjoy the videos and music you love")
                || value
                    .to_ascii_lowercase()
                    .contains("upload original content")
        })
        .unwrap_or(false)
}

fn is_generic_thumbnail(value: Option<&str>, source_type: &str) -> bool {
    source_type == "video"
        && value
            .map(|value| value.contains("/img/desktop/yt_"))
            .unwrap_or(false)
}

fn clean_title(value: &str) -> String {
    let title = normalize_text(value);
    if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    }
}

fn normalize_text(value: &str) -> String {
    value
        .replace('\u{a0}', " ")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn first_sentence_block(value: &str) -> &str {
    let value = value.trim();
    let end = value
        .char_indices()
        .nth(320)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    value.get(..end).unwrap_or(value).trim()
}

fn empty_to_none(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn render_markdown(item: &Item) -> String {
    format!(
        r#"---
id: {}
url: {}
canonical_url: {}
source_type: {}
title: {}
author: {}
site_name: {}
saved_at: {}
published_at: {}
thumbnail_url: {}
---

# {}

{}
[Open Source]({})

{}
"#,
        json_string(&item.id),
        json_string(&item.url),
        json_string(&item.canonical_url),
        json_string(&item.source_type),
        json_string(&item.title),
        json_option(item.author.as_deref()),
        json_option(item.site_name.as_deref()),
        json_string(&item.saved_at),
        json_option(item.published_at.as_deref()),
        json_option(item.thumbnail_url.as_deref()),
        item.title,
        if item.summary.is_empty() {
            String::new()
        } else {
            format!("> {}\n", item.summary)
        },
        item.url,
        item.content_text
            .split("\n\n")
            .map(|paragraph| paragraph.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|paragraph| !paragraph.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn json_option(value: Option<&str>) -> String {
    value.map(json_string).unwrap_or_else(|| "null".to_string())
}

fn infer_source_type(raw_url: &str) -> String {
    let Ok(url) = Url::parse(raw_url) else {
        return "article".to_string();
    };
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    if host == "youtu.be" || host.ends_with("youtube.com") {
        "video".to_string()
    } else if host == "x.com" || host.ends_with("twitter.com") {
        "thread".to_string()
    } else {
        "article".to_string()
    }
}

fn normalize_source_type(value: Option<&str>) -> Option<String> {
    match value {
        Some("blog") => Some("article".to_string()),
        Some("article" | "thread" | "video" | "other") => value.map(ToOwned::to_owned),
        _ => None,
    }
}

fn normalize_filter(value: &str) -> Option<String> {
    match value {
        "all" => None,
        "blog" => Some("article".to_string()),
        "article" | "thread" | "video" | "other" => Some(value.to_string()),
        _ => None,
    }
}

fn extract_remote(raw_url: &str, source_type: &str) -> Option<Extracted> {
    if source_type == "video" && is_youtube_url(raw_url) {
        return fetch_youtube_oembed(raw_url);
    }

    if source_type != "article" {
        return None;
    }

    let (content_type, html) = fetch_text(raw_url, "text/html,application/xhtml+xml")?;
    if !content_type.to_ascii_lowercase().contains("text/html") {
        return None;
    }

    Some(extract_html(raw_url, &html))
}

fn fetch_youtube_oembed(raw_url: &str) -> Option<Extracted> {
    #[derive(Deserialize)]
    struct Oembed {
        title: Option<String>,
        author_name: Option<String>,
        provider_name: Option<String>,
        thumbnail_url: Option<String>,
    }

    let endpoint = format!(
        "https://www.youtube.com/oembed?format=json&url={}",
        percent_encode(raw_url)
    );
    let (_, body) = fetch_text(&endpoint, "application/json")?;
    let data: Oembed = serde_json::from_str(&body).ok()?;

    Some(Extracted {
        title: data.title,
        author: data.author_name,
        site_name: data.provider_name.or_else(|| Some("YouTube".to_string())),
        description: None,
        content_text: None,
        thumbnail_url: data.thumbnail_url,
        published_at: None,
    })
}

fn fetch_text(raw_url: &str, accept: &str) -> Option<(String, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();
    let mut response = agent
        .get(raw_url)
        .header("user-agent", USER_AGENT)
        .header("accept", accept)
        .call()
        .ok()?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = response.body_mut().read_to_string().ok()?;
    Some((content_type, body))
}

fn extract_html(raw_url: &str, html: &str) -> Extracted {
    let document = Html::parse_document(html);
    let readable = readable_text(raw_url, html);
    let title = meta(&document, &["og:title"])
        .or_else(|| {
            readable
                .as_ref()
                .and_then(|item| empty_to_none(Some(item.0.as_str())))
        })
        .or_else(|| first_text(&document, &["title"]));
    let content_text = readable
        .as_ref()
        .and_then(|item| empty_to_none(Some(item.1.as_str())))
        .or_else(|| first_text(&document, &["article", "main", "body"]));

    Extracted {
        title,
        author: meta(&document, &["author", "article:author"]),
        site_name: meta(&document, &["og:site_name"]).or_else(|| host_name(raw_url)),
        description: meta(&document, &["description", "og:description"]).or_else(|| {
            content_text
                .as_deref()
                .map(first_sentence_block)
                .map(str::to_string)
        }),
        content_text,
        thumbnail_url: meta(&document, &["og:image", "twitter:image"]),
        published_at: meta(&document, &["article:published_time", "date", "pubdate"]),
    }
}

fn readable_text(raw_url: &str, html: &str) -> Option<(String, String)> {
    let url = Url::parse(raw_url).ok()?;
    let mut input = html.as_bytes();
    let readable = extract_readable(&mut input, &url, ExtractOptions::default()).ok()?;
    Some((
        normalize_text(&readable.title),
        normalize_text(&readable.text),
    ))
}

fn meta(document: &Html, names: &[&str]) -> Option<String> {
    for name in names {
        for selector in [
            format!(r#"meta[name="{name}"]"#),
            format!(r#"meta[property="{name}"]"#),
        ] {
            let selector = Selector::parse(&selector).ok()?;
            for node in document.select(&selector) {
                if let Some(content) = node.value().attr("content") {
                    let value = normalize_text(&decode_html_entities(content));
                    if !value.is_empty() {
                        return Some(value);
                    }
                }
            }
        }
    }
    None
}

fn first_text(document: &Html, selectors: &[&str]) -> Option<String> {
    for selector in selectors {
        let selector = Selector::parse(selector).ok()?;
        for node in document.select(&selector) {
            let value = normalize_text(&node.text().collect::<Vec<_>>().join(" "));
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn host_name(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url).ok()?;
    Some(url.host_str()?.trim_start_matches("www.").to_string())
}

fn is_youtube_url(raw_url: &str) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    host == "youtu.be" || host.ends_with("youtube.com")
}

fn percent_encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str) -> SaveRequest {
        SaveRequest {
            url: url.to_string(),
            title: None,
            author: None,
            site_name: None,
            description: None,
            published_at: None,
            thumbnail_url: None,
            source_type: None,
            content_text: None,
            selected_text: None,
        }
    }

    #[test]
    fn canonicalize_removes_tracking_and_fragment() {
        assert_eq!(
            canonicalize("https://example.com/read?utm_source=x&keep=1&fbclid=y#section").unwrap(),
            "https://example.com/read?keep=1"
        );
        assert_eq!(
            canonicalize("https://example.com/read?utm_campaign=x#section").unwrap(),
            "https://example.com/read"
        );
    }

    #[test]
    fn extract_html_reads_metadata_and_article_text() {
        let html = r#"
            <!doctype html>
            <html>
              <head>
                <title>Fallback title</title>
                <meta property="og:title" content="Saved &amp; Parsed">
                <meta name="author" content="Ada">
                <meta property="og:site_name" content="Example Journal">
                <meta name="description" content="A concise summary.">
                <meta property="og:image" content="https://example.com/card.png">
                <meta property="article:published_time" content="2026-07-04T10:00:00Z">
              </head>
              <body>
                <article>
                  <h1>Saved &amp; Parsed</h1>
                  <p>First paragraph with enough useful text.</p>
                  <p>Second paragraph.</p>
                </article>
              </body>
            </html>
        "#;

        let extracted = extract_html("https://example.com/read", html);
        assert_eq!(extracted.title.as_deref(), Some("Saved & Parsed"));
        assert_eq!(extracted.author.as_deref(), Some("Ada"));
        assert_eq!(extracted.site_name.as_deref(), Some("Example Journal"));
        assert_eq!(extracted.description.as_deref(), Some("A concise summary."));
        assert_eq!(
            extracted.thumbnail_url.as_deref(),
            Some("https://example.com/card.png")
        );
        assert_eq!(
            extracted.published_at.as_deref(),
            Some("2026-07-04T10:00:00Z")
        );
        assert!(extracted
            .content_text
            .as_deref()
            .unwrap_or("")
            .contains("First paragraph"));
    }

    #[test]
    fn build_item_prefers_selected_text_and_replaces_generic_youtube_title() {
        let dir = env::temp_dir().join(format!("favors-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let selected = "selected text ".repeat(20);
        let mut input = request("https://www.youtube.com/watch?v=abc123");
        input.title = Some("YouTube".to_string());
        input.source_type = Some("video".to_string());
        input.selected_text = Some(selected.clone());

        let item = build_item(
            &dir,
            input,
            Extracted {
                title: Some("Real video title".to_string()),
                author: Some("Creator".to_string()),
                site_name: Some("YouTube".to_string()),
                description: None,
                content_text: Some("fetched text ".repeat(20)),
                thumbnail_url: Some("https://img.example/video.jpg".to_string()),
                published_at: None,
            },
            "video".to_string(),
        )
        .unwrap();

        assert_eq!(item.title, "Real video title");
        assert_eq!(item.author.as_deref(), Some("Creator"));
        assert_eq!(item.content_text, selected.trim());
        assert!(fs::read_to_string(&item.markdown_path)
            .unwrap()
            .contains("[Open Source](https://www.youtube.com/watch?v=abc123)"));

        let _ = fs::remove_dir_all(&dir);
    }
}
