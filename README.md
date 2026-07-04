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
- Rust local daemon (`favorsd`) for HTTP, extraction, SQLite, static files, and idle exit
- Linux systemd user socket activation on `127.0.0.1:8123`
- macOS LaunchAgent and Windows user-login startup
- SQLite + FTS5 for metadata and search
- React + Vite + TypeScript

## Install

Use the release installer. It downloads the matching prebuilt package, installs it into your user profile, and registers the local daemon.

```bash
./scripts/install.sh
```

Open `http://127.0.0.1:8123`.

On Linux, the socket stays available while the daemon is stopped. systemd starts `favorsd` on the first request, and the daemon exits after 5 idle minutes.

On Windows:

```powershell
.\scripts\install.ps1
```

## Load The Chrome Extension From This Repo

No Chrome Web Store upload or zip package is required for local use.

1. Install the local Favors service first:

   ```bash
   ./scripts/install.sh
   ```

   On Windows:

   ```powershell
   .\scripts\install.ps1
   ```

2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder from the repo:

   ```text
   /path/to/favors/apps/extension
   ```

   On Windows, select:

   ```text
   C:\path\to\favors\apps\extension
   ```

   Select the folder that contains `manifest.json`. Do not select the repo root, `apps/`, or a zip file.

6. Pin the Favors icon from Chrome's extensions menu.
7. Open any article, X/Twitter thread, or YouTube video, then click the Favors icon to save it.

After `git pull`, open `chrome://extensions` and click the reload button on the Favors extension card.

The extension is plain Manifest V3 JavaScript and does not need `npm install` or a build step. It posts saved pages to the local service at `http://127.0.0.1:8123/api/save`.

## Usage

1. Browse an article, Twitter/X thread, or YouTube video.
2. Click the Favors extension icon.
3. Open `http://127.0.0.1:8123`.
4. Search, filter, and open the original source from the library.

## Development

Development requires Node.js 22+, Rust/Cargo, and SQLite development headers.

```bash
npm install
npm run build
npm run dev:server
npm run dev:web
```

Open `http://127.0.0.1:5173` for the Vite dev UI.

For a foreground production run without systemd:

```bash
npm start
```

To package the current build:

```bash
npm run package:release -- linux-x64
```

## Local Data

- SQLite: `data/favors.sqlite`
- Markdown snapshots: `data/items/*.md`
- Generated or downloaded assets: `data/assets/`
