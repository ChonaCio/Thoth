# Thoth

A self-hosted comic and manga server. Point it at folders of `.cbz`, `.zip` or `.pdf` files and
read them in the browser on any device, with reading progress kept per user.

No dependencies — plain HTML/CSS/JS plus a small Node server (Node.js 18+).

## Features

- **Libraries**: each library is a folder on the server. Every folder inside it that contains books
  becomes a **series**; each file is a **book**. Scanned when the server starts, on a schedule
  (default hourly) and on demand; only new or changed files are analyzed again.
- **Metadata** from `ComicInfo.xml` inside CBZ files (title, number, summary, authors, publisher,
  genres, release date, manga reading direction, webtoon format). Administrators can override any of it;
  their edits survive rescans.
- **Browse**: Home (*Keep reading*, *On deck* = next book in series you've started, recently added),
  per-library series grids with filter, sort and read-status filters, series and book pages, global search
  (series, books, authors, tags, collections, read lists).
- **Reader**: left-to-right, right-to-left (manga) and vertical scroll (webtoon); fit to screen, width,
  height or original size; keyboard, tap zones, swipe and a page slider; preloads upcoming pages; saves
  your page as you read and offers the next book at the end. Settings are remembered per series.
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

**One-shots.** Each library has a one-shots folder. Every book file directly in it becomes its own
single-book series, named after the book (its `ComicInfo.xml` title, else the file name), shown as
*One-shot* and opening straight to the book. By default this is **the library folder itself**, so loose
files next to your series folders are one-shots. In the library's settings you can point it at a subfolder
instead (e.g. `One-shots`, relative to the library folder) or turn it off, in which case loose files in the
library folder are grouped into one series named after the library. Changing it rescans the library;
reading progress is kept.

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

**Two kinds of scan.** *Scan changes* reads only new and changed files (by size and modification time)
and removes books whose files are gone; it's what automatic scans do. *Full scan* reads every file again,
which is slower but fixes anything that looks wrong. Both are on the **Manage libraries** page.

**Scanning runs in its own process: the scan service.** Walking folders and opening archives happens in a
long-running Node process with the lowest CPU priority, so browsing and reading stay fast during big scans.
Libraries are scanned one at a time (others show *Waiting…*). If the process can't be started, scans run
inside the server instead; set `THOTH_SCAN_IN_PROCESS=1` to force that.

**Processes page (administrators).** Shows the web server and the scan service: process ID, uptime,
memory, CPU time, what's being scanned and what's waiting.
- **Scan service: Start / Stop / Restart.** Stopping cancels the scan in progress (it starts over later);
  scans requested while stopped wait in line. A stopped service stays stopped across server restarts until
  you start it. If the service crashes it restarts by itself, and gives up after 3 crashes in a minute.
- **Restart server** works when the server runs under systemd or Docker (they start it again).
- When the server code on disk is newer than the running server (after an update or `git pull`),
  administrators see a notice asking to restart.

The library page shows scan results: new/changed/removed books, files skipped for unsupported formats,
and books that couldn't be opened. Removing a library from Thoth never deletes files.

**Locked out?** If no administrator can sign in, stop the server, delete `data/users.json` (this removes
all accounts) and start it again to get the *Create the first user* screen back.

### Where data is stored

`data/` (or `THOTH_DATA_DIR`) holds `users.json` (password hashes use scrypt), `sessions.json`,
`settings.json`, `library.json` (libraries, series, books, metadata edits, collections, read lists) and
`progress.json` (reading progress). Back this folder up; your comic files are never stored there. It's never served to browsers, never committed to git, never
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
from the Updates page survive restarts and container re-creation. When an update changes the server code, the app exits and Docker's
restart policy starts it again with the new code. Because the volume keeps the files, rebuilding the
image alone does not change the running code; install updates from the Updates page instead.

Without Compose:

```bash
docker build -t thoth .
docker run -d --name thoth --restart unless-stopped -p 3000:3000 \
  -v thoth-app:/app -v /srv/comics:/media:ro thoth
```

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
| `library/` | `zip.js` (CBZ reader), `scan-core.js` + `scan-worker.js` (file analysis in a separate low-priority process), `scanner.js` (scan queue, applying results), `db.js` (storage, versions), `api.js` (routes) |
| `updater.js` | Checks GitHub for releases/pushes and installs them |
| `Dockerfile`, `docker-compose.yml` | Container setup |
| `deploy/` | systemd service, install/uninstall scripts, nginx example |

## Updates

The **Updates** page (sidebar, or account menu → *Check for updates*) checks
[github.com/ChonaCio/Thoth](https://github.com/ChonaCio/Thoth) two ways:

| Option | What counts | Ordering |
| --- | --- | --- |
| **Check for releases** | GitHub releases (not drafts) whose tag **and** title are both `vX.Y.Z` | Numeric, major → minor → patch (`v0.10.0` > `v0.9.9`) |
| **Check for pushes** | Any tag named `pN`, with or without a release | By `N` (`p10` > `p9`) |

**Publishing:** for a release, tag the commit `v1.2.3` and create a GitHub release titled `v1.2.3`.
For a push build, tag it `p1`, `p2`, … (`git tag p4 && git push origin p4`).

**Installing** is done by the Node server (`updater.js`): it downloads the tag's source,
copies the files over the app folder, and backs up every replaced file to `.updates/backup-<time>/`.
Files that no longer exist in the new version are left in place. `data/`, `.git`, `.claude`, `.env`,
`node_modules` and `.updates` are never touched. If `server.js`, `updater.js` or `package.json`
changed, restart the server to finish.

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

**Updates under systemd.** When an installed update changes the server code, the app restarts itself
(`THOTH_SELF_RESTART=1` in the unit), systemd brings it back up, and the open page reloads on its own.

**Hardening.** The service runs as an unprivileged user and can only write to its own folder
(`ProtectSystem=strict`, `ReadWritePaths=/opt/thoth`). It can still bind ports below 1024 (e.g. `PORT=80`).

## Notes

- Over plain `http://`, passwords and session cookies travel unencrypted on the network. Use HTTPS
  (nginx + certbot, see `deploy/nginx-thoth.conf`) if the network isn't trusted.
- Add a sidebar page: add an entry to `NAV` in `js/app.js` and a `nav.<id>` string in each language.
- Add a language: add it to `LANGUAGES` and a matching block in `TRANSLATIONS`.
