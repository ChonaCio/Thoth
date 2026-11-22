# Thoth

A web app shell with a login screen, a collapsible left sidebar and a Google-style top bar
with an account menu (user info, edit profile, appearance, language, sign out).

No dependencies — plain HTML/CSS/JS plus a tiny Node static server.

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

**Locked out?** If no administrator can sign in, stop the server, delete `data/users.json` (this removes
all accounts) and start it again to get the *Create the first user* screen back.

### Where data is stored

`data/` (or `THOTH_DATA_DIR`) holds `users.json` (password hashes use scrypt), `sessions.json` and
`settings.json`. Back this folder up. It's never served to browsers, never committed to git, never
copied into the container image, and never touched by updates. Sessions are HttpOnly cookies that last
30 days. After 10 failed sign-ins from one address, sign-in is blocked for that address for 15 minutes.

## Run in a container (recommended for headless servers)

Needs Docker with the Compose plugin. Docker restarts the container on server boot
(Docker itself must be enabled at boot: `sudo systemctl enable docker`).

```bash
git clone https://github.com/ChonaCio/Thoth.git && cd Thoth
cp .env.example .env          # optional: THOTH_PORT if 3000 is taken, GITHUB_TOKEN
docker compose up -d --build
```

Then open `http://<server-ip>:3000` from any device and create the first user. The address the container prints in its log
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
docker run -d --name thoth --restart unless-stopped -p 3000:3000 -v thoth-app:/app thoth
```

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Markup for sign-in/setup view, app shell, account menu, profile and user dialogs |
| `css/styles.css` | Theme tokens (light/dark), layout, components, responsive rules |
| `js/store.js` | API client for the server (session, profile, users, settings) |
| `js/i18n.js` | Languages and translation strings (en, es, fr, de, pt) |
| `js/icons.js` | Inline SVG icon set |
| `js/app.js` | Routing (`#home`, `#users`, …), sidebar, account menu, profile, user management, updates |
| `server.js` | Zero-dependency web server: static files, accounts API, update API |
| `auth.js` | Accounts: first-user setup, sign-in, sessions, roles, user management |
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

Accounts are stored in `/opt/thoth/data/`.

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
