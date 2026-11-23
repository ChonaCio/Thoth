# Thoth

A self-hosted comic and manga server. Point it at folders of `.cbz`, `.zip` or `.pdf` files and
read them in the browser on any device, with reading progress kept per user.

No dependencies — plain HTML/CSS/JS plus a small Node server (Node.js 18+).

## Features

- **Libraries**: each library is a folder on the server. Every folder inside it that contains books
  becomes a **series**; each file is a **book**. The first scan reads everything; after that, quick scans at
  startup and on a schedule (default hourly) only look into folders that changed, and only new or changed
  files are opened again. Full scans run only when you ask. Each library has a **default order** (A–Z,
  recently added or recently updated), a default chapter layout and a default reading mode.
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
  type, status, genre, tag and metadata state can be **included or excluded** (click once to include, twice to
  exclude), combined with a year range and an author. Works need all included genres/tags and none of the
  excluded ones; for type, status and metadata any included value matches. Each value shows how many works
  have it, the chosen criteria show as removable chips, and the address keeps them (bookmarkable). Genre/tag
  chips on a work page open the library filtered by them. Global search covers series, books, authors,
  genres, tags, collections and read lists.
- **Page cache**: pages you've opened are kept in the browser. Switching between them within a minute needs
  no request at all; after that, or after something changed, the page shows at once and refreshes in the
  background.
- **Deleting works** (administrators, work page → *Delete*): **hide** it (logical delete: gone for everyone,
  files untouched, stays hidden after scans; *Hidden works* on the library page lists them with *Restore*) or
  **delete its files** from the disk (physical: type the title to confirm; the work's folder goes too if it's
  left empty; files the server can't delete — read-only mounts, no permission — are reported and kept). With
  several versions you choose this version or all of them.
- **Going back** (browser Back or the back link) returns to exactly where you were: same scroll position, the
  same works loaded with *Load more*, same search, order and filters. All work tiles have the same size.
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
`One Piece (Animated)`. They're combined into one work "One Piece" (one card, "2 versions"), and its page has a
tab per version, in the order **Regular, Colored, Raw, Uncensored, Animated**; each tab lists that version's
chapters/books, with its own progress and metadata.
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
pool of long-running Node processes with the lowest CPU priority, so browsing and reading stay fast during
big scans. A scan lists the library's files in one process, then spreads the new/changed files over all of
them in small batches, each process reading several files at once. Libraries are scanned one at a time
(others show *Waiting…*). If the processes can't be started, scans run inside the server instead; set
`THOTH_SCAN_IN_PROCESS=1` to force that.

**Server settings page (administrators)** — settings for this server, saved in `data/config.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| Scan processes | CPU cores − 1, up to 4 | Processes reading files in parallel. More = faster on multi-core servers (~40 MB memory each). Changing it restarts the scan service. |
| Files at once per process | 4 | Files each process reads at the same time. Higher helps fast disks and network storage; lower is gentler on slow disks. |
| Works looked up at once | 3 | Metadata lookups running in parallel (1–8). Each site still gets a pause between requests. |
| Comic Vine API key | — | Needed to use Comic Vine. Saved on the server, never shown again (only "Saved"). |
| Google Books API key | — | Optional; without one Google Books allows very few lookups. |

**Processes page (administrators).** Shows the web server, the scan service and the metadata lookups:
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
  (the folder name without its version suffix). A result counts only if its title (or an alternative title)
  is a close match; the publication year from the books breaks ties. The **first** good match fills each field
  (summary, status, year, type, publisher, authors, genres, tags, rating, cover, reading direction, age rating);
  later sources only fill fields still empty. It stops once the main fields are filled. **Genres** (Action,
  Romance, …) are kept apart from **tags** (themes like *Time Travel*), both from the sites and from
  `ComicInfo.xml` (`<Genre>` vs `<Tags>`).
- **What wins.** Your edits (series *Edit*) > the files' `ComicInfo.xml` > online metadata. Titles always stay
  the library's, so versions keep grouping and works stay recognizable.
- **When.** With *Fetch metadata automatically* on (default), works that were never looked up are queued
  after each scan. Each library's card has **Update metadata** (the delta: only works never looked up, works
  whose files changed since their last check, matched works missing a cover, and works not checked for 30 days)
  and **Refresh all metadata** (every work again). A check that finds the same data doesn't mark the work as
  updated (so "Recently updated" only shows real changes). Every
  work page has **Refresh metadata**, **Identify** (search the sites and pick the right match; it
  sticks for future refreshes) and **Clear metadata**.
- **Covers** are downloaded as part of every metadata check (from the first source that has one; if that
  image fails, the next source's) and stored in `data/covers/`. Per library: show them only when the files
  have no cover page (default, e.g. PDFs), always, or never (never = not downloaded). Per work (Edit → Cover):
  library setting, first page, or downloaded cover. *Update metadata* also downloads covers still missing for
  matched works. The work page says where its cover came from.
- **Rate limits.** Lookups run inside the web server, several works at once (Server settings, default 3), with
  a pause between requests to the same site and automatic retries when a site says "too many requests". A big
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
    `altTitles`, `sortTitle`, `cover`. Other keys are ignored.
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

### Library and work settings

| Setting | Library (Manage libraries → Edit) | Work (its page → Edit) |
| --- | --- | --- |
| Default order of works | Title A–Z (default), Recently added or Recently updated (readers can still change it on the page) | — |
| Chapters shown as | Tiles (default) or List | Library default, Tiles or List |
| Chapter order | First chapter first (default) or Last chapter first | Library default, either (readers can flip it on the page) |
| Reading mode | Automatic (default: `ComicInfo.xml`, then online metadata, else left to right), or a fixed mode for every work | Library default/automatic, Left to right, Right to left, Continuous |
| Cover | Metadata covers: only when missing (default), always, never | Library setting, First page, Downloaded |

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
| `library/` | `zip.js` (CBZ reader), `scan-core.js` + `scan-worker.js` (file analysis in a separate low-priority process), `scanner.js` (scan queue, applying results), `db.js` (storage, versions), `api.js` (routes), `metadata/` (online metadata: `providers.js` per site, `index.js` queue, merging, covers, Identify) |
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
