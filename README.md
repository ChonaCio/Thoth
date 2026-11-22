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

## Notes

- Authentication is client-side only (salted SHA-256 in localStorage). It's fine for prototyping,
  not for production — move auth to a server before real users sign in.
- Add a sidebar page: add an entry to `NAV` in `js/app.js` and a `nav.<id>` string in each language.
- Add a language: add it to `LANGUAGES` and a matching block in `TRANSLATIONS`.
