# Thoth — handoff notes

Read this before changing anything. **Keep it up to date**: whenever a change lands, update the
sections it touches (what exists, conventions, known gaps, recent changes). User-facing documentation
lives in [README.md](README.md); this file is for whoever develops Thoth next.

_Last updated: 2026-11-23_

## What Thoth is

A self-hosted comic / manga / book server (Komga-like). An administrator points libraries at folders of
`.cbz`/`.zip`/`.pdf` files; users browse works and read them in the browser, with progress kept per user.
Online metadata comes from 8 sites (Jellyfin-like). Runs headless (Docker, systemd) and updates itself
from GitHub (`ChonaCio/Thoth`).

**Hard constraints**
- **Zero dependencies.** Node ≥ 18 standard library on the server; plain HTML/CSS/JS in the browser (no
  build step, no frameworks). Don't add packages.
- **5 languages** (en, es, fr, de, pt) for every UI string. `node tests/check-i18n.js .` must report all complete.
  Keys built dynamically (`'type.' + x`, `'filter.' + f`, `'progress.phase.' + p`, `'layout.' + l`) aren't
  detected by the checker: add those by hand to all 5.
- **Privacy.** Requests to outside services (metadata sites, GitHub) carry only what they need (work titles,
  repo names) and a generic `User-Agent: Thoth-Library-Server/1.0`. Never send user names, emails, server
  details. API keys are secrets: never returned to the browser, never logged (see `config.js` `secret: true`).
- **Admins vs users.** Every admin-only API checks the role on the server (`requireAdmin`). Users only see
  libraries shared with them (`user.libraries`, `null` = all) — facets, search, versions all respect it.

## Layout of the code

| Path | What it does |
| --- | --- |
| `server.js` | HTTP server: static files (allow-list), auth/users/updates/processes/config APIs, delegates `/api/…` library routes to `library/api.js`. First process becomes the **supervisor** unless `THOTH_SERVER_PROCESS` is set. |
| `supervisor.js` | Forks `server.js` as a child; exit code **75** = restart me (updates, *Restart server*); crash → restart (gives up after 5 in 60 s); forwards SIGINT/SIGTERM as an IPC `shutdown` message. |
| `auth.js` | First-user setup, scrypt passwords, sessions (HttpOnly cookie), roles, library access, sign-in throttling. |
| `config.js` | Server settings in `data/config.json` (`scanWorkers`, `scanConcurrency`, `metadataConcurrency`, API keys). `describe()` hides secrets; `onChange()` listeners. |
| `updater.js` | Release (`vX.Y.Z`) / push (`pN`) checks, tarball install with backups, version detection (git, `.build-info.json`, `.update-state.json`), `isServerCode()` decides whether a restart is needed. |
| `library/db.js` | In-memory DB persisted to `data/library.json` + `progress.json` (throttled 300 ms saves, flushed on exit). `seriesMeta()` = effective metadata (precedence below), `seriesView()`/`bookView()` = what the browser gets, versions (`EDITIONS`, `splitEdition`), `libraryDefaults()`, `coverFromMetadata()`. |
| `library/scanner.js` | Scan queue (one library at a time), pool of low-priority worker processes, applying results, one-shots, progress (`progressOf`), `READ_VERSION` (bump to force re-reading files once). |
| `library/scan-core.js`, `scan-worker.js`, `zip.js` | File work in the workers: listing, ZIP central directory, `ComicInfo.xml`, PDF page counts. Must not touch the DB. |
| `library/api.js` | Library REST routes: libraries, series (works grouped by version), facets/filters, books, pages, progress, collections, read lists, metadata actions. |
| `library/metadata/providers.js` | One object per site: `search(q)`, `fetch(id)` → normalized record. Per-site rate limit, retries on 429, timeouts. |
| `library/metadata/index.js` | Per-library provider order, merge (first match fills each field), cover download, Identify (locked match), queue with concurrency + batch progress. |
| `index.html`, `css/styles.css` | App shell, dialogs (form, identify, profile, users), theme tokens (light/dark). |
| `js/app.js` | Router (`#name/param?query`), sidebar, account menu, users, updates (incl. waiting for the auto-restart). |
| `js/library.js` | All library pages (home, library grid + filters, work page, book, search, collections, read lists, manage libraries, processes, server settings), the generic form dialog, Identify dialog, progress bars. ES5 style (`var`, `function`), no modules. |
| `js/reader.js` | Reader (ltr / rtl / continuous, fits, PDF via pdf.js from cdnjs). |
| `js/i18n.js`, `js/i18n-library.js` | Strings; `add(lang, {...})` merges blocks. |
| `deploy/`, `Dockerfile`, `docker-compose.yml`, `scripts/stamp-build.js` | Service/container setup, build version stamp. |
| `tests/` | Test suites + `run.js` runner. |

## Data model (data/library.json)

