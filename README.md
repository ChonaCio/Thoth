# Thoth

A self-hosted comic and manga server. Point it at folders of `.cbz`, `.zip` or `.pdf` files and
read them in the browser on any device, with reading progress kept per user.

No dependencies — plain HTML/CSS/JS plus a small Node server (Node.js 18+).

## Features

- **Libraries**: each library is a folder on the server. Every folder inside it that contains books
  becomes a **series**; each file is a **book**. The first scan reads everything; after that, quick scans at
  startup and on a schedule (default hourly) only look into folders that changed, and only new or changed
  files are opened again. Full scans run only when you ask. Each library has a **default order** (A–Z,
  recently added, recently updated or score), a default chapter layout and a default reading mode.
- **Metadata** from `ComicInfo.xml` inside CBZ files (title, number, summary, authors, publisher,
  genres, release date, manga reading direction, webtoon format). Administrators can override any of it;
  their edits survive rescans.
- **Online metadata** (like Jellyfin): summary, status, year, type (manga, manhwa, manhua, webcomic, comic,
  novel, book), authors, genres/tags, rating, alternative titles and covers from AniList, MangaDex,
  MangaUpdates, Kitsu, MyAnimeList, Open Library, Google Books and Comic Vine. Each library chooses which
  sources to use and in what order. See [Online metadata](#online-metadata).
- **Folder metadata sources**: your own JSON files matched by name (`11.json` → `11.cbz`), managed on the
  Metadata sources page. See [Metadata sources page and folder sources](#metadata-sources-page-and-folder-sources).
- **Browse**: Home (*Keep reading*, *On deck* = next book in series you've started, recently added),
  per-library grids with text search, sort, read status and an **advanced search** (*Search & filters*): every
  type, status, genre, tag, person (writers, artists, … in any role) and metadata state can be **included or
  excluded** (click once to include, twice to exclude), combined with a year range and an author. Works need all
  included genres/tags/people and none of the excluded ones; for type, status and metadata any included value matches. Each value shows how many works
  have it, the chosen criteria show as removable chips, and the address keeps them (bookmarkable). Genre, tag
  and people chips on a work page open the library filtered by them. Works can also be sorted by **score**
  (best first, works without one last). Click a work's cover to see it full size. Global search covers series, books, authors,
  genres, tags, collections and read lists.
- **Four caches, each its own process** (started when needed, closed after a long idle time, shown on the
  Processes page): **Pages** (chapter pages, the next ones read ahead), **Covers** (in memory and on disk, read ahead
  after scans), **Works** and **Search**. If a cache process can't start, that cache runs inside the server.
- **Search cache:** an index of every work's titles, genres (categories), tags and people answers the search box
  and the *Search & filters* panel's find boxes (any genre, tag or person, not only those listed), counting only
  works in the libraries the user may see; recent answers are kept.
- **Works are cached too**: work lists, filters, work pages and Home are answered from a key-value cache of
  ready answers (per user, `THOTH_RESPONSE_CACHE_MB`, default 32) until something changes (any edit, scan or
  metadata update, or that user's reading progress). After every scan the **covers of every work are read
  ahead** into the cover cache, one at a time in the background, so big grids never wait for archives.
- **Pages and covers are fast**: they're answered from a key-value cache (recent images in memory,
  `THOTH_MEDIA_CACHE_MB`, default 128; covers also on disk in `data/cache/thumbs/`, so thousands of covers
  aren't read from their archives again after a restart). What isn't cached is read by a separate media
  process, started when needed and closed when idle; reading a page also reads the next three, so turning
  pages is answered from memory.
- **Big libraries**: tens of thousands of works stay quick. Each work's merged metadata and view are worked out
  once and reused until something about it changes; grouping versions into works, filters and counts are reused
  until anything changes, and full work objects are built only for the page of results you're looking at.
  Changing filters or the order shows *Updating…* over the grid while new results load.
- **Page cache**: pages you've opened are kept in the browser. Switching between them within a minute needs
  no request at all; after that, or after something changed, the page shows at once and refreshes in the
  background.
- **Deleting works** (administrators, work page → *Delete*): **hide** it (logical delete: gone for everyone,
  files untouched, stays hidden after scans; *Hidden works* on the library page lists them with *Restore*) or
  **delete its files** from the disk (physical: type the title to confirm; the work's folder goes too if it's
  left empty; files the server can't delete — read-only mounts, no permission — are reported and kept). With
  several versions you choose this version or all of them.
- **Going back** (browser Back or the back link) returns to exactly where you were: same scroll position, the
  same works loaded with *Load more*, same search, order and filters.
- **Layout**: pages use the whole width. Tiles fill each row exactly: the number of columns follows the screen
  size (bigger screens, bigger tiles), and the tile size is the same on every page and in every library.
- **Work page**: chapters as **tiles or a list**, **first or last chapter first** (both: library default,
  changeable per work; readers can flip the order on the page, remembered per work). A one-shot shows
  its **pages** instead, each opening the reader at that page.
- **Reader**: left to right, right to left (manga) and continuous (vertical scroll, webtoon); fit to screen, width,
  height or original size; keyboard, tap zones, swipe and a page slider; preloads upcoming pages; saves
  your page as you read and offers the next book at the end. The **default reading mode** is set per library
  (or automatic from the files/metadata) and per work; a mode picked in the reader is remembered per work
  in that browser until an administrator changes the default.
- **Progress**: per user; mark books or whole series as read/unread.
- **Collections** (groups of series) and **read lists** (books from any series, in reading order).
  Administrators create and edit them; everyone sees the parts they have access to.
- **Users**: per-user library access (all libraries, or only some). Downloads of the original files.

**Formats:** CBZ/ZIP (JPEG, PNG, WebP, GIF, AVIF, BMP pages) and PDF. CBR/RAR, CB7 and EPUB are
skipped and counted in the scan report. PDFs are drawn with pdf.js, which the browser downloads from
cdnjs the first time a PDF is opened (if that's blocked, the PDF can still be opened in the browser's
own viewer). Covers are the first page of each book at full size, cached by the browser.

```
npm start      # prints the addresses to open, e.g. http://192.168.1.20:3000
```

The server listens on all network interfaces, so any device on the network can open it at
`http://<server-ip>:3000`. Set `HOST=127.0.0.1` to allow only the machine itself.

## First run and users

There is no default account. The first time anyone opens the app, it shows **Create the first user**,
and that account becomes the **administrator**. Do this right after installing: until then, anyone
who can reach the server could claim it.

Accounts are stored on the server, so the same account works from every device.

- **Administrators** see **Users** in the sidebar (or account menu → *Manage users*), where they can
  add users, edit names and emails, change roles, reset passwords, turn accounts on or off, and delete them.
  They're also the only ones who can see the **Updates** page.
- **Users** can edit their own profile, photo, appearance and language, and change their own password.
- There must always be at least one active administrator, and nobody can delete, disable or demote themselves.
- **Sign-up** is off by default. An administrator can turn on *Let people create their own accounts*
  on the Users page; new accounts get the User role.
- Disabling a user, deleting them or resetting their password signs them out everywhere right away.
  Changing your own password signs you out on your other devices.

### Adding comics

Sign in as an administrator → **Manage libraries** → **Add library**, give it a name and a folder
(type the path or use **Browse** to pick it on the server). A layout like this works well:

```
/srv/comics/                 ← library folder
  Saga/                      ← series
    Saga 001.cbz             ← books (sorted naturally: 2 before 10)
    Saga 002.cbz
  One Piece/
    Volume 01.cbz
  Watchmen.cbz               ← one-shot (a book directly in the library folder)
```

**One-shots.** Every book file directly in the library folder is its own work, named after the book (its
`ComicInfo.xml` title, else the file name). It's listed in the library like any other work (labeled
*One-shot*) and opens a work page with its single book. Loose files are never grouped together. In the
library's settings you can name one **extra one-shots folder** inside the library (e.g. `One-shots`) whose
files are shown as individual works too. Changing it rescans the library; reading progress is kept.

**Versions of a work.** When you keep several versions of the same work, name the folders with a suffix in
parentheses or brackets: `One Piece`, `One Piece (Colored)`, `One Piece (Raw)`, `One Piece (Uncensored)`,
`One Piece (Animated)`. They're combined into one work "One Piece" (one card, "2 versions"). **The versions share
the work's title, metadata and cover** (those of the main version: Regular first, then Colored, Raw, Uncensored,
Animated); editing, *Identify* and metadata lookups apply to it. Only the chapter list changes: the page has a
tab per version **over the chapters/books**, and a version other than Regular gets a colored tag after the title
(*Colored*, *Raw*, *Uncensored*, *Animated*). Reading progress is each version's own.
- Grouping uses the **folder (or one-shot file) name**, so it works even if `ComicInfo.xml` inside the
  versions names them differently. Versions may also live in **different libraries**; a user only sees the
  versions in libraries they can access.
- Recognized suffixes (any case): Regular/Normal/Original, Colored/Coloured/Color/Full Color, Raw,
  Uncensored/Uncen, Animated/Motion. Anything else, like `(2019)`, stays part of the name.
- Two folders with the same name *and* the same version (two Regular `One Piece` folders) are not merged; the
  second gets its own card. If a version is detected wrongly, an administrator can set it in the series' **Edit** dialog.

```
/srv/comics/
  One Piece/                 ← "Regular" tab
  One Piece (Colored)/       ← "Colored" tab
  One Piece [Raw]/           ← "Raw" tab
```

**Three kinds of scan.** Every scan saves what it saw (each folder's modification time and each file's size
and date) in `data/scan-index/<library>.json`, so later scans only do what's needed:

| Scan | When | What it does |
| --- | --- | --- |
| **Quick scan** | at startup, on the schedule (and future file-change triggers) | Looks only into folders whose modification time changed since the last scan; files in unchanged folders aren't even checked. Opens only new and changed files. |
| **Scan changes** | the *Scan changes* button; after changing the one-shots folder | Checks every file's size and date; opens only new and changed files. Catches files rewritten in place without their folder changing. |
| **Full scan** | the first scan of a library, a new library folder, the *Full scan* button | Opens and reads every file again. |

Adding, removing or renaming files changes their folder's modification time, so quick scans find them. A file
rewritten in place may not change its folder's date on every file system (NTFS does), so use *Scan changes*
if a modified file isn't picked up. The library card says which kind of scan ran last, why (at startup,
scheduled, requested…) and, for quick scans, how many folders were unchanged.

**Scanning runs in its own processes: the scan service.** Walking folders and opening archives happens in a
pool of Node processes with the lowest CPU priority, started when a scan begins and closed a few seconds after
the last one ends (no idle processes; `THOTH_WORKER_IDLE_MS` sets the wait, default 10000), so browsing and reading stay fast during
big scans. A scan lists the library's files in one process, then spreads the new/changed files over all of
them in small batches, each process reading several files at once. Libraries are scanned one at a time
(others show *Waiting…*). If the processes can't be started, scans run inside the server instead; set
`THOTH_SCAN_IN_PROCESS=1` to force that.

**Server settings page (administrators)** — settings for this server, saved in `data/config.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| Scan processes | CPU cores − 1, up to 4 | Processes reading files in parallel. More = faster on multi-core servers (~40 MB memory each, only while scanning). Changing it during a scan restarts the scan with the new number. |
| Files at once per process | 4 | Files each process reads at the same time. Higher helps fast disks and network storage; lower is gentler on slow disks. |
| Works looked up at once | 3 | Metadata lookups running in parallel (1–8). Each site still gets a pause between requests. |
| Sources crawled at once | 2 | External catalog crawls running at the same time (1–8), each its own process; others wait in line. |
| Keep task logs (days) | 30 | Each task's log file (Logs page) is deleted after this many days; checked every hour. |
| Works read at once per crawl | 3 | Works one crawl reads at the same time (1–8), for sources without their own *Works at once*; also the requests to the site in progress at once. Each pauses before its next request, and a site whose robots.txt sets a `Crawl-delay` gets one request at a time. |
| Comic Vine API key | — | Needed to use Comic Vine. Saved on the server, never shown again (only "Saved"). |
| Google Books API key | — | Optional; without one Google Books allows very few lookups. |

**Tasks tab (Processes page).** Every long-running thing the server does — library scans, metadata lookups, file
jobs, catalog crawls — is a **task**: the running ones with their progress bar and time left, *Show output* (the
end of their log, live), *Stop* where it can be stopped (crawls), and the ones that ended lately with their result.
Each task writes its own **log file** (data/logs/); the **Logs** tab lists them by kind, shows one
(live while it runs) and downloads it. Logs are deleted after *Keep task logs* days (Server settings).

**Processes page (administrators).** Its tiles are all the same width (tiles in a row share their height). Shows the web server, the scan service, the metadata lookups, file
management jobs (their queue, what the running job is doing, and a process that exists only while jobs run),
the **catalog crawls** (each its own process, how many at once) and the **caches** (pages, covers, works and
search, each its own process: sizes, answers from the cache, covers read ahead):
process ID, uptime, memory, CPU time, what's being scanned or looked up and what's waiting. Scans and
metadata batches show a **progress bar with the time left**, estimated from the speed so far (scans: finding
files → reading new/changed files *x of y* → saving; metadata: works done of the batch, and which site each
work is being checked on). Manage libraries shows the same bar on a library being scanned.
- **Scan service: Start / Stop / Restart.** Stopping cancels the scan in progress (it starts over later);
  scans requested while stopped wait in line. A stopped service stays stopped across server restarts until
  you start it. If the service crashes it restarts by itself, and gives up after 3 crashes in a minute.
- **Restart server** always works: `npm start` / `node server.js` runs a tiny built-in supervisor that
  starts the real server as a child process and starts it again when asked (see
  [Restarts](#restarts-are-automatic)).
- When the server code on disk is newer than the running server (after a `git pull`), administrators see
  a notice asking to restart.

### Online metadata

Like Jellyfin's metadata fetchers, Thoth looks each work up on metadata sites and fills in what the files
don't say. Each library has its own **metadata sources** (Manage libraries → *Edit*): tick the ones to use and
order them with the arrows.

| Source | Good for | Key |
| --- | --- | --- |
| AniList | Manga, manhwa, manhua, light novels | — |
| MangaDex | Manga, manhwa, manhua, webcomics | — |
| MangaUpdates | Manga, manhwa, manhua, novels | — |
| Kitsu | Manga, manhwa, manhua, novels | — |
| MyAnimeList (via Jikan) | Manga, manhwa, manhua, novels | — |
| Open Library | Books, novels, comics | — |
| Google Books | Books, novels, comics | optional (off by default) |
| Comic Vine | Western comics | required (off by default) |

- **How results are combined.** For each work, the enabled sources are asked in order with the work's title
  (the folder name without its version suffix). Results are compared with **all** the titles the work is known
  by (its alternative titles from your edits, folder-source JSON, `ComicInfo.xml` or an earlier match) and the best
  comparison counts; if the main title finds nothing, the site is searched again with up to two alternative titles. A result counts only if its title (or an alternative title)
  is a close match; the publication year from the books breaks ties. Every enabled source is asked. The **first**
  good match fills each field (summary, status, year, type, publisher, authors, rating, cover, reading direction,
  age rating); later sources only fill fields still empty. **Genres, tags and alternative titles are combined**
  from every source: what one site has and another doesn't is added. **Genres** (Action, Romance, …) are kept
  apart from **tags** (themes like *Time Travel*), both from the sites and from `ComicInfo.xml` (`<Genre>` vs
  `<Tags>`).
- **One name per genre/tag.** Different spellings and synonyms become one name everywhere (sites, files, folder
  sources, filters): *Sci Fi*, *SciFi*, *Science Fiction* → **Sci-Fi**; *Shonen* → *Shounen*; *Humor* →
  *Comedy*; *Yaoi*/*BL* → *Boys' Love*; case, accents, spaces, dashes and plurals (*Pirates* = *Pirate*) don't
  matter. A genre isn't repeated as a tag. Filtering by any spelling finds the same works. The list of known
  synonyms is in `library/metadata/terms.js`.
- **What wins.** Your edits (series *Edit*) > folder sources > the files' `ComicInfo.xml` > online metadata.
  Genres and tags are the exception: those of every source are combined (your edited list replaces them). Titles always stay
  the library's, so versions keep grouping and works stay recognizable.
- **When.** With *Fetch metadata automatically* on (default), works that were never looked up are queued
  after each scan. Each library's card has **Update metadata** (the delta: only works never looked up, works
  whose files changed since their last check, matched works missing a cover, and works not checked for 30 days)
  and **Refresh all metadata** (every work again). A check that finds the same data doesn't mark the work as
  updated (so "Recently updated" only shows real changes). Every
  work page has **Refresh metadata**, **Identify** (search the sites and pick the right match, one per site;
  you can pick several sites at once, e.g. AniList *and* Kitsu, which then runs **in the background as a task**
  (Processes → Tasks) while you keep using the app, and the page updates when it's done; the picks stick for
  future refreshes) and
  **Clear metadata**. *Update metadata* (and *Refresh all*) first re-matches the library's folder-source JSON
  files, so fixed or new JSON files are picked up right away.
- **Links.** A work keeps the web addresses of its matches and shows one line per source on its page
  (*Metadata from: AniList*, *Kitsu*, *example.org*; each name opens its page). They also come from folder-source JSON (`url`, `urls`, `link`, `links`,
  `source`, `sources`, `web`) and can be edited (Edit → Links, one per line; your list replaces the others,
  empty brings them back). A link to a known site (AniList, MangaDex, MangaUpdates, Kitsu, MyAnimeList, Open
  Library, Google Books, Comic Vine) is used as an exact match: that entry is read directly, without searching.
- **Covers from links.** The cover picker offers the cover of every linked site entry and, for any other page,
  the image it publishes for sharing (`og:image`). Pages on this machine or the local network are never fetched.
- **Every matched site's cover is downloaded** when a work is matched (*Work 1* matched on AniList and Kitsu →
  both covers are on the server, `data/covers/candidates/`); works matched earlier get theirs from a background
  task after startup. The cover picker shows them from those copies, at once.
- **The cover picker** (Edit → Cover) shows the covers it already knows at once. It searches the online sites for
  more only when that's due (once a week per work) or when asked (*Search the sites again*), for a few seconds at
  most: a site that's slow or busy with other lookups is skipped rather than waited for. Previews that a site doesn't
  send in time show *Not available* instead of loading forever.
- **Covers** are downloaded as part of every metadata check (from the first source that has one; if that
  image fails, the next source's) and stored in `data/covers/`. Per library: show them only when the files
  have no cover page (default, e.g. PDFs), always, or never (never = not downloaded). Per work (Edit → Cover):
  library setting, first page, or downloaded cover. *Update metadata* also downloads covers still missing for
  matched works. The work page says where its cover came from.
- **Rate limits.** Lookups run inside the web server, several works at once (Server settings, default 3), with
  a pause between requests to the same site and automatic retries when a site says "too many requests" (and one
  retry when a connection fails). A big
  library takes a while the first time; the Processes page shows progress and time left.
- **Privacy.** Only work titles (and, for Identify, what you type) are sent to the metadata sites, with a
  generic user agent. Nothing about your users or server is sent. Turn off every source of a library to keep
  it fully offline.
- Works can be filtered by **type** on library pages.

### Metadata sources page and folder sources

**Metadata sources** (sidebar, administrators) lists every source: the online sites (with whether their API
key is set, which libraries use them and a *Try* search to see what a site answers) and your **folder
sources**.

A **folder source** is a folder of JSON files you keep, matched to your files by name, e.g. `11.json` →
`11.cbz`. Add one with *Add folder source*: a name, the folder (type it or *Browse*), and how to match:

| Match | JSON file | Describes |
| --- | --- | --- |
| **Same structure as the library** (default) | `One Piece.json` or `One Piece/series.json` | the work in the folder `One Piece/` |
| | `One Piece/11.json` | the book `One Piece/11.cbz` (or `.zip`, `.pdf`) |
| **By file name** | `11.json` anywhere in the folder | every book named `11.<ext>` (in any work!) |
| | `One Piece.json` anywhere | the work whose folder is `One Piece` |

- The folder can be the **library folder itself**: JSON files next to the comics (`One Piece/11.json` beside
  `One Piece/11.cbz`).
- A one-shot (a book file directly in the library) uses one JSON for the work and its book (`Short.json`).
- **Covers:** an image named like the work's JSON (`One Piece.jpg`/`.png`/`.webp`), or the JSON's `"cover"`
  (a path inside the folder). Shown according to the library's/work's cover setting.
- **JSON keys** (any case; ComicInfo names like `Summary`, `Genre`, `Writer` work too):
  - `title`: a text, or a **list** whose first entry is the main title and the rest alternative titles
    (`"title": ["One Piece", "ワンピース", "OP"]`). For a work, the main title is shown as its title (versions
    still group by folder name).
  - `tags`, `genres`: lists (or comma-separated text).
  - `artists` (list → artists), `writers`/`authors` (list of names or `{name, role}`), or single `writer`,
    `artist`, `penciller`, `colorist`, `letterer`, `editor`.
  - books also: `number` (or `chapter`, `issue`, `volume`), `summary`, `date`/`releaseDate`;
    works also: `summary`, `status` (ongoing/completed/hiatus/cancelled), `type` (manga, manhwa, …), `year`,
    `publisher`, `rating` (0–10 or 0–100), `ageRating`, `readingDirection` (rtl/ltr/continuous),
    `altTitles`, `sortTitle`, `cover`, `url`/`links` (web addresses, see *Links* above). Other keys are ignored.
- **Unreadable JSON files are ignored** (they're listed in *Check matches*); with two files of the same name, a
  broken one never hides a good one.
- **In memory:** a source's JSON files are read once and kept in memory (parsed); later runs only re-read
  files whose size or date changed, and matching works and books against them never touches the disk.
- **Precedence:** your edits > folder sources > `ComicInfo.xml` > online sites. Several folder sources:
  the first in the library's order fills each field. Folder sources always come before online sites.
- **When it's read:** after every scan (new chapters get their JSON right away), on *Refresh metadata*, and
  with *Apply now*. Nothing goes over the network.
- **Check matches** shows, per library, how many works and books a source matches (with examples), JSON files
  that match nothing, names used by several files (by-name matching) and files that aren't valid JSON.
- Each library can turn a folder source off (Manage libraries → Edit). Deleting a source removes its data
  from works and books; the JSON files themselves are never changed.

### Restarts are automatic

`npm start` (and the Docker image and systemd service, which run the same command) starts a small
supervisor process that runs the real server as a child. After an update that changes server code, the
server exits with a "restart me" code and the supervisor starts the new code within a second; open pages
reload on their own. **Restart server** on the Processes page does the same. If the server crashes, the
supervisor starts it again (it gives up after 5 crashes in a minute, so a broken install doesn't loop
forever; systemd/Docker then take over). Stopping the supervisor (Ctrl+C, `systemctl stop`, `docker stop`)
stops the server cleanly. `THOTH_NO_SUPERVISOR=1` runs the server without it.

The library page shows scan results: new/changed/removed books, files skipped for unsupported formats,
and books that couldn't be opened. Removing a library from Thoth never deletes files.

**Locked out?** If no administrator can sign in, stop the server, delete `data/users.json` (this removes
all accounts) and start it again to get the *Create the first user* screen back.

### Where data is stored

`data/` (or `THOTH_DATA_DIR`) holds `users.json` (password hashes use scrypt), `sessions.json`,
`settings.json`, `library.json` (libraries, series, books, metadata edits, collections, read lists) and
`progress.json` (reading progress), `config.json` (server settings and metadata API keys) and `covers/`
(downloaded metadata covers). Back this folder up; your comic files are never stored there. It's never served to browsers, never committed to git, never
copied into the container image, and never touched by updates. Sessions are HttpOnly cookies that last
30 days. After 10 failed sign-ins from one address, sign-in is blocked for that address for 15 minutes.

## Run in a container (recommended for headless servers)

Needs Docker with the Compose plugin. Docker restarts the container on server boot
(Docker itself must be enabled at boot: `sudo systemctl enable docker`).

```bash
git clone https://github.com/ChonaCio/Thoth.git && cd Thoth
cp .env.example .env          # set THOTH_MEDIA_DIR to your comics folder, e.g. /srv/comics
docker compose up -d --build
```

Then open `http://<server-ip>:3000` from any device, create the first user, and add a library with the
folder **`/media`** (your `THOTH_MEDIA_DIR`, mounted read-only) or a subfolder of it. To use several
folders, mount more volumes in `docker-compose.yml` (e.g. `- /mnt/manga:/manga:ro`) and add each as a library. The address the container prints in its log
is its internal Docker IP; use the server's own IP instead (`hostname -I`).

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f` |
| Status / health | `docker compose ps` |
| Restart (after editing `.env`) | `docker compose up -d` |
| Stop | `docker compose down` |
| Back up accounts | `docker compose cp thoth:/app/data ./thoth-data-backup` |
| Reset everything (drops installed updates **and all accounts**) | `docker compose down -v && docker compose up -d --build` |

The app files and the `data/` folder live in the `thoth-app` volume, so accounts and updates installed
from the Updates page survive restarts and container re-creation. When an update changes the server code, the built-in
supervisor restarts the server inside the container with the new code. Because the volume keeps the files, rebuilding the
image alone does not change the running code; install updates from the Updates page instead.

Without Compose:

```bash
docker build -t thoth .
docker run -d --name thoth --restart unless-stopped -p 3000:3000 \
  -v thoth-app:/app -v /srv/comics:/media:ro thoth
```

### File management (renaming, deleting duplicates, merging works)

**File management** (sidebar, administrators) has two tabs: *Rename files* and *Merge works*.

**Rename files** checks a library, or all of them, for book files whose names don't
follow the usual format and suggests new names:

| Now | Suggested |
| --- | --- |
| `chapter-0.cbz` | `Chapter 0.cbz` |
| `chapter-1.1.cbz` | `Chapter 1.1.cbz` |
| `chapter-1x1.cbz` | `Chapter 1.1.cbz` |
| `Chapter 001.cbz` | `Chapter 1.cbz` |
| `chapter-83-the-end.cbz` | `Chapter 83 - The End.cbz` |
| `chapter-1-chapter name.cbz` | `Chapter 1 - Chapter Name.cbz` |
| `ch_12_the_end.cbz` / `Ch 12.cbz` | `Chapter 12 - The End.cbz` / `Chapter 12.cbz` |
| `vol.3.cbz`, `ep-4.pdf`, `iss_5.cbz` | `Volume 3.cbz`, `Episode 4.pdf`, `Issue 5.cbz` |

Names starting with chapter/chap/ch/c, volume/vol/v, episode/ep or issue + a number (`1`, `1.1`, `1x1`),
optionally followed by a name, get the word capitalized and spelled out and the name in title case; anything
else is left alone. Numbers lose leading zeros (`007` → `7`) and an `x` between numbers becomes a point
(`1x1` → `1.1`). In a file name without spaces the dashes are spaces (`the-end` → `The End`); a name that has
spaces keeps its dashes (`Chapter 5 - Spider-Man`). A change of **capitalization alone isn't proposed**
(`chapter 5.cbz` stays).

**Missing decimal points.** Each work's chapter numbers are compared with each other: a number far past the rest
that, with its last digit as a decimal, falls inside the run, next to a chapter the work has, on a number it
doesn't have, is suggested (`Chapter 505` in a work with chapters 1–70 → `Chapter 50.5`). These are guesses:
shown with the reason, **never selected** until you tick them (*Select all* leaves them out).

**Names that clash.** When the new name is taken, or two files would get it, the row lists **every file involved**:
pages, size, date, how many readers have progress in it, and a mark when two look like the same chapter twice
(same pages and size); the one with the most pages is in bold. Each file can be deleted from there. The list is grouped by work; pick what to rename (all proposals are selected at first) and
click *Rename selected*. Proposals whose new name already exists, or that two files would share, are shown
but never applied.

Renaming keeps everything attached to the book: reading progress and read lists move to the new name, and with
*Also rename matching JSON files of folder sources* (on by default) `chapter-1.json` becomes `Chapter 1.json` so
it still matches.

**Deleting duplicates.** When a file's new name is already taken by another file (*name exists*), the row shows
both files (pages and size) and offers **Delete this file** or **Keep this one** (the other is deleted and this
one renamed). A bar above the list does it for all of them at once: delete those files (keep the existing ones)
or delete the existing ones (rename these). Deleting can't be undone and always asks first; reading progress
and read-list entries of a deleted file go with it.

**Merging works.** *Merge works* moves the chapters the kept work doesn't have yet into its folder, so the works
become one (reading progress and read lists follow the files; emptied folders are removed). The kept work gains
the other works' titles it doesn't have (their main and alternative titles) as **alternative titles**, and when
one of them is in English and the kept one's title isn't, the English one becomes its title (unless you set the
title by hand). A chapter it already
has is a **repeat** and isn't moved: same file name, or the same chapter (`chapter-2.cbz` = `Chapter 2.cbz` =
`Chapter 2 - Title.cbz`, also by the number in the book's own metadata). Tick *Delete the other folders when done*
to delete the other works' folders after the merge, with the repeats and anything else left in them (never the
library folder, nor a folder that holds the kept work). It **suggests** merges when the
metadata says two works are the same: matched to the same entry of a metadata site, sharing a link, or sharing
a title (main or alternative). Different versions (Colored, Raw…) are never suggested: they're already shown
as versions of one work. *Not the same* hides a suggestion for good. *Merge works by hand* finds any works by
title or folder to merge them.

**When the list is behind the disk.** After renaming, deleting or merging, every file of the library is checked
(not a quick scan): some disks and mounts (Docker bind mounts, network shares, FAT/exFAT drives) don't update a
folder's date reliably, and a quick scan trusting it would bring old file names back, so the same renames would be
proposed again. Checking also looks for each proposed file on disk: one that already has its new name isn't
proposed, and that library's files are re-checked so the list catches up.

**Large batches.** Renaming, deleting and merging are background **jobs**: *Rename selected* answers at once and the page shows the
job's progress (you can leave and come back). Jobs wait in a queue and run one at a time; each goes through its
files in chunks of 200, handed to a separate low-priority process (started for the queue, closed when it's
empty), and the server keeps answering between chunks. The list shows the first 2000 proposals (the counts
cover all); *Select all* renames every proposal, also those not listed, except the ones you untick, so even
hundreds of thousands of files take one click. The naming-rule examples on the page are produced by the rules
themselves. A quick scan runs afterwards to put chapters in order. Files the server may not rename
(read-only library folders) are reported.

A job says what it is doing: waiting for the job before it, reading a folder source (to find the JSON files
to rename along — a big one takes a while after a restart), checking the proposals, then the file it is on.
A file **in use by another program** (a reader, an antivirus scan, a sync tool) is tried again for a moment,
then reported as *in use by another program (locked)* and the job goes on with the rest. When the disk
doesn't answer at all (a network drive gone), the page says for how long; after 2 minutes
(THOTH_RENAME_STALL_MS) that file is reported *the disk stopped answering*, the rename process is restarted
and the job continues.

### Editing a work

The work's *Edit* dialog opens with its **current values**, wherever they come from (its own edits, a folder
source, `ComicInfo.xml`, the matched online metadata, or its books for year/authors), and each field says
where its value comes from. Only the fields you change are saved; the others keep following their source
(so later metadata updates still reach them). Clearing a field goes back to the automatic value. Editable:
title, sort title, alternative titles (one per line), summary, authors, year, status, publisher, type,
genres, tags, cover, reading mode, chapter layout and order, version.

**Cover**: the picker shows every image available for the work: *Automatic* (library setting), the first
page, the downloaded cover, the cover of **each** matched site (the sites not asked during the lookup are
searched when the picker opens), images in folder sources that belong to the work, and the current own cover.
**Upload image** adds your own (scaled to at most 1600 px in the browser). A picked or uploaded image is saved
as the work's own cover (`data/covers/custom-…`) and always used. Previews of site covers go through the
server, so the browser never contacts the metadata sites.

### External catalog (sites as sources)

**External catalog** (sidebar, administrators, with the other server tools) lists every work found on external
sites added as **sources**, with its metadata and chapter list.

- **Catalog tab:** search (titles, alternative titles, authors), filter by source, genre and *in my library / not
  in my library*, sort by title, recently updated or chapters. Works the library already has are marked (matched
  by the site's link, e.g. the same MangaDex entry, else by title). A work's page shows each source's chapter
  list (with links to the site) and, for a work you have, **the chapters your library doesn't have**.
- **Merge tab (administrators):** the same work found on several sites (or twice on one) can become one catalog
  entry: the main one's title, cover and summary, every site's chapters. **Certain matches are merged without
  asking**, after every crawl: the same MangaDex entry, or the same title *and* an author or another title in
  common (never two works of different kinds). Other likely matches (same title or alternative title) are
  **suggestions**, shown with each work's cover, other titles, authors, source and chapters to compare;
  *Not the same* hides one. The tab also lists the **merged works** (marked *merged automatically* and why), where
  one source's entry can be **split off** (also from the work's page) or the whole group separated; works split
  apart are never merged automatically again. Both lists can be **filtered by source**.
- **Adding a source: a name and the site's address, nothing else.** Thoth works out the rest, when the source is
  added and again at **every crawl** (so new sitemaps and changed addresses are picked up): it reads the site's
  **robots.txt** (its rules and the sitemaps it names) and looks for **every sitemap** at the usual places too
  (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`…), reads the
  **sitemaps** (indexes followed, `.xml.gz` too) to learn the address pattern of work pages and chapter pages,
  reads the home page (icon, the Madara or MangaReader theme if it runs one) and one work page. The source's card
  says what was found. *Edit* → turning off *Detect the settings automatically* shows every setting to set by hand. Sources set up this way list their works from
  the **sitemaps**: a few requests instead of every list page. Every crawl keeps a **hash of each sitemap file**
  and a fingerprint of each work in it (its date and the chapter addresses listed under it); an *Update* skips
  sitemap files whose date in the index or whose content didn't change, and in a changed file reads only the
  works that are new or whose entries changed (the hashes are saved again after a crawl that finished). Sites without a known theme use the generic reader (title, cover and summary from the page's standard
  tags; chapters = links whose address matches the chapter pattern).
- **Icons:** each source shows its site's own icon (the one its pages declare, else `/favicon.ico`).
- **Adding or editing a source is a wizard:** *Site* (a name and the address; *Detect settings* reads its robots.txt,
  sitemaps and pages; with automatic settings that's all it needs) → *Kind of site* → *Works list* → *Work page* →
  *Chapters* → *Crawling* → *Test and save* (steps that don't apply are skipped: a known theme needs no selectors).
  Every selector can be typed or **picked in a preview of the site**, like the browser's "select an element" tool:
  press *Pick* next to a setting, hover the page (the element under the pointer is outlined) and click it — the
  wizard writes a selector the crawler understands, outlines everything it matches and shows a sample (for a work
  in the list it finds the repeating block; link, title and cover are found inside it; genres and authors match
  all their siblings). *Navigate* mode follows the site's links instead. The page is fetched by the server (with
  the crawler's politeness rules) and shown **with the site's images, styles and fonts**, which your browser loads
  from the site. Options above the preview:
  - *Images and styles* — off shows a copy that loads nothing from the site (styles inlined, images as placeholders).
  - *Site scripts* — runs the site's own scripts, for pages that build their content with scripts; the preview is
    then fully isolated from Thoth (it can't reach the app, its cookies or its API). Off (the default), the site's
    scripts and inline handlers are removed and only the picker can run. Crawls never run a site's scripts, so a
    pick that only exists after them is marked (*not in the page as the site sends it*).
  - *Wait N s before picking* — the picker waits for the page to finish loading (its images and styles), then
    that many seconds more (up to 60), with a countdown; ↻ shows the page again.
- **Clicks before collecting.** When data is behind a tab or a button ("Chapters", "Show all", "More info"), the
  *Works list*, *Work page* and *Chapters* steps each have **Before collecting, click**: up to 5 buttons or tabs,
  picked in the preview, done in order before that page's data is read (the chapters' after the work page's).
  Crawls don't run a site's scripts, so a click is acted out by what the element leads to: an address (its link,
  a `data-url`/`data-href`/`data-load`, a GET form, an address in its `onclick`) is fetched from the same site,
  following robots.txt — *Add what it loads* adds it to the page, *Open the page it leads to* reads that page from
  then on; a tab that only shows what's already in the page needs nothing (its content is read as it is). The
  preview makes the clicks the same way and says under each what it did (*Added what … loads*, *Opened …*, *Leads
  nowhere: what it shows is in the page already*, *Not found on this page*). With *Site scripts* on, the preview
  clicks for real instead (one every 1.5 s).
- **Site files tab:** each source's **robots.txt** and **sitemaps** — the ones in its settings, the ones detection
  found and the ones its last crawl read (with their content hash, date and how many works each listed). Open one
  to read it now: its text, the sitemaps it lists (click to open) and its addresses (searchable).
- **Sources tab:** add a site, *Test* its settings (what the first list page and first work give),
  *Crawl* it (full), *Update* it (the recently updated works and their new chapters), *Stop*, edit or remove it.
  Each source can update every day or week by itself. While it runs, a crawl shows how it's fetching: works at
  once, requests in progress and waiting their turn, and the pause per site. A crawl reads several works at once (*Works at once*,
  default from Server settings) with as many **requests to the site in progress at once** (crawling is mostly
  waiting for answers): each of those lanes pauses before its next request, starts are staggered, a site asking
  to slow down (429/503, Retry-After) makes them all wait, and a robots.txt `Crawl-delay` means one at a time.
  Kinds of site:

| Kind | For | Notes |
| --- | --- | --- |
| MangaDex (API) | mangadex.org | Official API; chapter languages and content ratings are settings. ~95 000 works: a full crawl with chapter lists takes hours. |
| WEBTOON (Originals) | webtoons.com | The genre pages list every Original; episodes come from each series' list pages. Some of those pages are excluded by the site's robots.txt, so very long series get a partial episode list (shown as such). |
| Madara theme | WordPress manga sites using it | List at `/manga/`, chapters from the page or the theme's chapter loader. |
| MangaReader theme | WordPress manga sites using it | List at `/manga/?page=N`. |
| Other site | anything else | Give CSS selectors (list address with `{page}`, each work, title, cover, genres, chapters…; `selector@attribute` for links and images). Use *Test* to check them. |

- **Independent crawls:** each crawl is its own low-priority process, detached from the server: it keeps going
  if the server restarts or stops, and the server picks it up again from its progress file (two at a time; others
  wait in line). *Stop* asks it to save and end; a source being crawled can't be removed until it's stopped.
- **Polite crawling:** the crawler identifies itself with Thoth's generic user agent, **follows each site's robots.txt**, waits between
  requests (setting, 500 ms at least, per lane; robots.txt `Crawl-delay` respected), backs off when the site asks, and never fetches this machine or
  the local network. Sites behind **bot protection** (e.g. Cloudflare challenges) are reported as *blocked*: Thoth
  doesn't try to get around it. Only crawl sites whose terms allow it.
- An interrupted full crawl continues where it stopped; a complete full crawl drops works a site no longer lists.
- **Chapter names are standardized** the way File management renames files: *Chapter 44 - The End*. Dates,
  *3 days ago*, view counts and badges next to the name are dropped, and the number said twice (*Chapter 44 - 44*,
  *Ch. 44 - Ch. 44*) once; the name as the site shows it is kept. Chapter lists that show only the last chapters
  until *Show more* / *Load all* is pressed, or that come in pages, are followed to the end (other-site and Madara
  sources). Covers and alternative titles also come from the page's standard tags (Open Graph, schema.org) and
  rows labeled *Alternative*, *Other names*… when the theme doesn't show them.
- The crawl's progress bar shows the **time left**, from the speed of the works read so far.
- **Premium chapters** (behind coins, a pass, early access, or unavailable on MangaDex) are marked *Premium*: listed,
  but not readable for free right now; the chapters your library lacks say so too (a free copy on another source
  is preferred).
- **Titles without noise, and versions.** What sites add to a title is taken out: `(Official)`, ` - engsub`,
  `[Eng Sub]`, the source's own name (` - Site name`), "Read … Online". Version markers — `[AI ANIMATION]`, `[AI CC]`,
  `[MOTION]` (Animated); `Raw`; `Colored`, `Full Colored` (Colored); `Uncensored`, `Uncen` (Uncensored), several at once,
  in brackets or not — say which version a work is, and **versions of a work are one catalog entry**, as in a
  library: its card says "N versions" and its page has a tab per version (Regular first) over the chapters. Works
  are only merged with works of the same version. (Libraries recognize the same markers in brackets:
  `One Piece [AI ANIMATION]` is the Animated version.)
- **A work's chapters:** tabs over the list — **All chapters** (every chapter of every source once, with a link to
  each source that has it; premium ones marked) and one tab per source.
- **Changed reading settings are applied to every work:** when a source's selectors, clicks, patterns or kind of
  site change, its next *Update* reads every work again (not only the ones the site changed), so nothing keeps
  what the old settings found.
- **English titles first:** a work's title is its English one when the site gives several (tagged by language,
  or the one that reads as English), also for works merged across sources.
- Covers are fetched by the server and cached (`data/cache/catalog-covers/`): browsers never contact the sites.
- Storage: `data/catalog/<source>/` (`works.json`, chapter lists in `chapters/`, `state.json`). Removing a source
  removes them; your library is never changed by the catalog.
### Library and work settings

| Setting | Library (Manage libraries → Edit) | Work (its page → Edit) |
| --- | --- | --- |
| Default order of works | Title A–Z (default), Recently added, Recently updated or Score (readers can still change it on the page) | — |
| Chapters shown as | Tiles (default) or List | Library default, Tiles or List |
| Chapter order | First chapter first (default) or Last chapter first | Library default, either (readers can flip it on the page) |
| Reading mode | Automatic (default: `ComicInfo.xml`, then online metadata, else left to right), or a fixed mode for every work | Library default/automatic, Left to right, Right to left, Continuous |
| Cover | Metadata covers: only when missing (default), always, never | Pick any image: automatic, first page, each matched site's cover, folder-source images, or upload one |

## Tests

`npm test` runs the offline suites (about a minute); `node tests/run.js all` adds the slow and online ones
(scan processes, metadata sites, GitHub). Each suite starts the server from this folder with its own
temporary data folder, so `data/` is never touched. See [HANDOFF.md](HANDOFF.md) for details.

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Markup for sign-in/setup view, app shell, account menu, dialogs, reader |
| `css/styles.css` | Theme tokens (light/dark), layout, components, cards, reader, responsive rules |
| `js/store.js` | API client for the server |
| `js/i18n.js`, `js/i18n-library.js` | Translation strings (en, es, fr, de, pt) |
| `js/icons.js` | Inline SVG icon set |
| `js/app.js` | Routing (`#home`, `#series/<id>`, …), sidebar, account menu, profile, users, updates |
| `js/library.js` | Home, libraries, series, books, search, collections, read lists, library management |
| `js/reader.js` | The reader |
| `server.js` | Zero-dependency web server: page + CSS/JS, accounts API, library API, update API |
| `auth.js` | Accounts: first-user setup, sign-in, sessions, roles, library access |
| `supervisor.js` | Runs the server as a child process and restarts it after updates or crashes |
| `config.js` | Server settings (`data/config.json`), including metadata API keys |
| `library/` | `zip.js` (CBZ reader), `scan-core.js` + `scan-worker.js` (file analysis in a separate low-priority process), `scanner.js` (scan queue, applying results), `media.js` + `media-worker.js` (pages/covers: cache and media process), `rename.js` + `rename-worker.js` (renaming jobs), `db.js` (storage, versions, memoized views), `api.js` (routes), `metadata/` (online metadata: `providers.js` per site, `index.js` queue, merging, covers, Identify) |
| `updater.js` | Checks GitHub for releases/pushes and installs them |
| `Dockerfile`, `docker-compose.yml` | Container setup |
| `deploy/` | systemd service, install/uninstall scripts, nginx example |
| `tests/` | Test suites and runner (`npm test`) |
| `HANDOFF.md` | State of the project for whoever works on it next |

## Updates

The **Updates** page (sidebar, or account menu → *Check for updates*) checks
[github.com/ChonaCio/Thoth](https://github.com/ChonaCio/Thoth) two ways:

| Option | What counts | Ordering |
| --- | --- | --- |
| **Check for releases** | GitHub releases (not drafts) whose tag **and** title are both `vX.Y.Z` | Numeric, major → minor → patch (`v0.10.0` > `v0.9.9`) |
| **Check for pushes** | Any tag named `pN`, with or without a release | By `N` (`p10` > `p9`) |

**Publishing:** for a release, tag the commit `v1.2.3` and create a GitHub release titled `v1.2.3`.
For a push build, tag it `p1`, `p2`, … (`git tag p4 && git push origin p4`).

**Installing** is done by the Node server (`updater.js`) and is a **delta** whenever possible: when the app
knows which commit it's running, it asks GitHub which files differ between that commit and the update,
downloads only those, and deletes the files the update removed (renames included). Nothing is written until
every changed file has been downloaded. If the running commit is unknown (e.g. a copy downloaded as a ZIP) or
more than ~300 files changed, it downloads the whole version instead and copies only the files that differ.
Every replaced or removed file is backed up to `.updates/backup-<time>/`, and the Updates page says how many
files changed. `data/`, `.git`, `.claude`, `.env`, `node_modules` and `.updates` are never touched. If the update changed server code, the server
**restarts itself** right after installing (no manual step), and the open page reloads when it's back.

**Any version, older ones too.** Under each check, *All versions* lists every release (or push) with what it is
to you: *Installed* (reinstall it), *Newer* or *Older* (**downgrade**). Going back always downloads that whole
version (GitHub's comparison can't describe a step backwards), and the same backup is made first. Files that
only newer versions have stay in place (older code doesn't use them). Data saved by a newer version may not be
understood by an older one, which the confirmation says.
- **How the app knows its version.** The version isn't written in a file; the app works out which commit it's
  running, then names it after the repository's tags. *Release* is the highest `vX.Y.Z` release that commit
  contains, and *Push* is the highest `pN` tag it contains. If the code is past a tag, it shows e.g. `p3 +2 commits`.
  The commit comes from whichever changed most recently:
  - a **git checkout**: `.git` is read directly (no git binary needed), so `git pull` updates the version;
  - an **update installed from the Updates page** (recorded in `.update-state.json`);
  - a **container build or `deploy/install.sh` install**: `scripts/stamp-build.js` records the commit in
    `.build-info.json`, because those copies have no `.git` folder.

  Lookups are cached for 10 minutes, and *Check for releases/pushes* always refreshes. The server also prints
  its version when it starts. A copy downloaded as a ZIP (no `.git`, no build info) shows *Unknown* until
  its first update.
- Change the source repo with `thoth.updateRepo` in `package.json` or the `THOTH_UPDATE_REPO` env var.
- Set `GITHUB_TOKEN` to raise GitHub's limit of 60 unauthenticated requests per hour, or to use a private repo.
- Only administrators can check for or install updates. Cross-site requests are rejected.

## Run as a Linux service (start on boot)

Needs a systemd-based Linux (Ubuntu, Debian, Fedora, RHEL, …) and Node.js 18+ installed system-wide.

```bash
git clone https://github.com/ChonaCio/Thoth.git
cd Thoth
sudo bash deploy/install.sh
```

The script:

1. Creates a `thoth` system user (no login shell).
2. Copies the app to `/opt/thoth`, owned by that user, so it can install updates.
3. Creates the settings file `/etc/thoth/thoth.env` (port, listen address, optional `GITHUB_TOKEN`).
4. Installs `/etc/systemd/system/thoth.service`, enables it on boot, starts it and checks that it responds.
5. Prints the addresses other devices can use, warns if a firewall (ufw/firewalld) needs the port opened,
   and reminds you to create the first user.

Accounts, libraries and reading progress are stored in `/opt/thoth/data/`.

**Comic folders:** the service runs as the `thoth` user, which needs read access to your library
folders. For example: `sudo setfacl -R -m u:thoth:rX /srv/comics` (or add `thoth` to a group that can read
them). Folders under `/home` work too; the service can read them but never write to them.

Options: `--dir /opt/thoth`, `--user thoth`, `--port 3000`, `--host 0.0.0.0`, `--no-start`.
Running it again updates the app and unit but keeps your settings, installed-version record and backups.

| Task | Command |
| --- | --- |
| Status | `systemctl status thoth` |
| Logs | `journalctl -u thoth -f` |
| Restart (after editing settings) | `sudo systemctl restart thoth` |
| Stop / start | `sudo systemctl stop thoth` / `sudo systemctl start thoth` |
| Remove from startup (keep files) | `sudo bash deploy/uninstall.sh` |
| Remove everything | `sudo bash deploy/uninstall.sh --purge` |

**Network access.** The service listens on all interfaces (`HOST=0.0.0.0`), so devices connect to
`http://<server-ip>:3000`. Open the port in the firewall if one is active. For HTTPS or port 80, put nginx in front
(see [deploy/nginx-thoth.conf](deploy/nginx-thoth.conf)) and set `HOST=127.0.0.1`.

**Updates under systemd.** When an installed update changes the server code, the built-in supervisor
restarts the server inside the service (the service itself keeps running), and the open page reloads on its own.

**Hardening.** The service runs as an unprivileged user and can only write to its own folder
(`ProtectSystem=strict`, `ReadWritePaths=/opt/thoth`). It can still bind ports below 1024 (e.g. `PORT=80`).

## Notes

- Over plain `http://`, passwords and session cookies travel unencrypted on the network. Use HTTPS
  (nginx + certbot, see `deploy/nginx-thoth.conf`) if the network isn't trusted.
- Add a sidebar page: add an entry to `NAV` in `js/app.js` and a `nav.<id>` string in each language.
- Add a language: add it to `LANGUAGES` and a matching block in `TRANSLATIONS`.
