# Favors

<p align="center">
  <img src="docs/favors-showcase.png" alt="Favors content collection icon" width="180" />
</p>

Favors is a local-first Chrome extension and web library for saving articles, Twitter/X threads, and YouTube videos with one click.

<p align="center">
  <img src="docs/library-preview.png" alt="Favors local saved-content library" />
</p>

## Features

- One-click save from Chrome.
- Local SQLite metadata and full-text search.
- Markdown snapshots in `data/items/`.
- Dark, searchable web library at `http://127.0.0.1:8123`.
- On-demand local daemon with systemd socket activation.
- Original links remain one click away.

## Tech Stack

- Chrome Manifest V3 extension
- Rust local daemon (`favorsd`) for HTTP, SQLite, static files, and idle exit
- systemd user socket activation on `127.0.0.1:8123`
- SQLite + FTS5 for metadata and search
- Node.js worker with Mozilla Readability + JSDOM for article extraction
- React + Vite + TypeScript

## Install

Requires Node.js 22+, Rust/Cargo, and a Linux user session with systemd.

```bash
npm install
npm run build
npm run install:socket
```

Open `http://127.0.0.1:8123`.

The socket stays available while the daemon is stopped. systemd starts `favorsd` on the first request, and the daemon exits after 5 idle minutes.

To remove the background socket:

```bash
npm run uninstall:socket
```

## Install The Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `apps/extension`.
5. Click the Favors extension button on any page to save it.

The extension posts to `http://127.0.0.1:8123/api/save`, so install the socket or run the daemon manually.

## Usage

1. Browse an article, Twitter/X thread, or YouTube video.
2. Click the Favors extension icon.
3. Open `http://127.0.0.1:8123`.
4. Search, filter, and open the original source from the library.

## Development

```bash
npm install
npm run dev:server
npm run dev:web
```

Open `http://127.0.0.1:5173` for the Vite dev UI.

For a foreground production run without systemd:

```bash
npm run build
npm start
```

## Local Data

- SQLite: `data/favors.sqlite`
- Markdown snapshots: `data/items/*.md`
- Generated or downloaded assets: `data/assets/`