- `libraries[id]`: `{ id, name, root, created, oneshots: { folder }, defaults: { bookLayout: 'tiles'|'list', readingDirection: null|'ltr'|'rtl'|'vertical' }, metadata: { providers: [{ id, enabled }], autoFetch, cover: 'missing'|'always'|'never' }, lastScan, scanError }`
- `series[id]` (one per folder, or per loose file = one-shot): `{ id, libraryId, relPath, name, oneshot, meta (from ComicInfo), overrides (admin edits: title, summary, status, type, readingDirection, bookLayout, cover: 'file'|'metadata', edition, genres, tags, …), provider (online: { merged, sources, matches, links, locked, coverFile, coverUrl, coverProvider, errors, fetchedAt }) }`
- `books[id]`: `{ id, seriesId, libraryId, relPath, fileName, format, pageCount, size, fileModified, meta, overrides, index, readVersion }`
- IDs are stable hashes of library + path, so rescans and one-shot setting changes keep progress.

**Precedence of a work's values** (`seriesMeta`): admin overrides > `ComicInfo.xml` > online metadata.
Titles never come from providers. Reading mode: work override > library fixed default > detected (files,
then online) > `ltr`. Layout: work override > library default > tiles.

**Versions of a work**: folders `X`, `X (Colored)`, `X [Raw]`, … group into one work by folder name
(`workKey`), across libraries; `splitByEdition` keeps two same-edition folders apart.

## Running and testing

```
npm start                 # http://<host>:3000 (supervised; THOTH_NO_SUPERVISOR=1 to run bare)
npm test                  # offline suites, ~1 min
node tests/run.js all     # + processes (~3 min, ~1 GB temp files), metadata/providers (network), updater (GitHub)
node tests/run.js metadata display   # specific suites
```

Suites start the server from the checkout with `THOTH_DATA_DIR` in a temp folder, on their own ports
(3984–3991). `updater` runs on a temporary copy (it installs over the folder it gets). Sample comics come from
`tests/make-comics.js`. Note: suites that add libraries without `metadata: { autoFetch: false }` will also
start online lookups in the background (harmless, but not offline); `test-display.js` turns it off.

For UI checks, start a server with a scratch `THOTH_DATA_DIR` and a sample media folder, create a test admin
through `/api/setup`, and use the browser.

## Conventions

- Errors: `throw httpError(status, code)`; the browser translates `err.<code>`.
- New settings for the server go in `config.js` `SCHEMA` (validated, clamped); per library in the library
  object (parse/validate in `api.js`); per work in `series.overrides`.
- The client tolerates an older server (missing fields → defaults), because after an update the page can talk
  to the old process for a moment.
- Anything long-running reports progress the same way: `{ percent | null, etaMs | null, elapsedMs, … }`, shown
  with `progressBar()` in `js/library.js`.
- Changing what's read from files: bump `READ_VERSION` in `scanner.js` so existing books are read again once.

## Known gaps / ideas

- An update that changes `supervisor.js` itself only applies after a full service restart.
- On Windows, killing the supervisor abruptly (Task Manager, `kill`) leaves the server child to finish saving
  on its own; starting a new server before it exits can lose the last changes (Linux SIGTERM path is clean).
- One-shot page tiles load full-size pages (lazy, no resized thumbnails). PDF one-shots show the book card.
- Works matched before genres existed keep genres mixed into tags until *Refresh metadata* / *Refresh all*.
- Some MangaDex cover images may not show in the Identify dialog (hotlink restrictions); downloads work.
- Jikan (MyAnimeList) was unreachable from the development network; the provider is untested live. Google
  Books answers 429 without a key (that's why it's off by default). `tests/test-providers-live.js` is a report:
  it exits 0 even when some sites fail.
- Very generic titles (e.g. "Short Story") can match an unrelated entry whose title or alt title is the same;
  admins fix it with Identify or Clear. Open Library subjects are free-form; `providers.js` filters the noise.
- No thumbnails cache/resizing at all (covers are full first pages, cached by the browser).
- Not done yet: EPUB/CBR support, OPDS, per-user reading-mode defaults, metadata for individual chapters.

## Recent changes (newest first)

- **2026-11-23** — Chapter layout (tiles/list) per library + per work; one-shot work pages show their pages;
  default reading mode per library (automatic or fixed) + per work, reader respects default changes; library
  filters by type/status/genre/tag/metadata state with counts (`GET /api/series/facets`), genre/tag chips link
  to them; genres separated from tags (ComicInfo + providers, `READ_VERSION` 2); scan and metadata progress
  bars with time left; metadata lookups run in parallel (`metadataConcurrency`, default 3); covers part of every
  metadata check with fallback to the next source, per-work cover choice; tests moved into `tests/` with
  `npm test`; this file.
- **2026-11-22** — Built-in supervisor (updates restart automatically); online metadata (8 providers,
  per-library order, Identify, covers, API keys); Processes page; server settings; scan worker pool; versions
  of a work; one-shots as individual works.
