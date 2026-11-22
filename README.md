# Thoth

A web app shell with a login screen, a collapsible left sidebar and a Google-style top bar
with an account menu (user info, edit profile, appearance, language, sign out).

No dependencies — plain HTML/CSS/JS plus a tiny Node static server.

```
npm start      # prints the addresses to open, e.g. http://192.168.1.20:3000
```

The server listens on all network interfaces, so any device on the network can open it at
`http://<server-ip>:3000`. Set `HOST=127.0.0.1` to allow only the machine itself.

Demo account: `demo` / `demo123` (or click **Create account**).

> **Accounts are stored per browser.** Sign-in is handled in the browser (localStorage), so each
> device has its own accounts and the demo account; they aren't shared between devices.

## Run in a container (recommended for headless servers)

Needs Docker with the Compose plugin. Docker restarts the container on server boot
(Docker itself must be enabled at boot: `sudo systemctl enable docker`).

```bash
git clone https://github.com/ChonaCio/Thoth.git && cd Thoth
cp .env.example .env          # set THOTH_ADMIN_PASSWORD (and THOTH_PORT if 3000 is taken)
docker compose up -d --build
```

Then open `http://<server-ip>:3000` from any device. The address the container prints in its log
is its internal Docker IP; use the server's own IP instead (`hostname -I`).

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f` |
| Status / health | `docker compose ps` |
| Restart (after editing `.env`) | `docker compose up -d` |
| Stop | `docker compose down` |
| Reset to the image's code (drops installed updates) | `docker compose down -v && docker compose up -d --build` |

The app files live in the `thoth-app` volume, so updates installed from the Updates page survive
restarts and container re-creation. When an update changes the server code, the app exits and Docker's
restart policy starts it again with the new code. Because the volume keeps the files, rebuilding the
image alone does not change the running code; use the reset command above for that.

Without Compose:

```bash
docker build -t thoth .
docker run -d --name thoth --restart unless-stopped -p 3000:3000 \
  -e THOTH_ADMIN_PASSWORD='choose-a-password' -v thoth-app:/app thoth
```

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Markup for login view, app shell, account menu, profile dialog |
| `css/styles.css` | Theme tokens (light/dark), layout, components, responsive rules |
| `js/store.js` | Users, session and preferences (localStorage) — **replace with API calls when you add a backend** |
| `js/i18n.js` | Languages and translation strings (en, es, fr, de, pt) |
| `js/icons.js` | Inline SVG icon set |
| `js/app.js` | Routing (`#home`, `#settings`, …), sidebar, account menu, profile editing |
| `server.js` | Zero-dependency static server + update API |
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
Files that no longer exist in the new version are left in place. `.git`, `.claude`, `.env`,
`node_modules` and `.updates` are never touched. If `server.js`, `updater.js` or `package.json`
changed, restart the server to finish.

- The installed version is stored in `.update-state.json` (fallback: `version.json`).
- Change the source repo with `thoth.updateRepo` in `package.json` or the `THOTH_UPDATE_REPO` env var.
- Set `GITHUB_TOKEN` to raise GitHub's limit of 60 unauthenticated requests per hour, or to use a private repo.
- **Set `THOTH_ADMIN_PASSWORD`.** The app is reachable from the network, so without it anyone who can
  reach the server can install updates. With it, the Updates page asks for the password before installing.
  Checking for updates stays open to everyone.
- Cross-site requests to the update API are rejected.

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
3. Creates the settings file `/etc/thoth/thoth.env` (port, listen address, update password, optional `GITHUB_TOKEN`).
4. Installs `/etc/systemd/system/thoth.service`, enables it on boot, starts it and checks that it responds.
5. Prints the addresses other devices can use, and warns if a firewall (ufw/firewalld) needs the port opened
   or no update password is set.

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
`http://<server-ip>:3000`. Open the port in the firewall if one is active, and set
`THOTH_ADMIN_PASSWORD` in `/etc/thoth/thoth.env`. For HTTPS or port 80, put nginx in front
(see [deploy/nginx-thoth.conf](deploy/nginx-thoth.conf)) and set `HOST=127.0.0.1`.

**Updates under systemd.** When an installed update changes the server code, the app restarts itself
(`THOTH_SELF_RESTART=1` in the unit), systemd brings it back up, and the open page reloads on its own.

**Hardening.** The service runs as an unprivileged user and can only write to its own folder
(`ProtectSystem=strict`, `ReadWritePaths=/opt/thoth`). It can still bind ports below 1024 (e.g. `PORT=80`).

## Notes

- Authentication is client-side only (salted SHA-256 in localStorage). It's fine for prototyping,
  not for production — move auth to a server before real users sign in.
- Add a sidebar page: add an entry to `NAV` in `js/app.js` and a `nav.<id>` string in each language.
- Add a language: add it to `LANGUAGES` and a matching block in `TRANSLATIONS`.
