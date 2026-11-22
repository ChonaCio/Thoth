# Thoth

A web app shell with a login screen, a collapsible left sidebar and a Google-style top bar
with an account menu (user info, edit profile, appearance, language, sign out).

No dependencies — plain HTML/CSS/JS plus a tiny Node static server.

```
npm start      # http://localhost:3000
```

Demo account: `demo` / `demo123` (or click **Create account**).

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Markup for login view, app shell, account menu, profile dialog |
| `css/styles.css` | Theme tokens (light/dark), layout, components, responsive rules |
| `js/store.js` | Users, session and preferences (localStorage) — **replace with API calls when you add a backend** |
| `js/i18n.js` | Languages and translation strings (en, es, fr, de, pt) |
| `js/icons.js` | Inline SVG icon set |
| `js/app.js` | Routing (`#home`, `#settings`, …), sidebar, account menu, profile editing |
| `server.js` | Zero-dependency static server |

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
- The server listens on `127.0.0.1` only and rejects cross-site requests, since the update API writes files.

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

Options: `--dir /opt/thoth`, `--user thoth`, `--port 3000`, `--host 127.0.0.1`, `--no-start`.
Running it again updates the app and unit but keeps your settings, installed-version record and backups.

| Task | Command |
| --- | --- |
| Status | `systemctl status thoth` |
| Logs | `journalctl -u thoth -f` |
| Restart (after editing settings) | `sudo systemctl restart thoth` |
| Stop / start | `sudo systemctl stop thoth` / `sudo systemctl start thoth` |
| Remove from startup (keep files) | `sudo bash deploy/uninstall.sh` |
| Remove everything | `sudo bash deploy/uninstall.sh --purge` |

**Remote access.** By default the app listens on `127.0.0.1` only. To reach it from other machines, either:

- put nginx in front (recommended; also gives you HTTPS via certbot). See [deploy/nginx-thoth.conf](deploy/nginx-thoth.conf).
- or set `HOST=0.0.0.0` in `/etc/thoth/thoth.env` and open the port in your firewall. Anyone who can
  reach it can install updates, since sign-in only happens in the browser.

**Updates under systemd.** When an installed update changes the server code, the app restarts itself
(`THOTH_SELF_RESTART=1` in the unit), systemd brings it back up, and the open page reloads on its own.

**Hardening.** The service runs as an unprivileged user and can only write to its own folder
(`ProtectSystem=strict`, `ReadWritePaths=/opt/thoth`). It can still bind ports below 1024 (e.g. `PORT=80`).

## Notes

- Authentication is client-side only (salted SHA-256 in localStorage). It's fine for prototyping,
  not for production — move auth to a server before real users sign in.
- Add a sidebar page: add an entry to `NAV` in `js/app.js` and a `nav.<id>` string in each language.
- Add a language: add it to `LANGUAGES` and a matching block in `TRANSLATIONS`.
