# Thoth — handoff notes

Read this before changing anything. **Keep it up to date**: whenever a change lands, update the
sections it touches (what exists, conventions, known gaps, recent changes). User-facing documentation
lives in [README.md](README.md); this file is for whoever develops Thoth next.

_Last updated: 2026-11-23 (metadata links, several Identify matches, covers from links)_

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
| `updater.js` | Release (`vX.Y.Z`) / push (`pN`) checks, install: delta (`installDelta`: GitHub compare + raw files, removals/renames) with tarball fallback, backups, version detection (git, `.build-info.json`, `.update-state.json`), `isServerCode()` decides whether a restart is needed. |
| `library/db.js` | In-memory DB persisted to `data/library.json` + `progress.json` (throttled 300 ms saves, flushed on exit). `seriesMeta()` = effective metadata (precedence below), `seriesView()`/`bookView()` = what the browser gets, versions (`EDITIONS`, `splitEdition`), `libraryDefaults()`, `coverFromMetadata()`. |
| `library/scanner.js` | Scan modes (`quick`/`changes`/`full`, `MODES`; automatic scans are quick), saved scan index (`data/scan-index/<lib>.json`: `loadIndex`/`saveIndex`/`forgetIndex`), scan queue (one library at a time; a waiting scan is upgraded to the strongest mode asked), pool of low-priority worker processes, applying results, one-shots, progress (`progressOf`), `READ_VERSION` (bump to force re-reading files once). |
| `library/scan-core.js`, `scan-worker.js`, `zip.js` | File work in the workers: listing (`listFiles` builds the scan index; with `quick` it reuses unchanged folders' entries), ZIP central directory, `ComicInfo.xml`, PDF page counts. Must not touch the DB. |
| `library/api.js` | Library REST routes: libraries, series (works grouped by version), facets/filters, books, pages, progress, collections, read lists, metadata actions. |
| `library/rename.js` | Batch renaming: rules (`proposedName`/`parse`), `preview` (proposals + conflicts), `apply` (rename on disk, `moveBook` moves the book id with its progress and read-list entries, renames matching folder-source JSON). |
| `library/metadata/providers.js` | One object per site: `search(q)`, `fetch(id)` → normalized record. Per-site rate limit, retries on 429, timeouts. |
| `library/metadata/index.js` | Source registry (online `PROVIDERS` + folder sources from `db.metadataSources`, `byId`), per-library order (folder sources forced first: `localFirst`), online merge (first match fills each field), cover download, Identify (locked match, online only), queue with concurrency + batch progress, folder sources: `applyLocal`, CRUD, `checkSource`. |
| `library/metadata/local.js` | Folder sources: indexing a folder (`buildIndex`), JSON parsing with mtime cache, key matching (`path` / `name` modes), JSON → work/book records (`seriesRecord`, `bookRecord`), covers next to the JSON. No DB access. |
| `index.html`, `css/styles.css` | App shell, dialogs (form, identify, profile, users), theme tokens (light/dark). |
| `js/app.js` | Router (`#name/param?query`), per-history-entry scroll memory (`history.state.k`, `markHistoryEntry`/`restoreScroll`: new entries start at the top, Back/Forward restore once content is tall enough), sidebar, account menu, users, updates (incl. waiting for the auto-restart). |
| `js/library.js` | All library pages (home, library grid + filters, work page, book, search, collections, read lists, manage libraries, metadata sources, processes, server settings), the generic form dialog, Identify dialog, progress bars. ES5 style (`var`, `function`), no modules. |
| `js/reader.js` | Reader (ltr / rtl / continuous, fits, PDF via pdf.js from cdnjs). |
| `js/i18n.js`, `js/i18n-library.js` | Strings; `add(lang, {...})` merges blocks. |
| `deploy/`, `Dockerfile`, `docker-compose.yml`, `scripts/stamp-build.js` | Service/container setup, build version stamp. |
| `tests/` | Test suites + `run.js` runner. |

## Data model (data/library.json)

- `libraries[id]`: `{ id, name, root, created, oneshots: { folder }, defaults: { sort: 'title'|'added'|'updated', bookLayout: 'tiles'|'list', readingDirection: null|'ltr'|'rtl'|'vertical' }, metadata: { providers: [{ id, enabled }], autoFetch, cover: 'missing'|'always'|'never' }, lastScan, scanError }`
- `series[id]` (one per folder, or per loose file = one-shot): `{ id, libraryId, relPath, name, oneshot, meta (from ComicInfo), overrides (admin edits: title, summary, status, type, readingDirection, bookLayout, cover: 'file'|'metadata', edition, genres, tags, …), provider (online: { merged, sources, matches (each with `via`: 'locked'|'link'|title), links, locked ([{ provider, id }], one per site; old single objects are read by `lockList`), coverFile, coverUrl, coverProvider, errors, fetchedAt (last change), checkedAt (last check) }), local (folder sources: { merged, fields, sourceIds, file, coverPath, coverVersion, links }) }`
- A work's links (`db.linksOf`): `overrides.links` (edited, replaces the rest) else folder-JSON links + `provider.links`, as `[{ url, from: 'edit'|'folder'|'online', site }]`; `providers.fromUrl(url)` → `{ provider, id }` turns a site link into an exact match (refresh) and a cover (`metadata.linkCovers`; other pages → `og:image` via `pageImage`, guarded by `publicUrl`).
- `books[id]`: `{ id, seriesId, libraryId, relPath, fileName, format, pageCount, size, fileModified, meta, local ({ merged, sourceId, file }), overrides, index, readVersion }`
- Works can be hidden: `series.hidden = { at, by }` (logical delete). `api.js` filters hidden works/books out of every list for everyone (`shown`/`bookShown`); admins open them and list them with `?deleted=1`. Physical delete: `deleteWorkFiles` (unlink inside the library folder only, empty folder removed, failures reported).
- `series.customCover = { file, from ('upload' | 'online:<site>' | 'local:<source>:<path>'), at }`: the cover picked in the Edit dialog (`data/covers/custom-<id>-<t>.<ext>`); removed with the work.
- `metadataSources[id]` (folder sources): `{ id: 'folder-…', name, folder (absolute), match: 'path'|'name', created, updated }`. `s.local`/`b.local` are recomputed from the JSON files by `applyLocal` (after every scan, Refresh, source/library changes), so they can always be thrown away.
- `data/scan-index/<library>.json` (not in library.json): `{ version: 1, root, dirs: { relDir: { mtimeMs, files: [[name, size, modified]], dirs, unsupported } } }` from the last scan; safe to delete (the next scan is then a "changes" scan).
- IDs are stable hashes of library + path, so rescans and one-shot setting changes keep progress.

**Precedence of a work's values** (`seriesMeta`): admin overrides > folder sources > `ComicInfo.xml` >
online metadata; books (`bookMeta`): overrides > folder source JSON > `ComicInfo.xml`. Work titles never come
from online providers; a folder source's main title is shown (book titles can come from both). Reading mode: work override > library fixed default > detected (files,
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
- Page cache (`js/library.js`): `load(hash, fn, get)` skips the request while `get()` is fresh (`FRESH_MS` 60 s, stamped `_at`); `invalidate()`/`markStale()` mark entries stale instead of dropping them (shown at once, refreshed in the background). Use `markStale(cache.x)`, never `cache.x = {}`.
- Advanced search: client state `st.inc[f]`/`st.exc[f]` for type/status/genre/tag/metadata + yearFrom/yearTo/author; API params are repeated keys (`genre=a&genre=b&xgenre=c`). genre/tag = all included and none excluded; single-valued fields = any included, none excluded.
- Library pages keep their state (search, sort, filters, loaded works) in `cache.libs`; `invalidate()` marks it
  `stale` instead of dropping it, and `enter()` reloads as many works as were loaded, so Back keeps the place.
- Work tiles: `sizeTiles()` in `js/app.js` sets `--tile-cols`/`--tile-w`/`--tile-gap` on `:root` from the content width (ResizeObserver), so grids fill rows exactly and every page/library uses the same tile size; `scrollbar-gutter: stable` keeps the width the same with or without a scrollbar. Titles reserve two lines. Card grids for
  libraries/sources share `.lib-list`; metadata sources use `.msrc-grid` (equal heights).
- Anything long-running reports progress the same way: `{ percent | null, etaMs | null, elapsedMs, … }`, shown
  with `progressBar()` in `js/library.js`.
- Changing what's read from files: bump `READ_VERSION` in `scanner.js` so existing books are read again once.

## Known gaps / ideas

- An update that changes `supervisor.js` itself only applies after a full service restart.
- On Windows, Node puts child processes in a job object that kills them when the parent dies: killing the
  supervisor abruptly (Task Manager, `kill`) kills the server child too, losing changes from the last ~300 ms
  (saves are batched). Linux/Docker SIGTERM and Ctrl+C are graceful. Tests that restart the server wait 1 s first.
- Quick scans rely on folder modification times. A file rewritten in place may not change its folder's date on
  every file system (NTFS does, ext4 doesn't); *Scan changes* always catches it.
- One-shot page tiles load full-size pages (lazy, no resized thumbnails). PDF one-shots show the book card.
- Works matched before genres existed keep genres mixed into tags until *Refresh metadata* / *Refresh all*.
- Some MangaDex cover images may not show in the Identify dialog (hotlink restrictions); downloads work.
- Jikan (MyAnimeList) was unreachable from the development network; the provider is untested live. Google
  Books answers 429 without a key (that's why it's off by default). `tests/test-providers-live.js` is a report:
  it exits 0 even when some sites fail. `tests/test-metadata.js` depends on the live sites too: an occasional
  failure where The Hobbit isn't matched means Open Library was slow; rerun before suspecting the code.
- Renaming: a book id is a hash of its path, so `rename.apply` must go through `moveBook` (progress keys and read lists use book ids). Collections use work ids, which don't change.
- Very generic titles (e.g. "Short Story") can match an unrelated entry whose title or alt title is the same;
  admins fix it with Identify or Clear. Open Library subjects are free-form; `providers.js` filters the noise.
- No thumbnails cache/resizing at all (covers are full first pages, cached by the browser).
- Folder sources: `"cover"` must be a file inside the source folder (web addresses are ignored); applying
  walks the whole folder each time (fine for tens of thousands of files, not millions). `name` matching applies
  a JSON to every book with that file name, by design — the check report shows it.
- Not done yet: EPUB/CBR support, OPDS, per-user reading-mode defaults, metadata for individual chapters.

## Recent changes (newest first)

- **2026-11-23** — Links: matches' addresses, folder-JSON `url`/`links`, editable (Edit → Links); shown one per line on the work page; site links are exact matches in `refreshSeries` (lock → link → title search per site; it no longer stops once the main fields are filled when a site is locked/linked). Identify accepts several picks (`{ matches: [...] }`, one per site). Cover picker adds covers from links (site entry's cover, else the page's `og:image`; local/private addresses never fetched). *Update metadata* runs `applyLocal` first. Unreadable JSON is skipped in matching (`usable()` in `local.js`). Kitsu slug links resolved by `fetch`. `request()` retries once on connection failures (not timeouts). "Same data" checks compare data only (`strip()`), so a different `via` doesn't count as a change. New suite `tests/test-links.js`.

- **2026-11-23** — Rename files page (`#rename`, `GET /api/rename/preview`, `POST /api/rename/apply`) with `library/rename.js`; renamed books keep progress/read lists, matching JSON renamed, quick scan afterwards (reason `rename`). Metadata matching uses every title of a work (`titlesFor`: main + alternative titles; `bestMatch` scores against all and re-searches with up to 2 alternative titles; matches record `via`); Identify ranks with them too. New suite `tests/test-rename.js` (includes an in-process fake site).

- **2026-11-23** — Full-width tiles sized from the content width (same everywhere); work Edit dialog prefilled with current values + per-field source (`seriesView.fieldSources`, admins), saves only changed fields, new editable year/altTitles/authors; cover picker (`GET /api/series/:id/covers[?search=1]`, `/cover-candidate`, `POST /cover` with choice or base64 upload; `series.customCover` wins in `metadataCover`; `provider.coverCandidates` keeps every matched site's cover; site previews proxied + cached in memory). Oversized request bodies now get a 413 answer instead of a cut connection. New suite `tests/test-covers.js`.

- **2026-11-23** — Chapter order (library `defaults.bookOrder` + work `overrides.bookOrder` + per-browser toggle); advanced search with include/exclude, year range and author (replaces the single filter selects); hiding (`series.hidden`) and physically deleting works, hidden-works view with restore; page cache with freshness (no requests when switching pages within 60 s); folder sources keep parsed JSON in memory (`indexCache`; unchanged files reused, matching purely in memory, `applyLocal` reports `jsonRead`/`jsonReused`); JSON `title` lists (main + alternative titles; a work's main title is now displayed), `tags`/`artists` lists, book tags/genres/alt titles; a work without its own year/authors takes them from its books (`fromBooks`). New suite `tests/test-works.js`.

- **2026-11-23** — Saved scan index + quick scans (startup/schedule look only into changed folders; first scan
  and new folders are full; *Scan changes* checks every file); delta update installs (only changed files
  downloaded, removals applied; `install(..., { full: true })` forces the tarball); metadata delta (*Update
  metadata* = new/changed/coverless/30-day-old works; unchanged results don't bump `updated`/`fetchedAt`,`checkedAt`
  added); default order per library (`defaults.sort`, `defaultSort` for all users); same-size tiles; Back
  restores scroll and loaded works. New suite `tests/test-scans.js`; delta install checks in `test-updater.js`.

- **2026-11-23** — Metadata sources page (`#metadata-sources`): online sites with key status, libraries using
  them and a test search (`GET /api/metadata/sources/:id/search`); folder sources (JSON files matched by name,
  `11.json` → `11.cbz`) with create/edit/delete, *Check matches* report and *Apply now*
  (`/api/metadata/sources[/:id[/check|/apply]]`). Folder sources come first in every library's source order,
  beat ComicInfo, and are re-read after every scan. Folder images become covers (`store.metadataCover`).
  New suite `tests/test-folder-sources.js` (in `npm test`).

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
