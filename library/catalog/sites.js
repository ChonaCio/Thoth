// Site templates: a source's complete settings for one site (or for any site running a known engine), so it can be
// added in one step — no detection, no wizard. Built in (SITES below, each checked against the live site on the
// date in `checked`), plus the administrator's own (db.catalogTemplates: saved from a source, or imported).
//   { id, name, group: 'site' | 'engine' | 'mine', url, hosts, description, notes, checked, settings }
// settings: what parseSource takes (name and, for engines, baseUrl come from the person adding it). Never access
// cookies or headers: those belong to one installation and stay in its source.
// A new source whose address is on a template's host gets that template (createSource), unless asked to detect.
const crypto = require('crypto');
const store = require('../db');
const { db } = store;
if (!Array.isArray(db.catalogTemplates)) db.catalogTemplates = [];

const SITES = [
  {
    id: 'qimanga', group: 'site', name: 'Qi Manga', url: 'https://qimanga.com', hosts: ['qimanga.com'], checked: '2026-11-24',
    description: 'Manhwa and manhua translations. Works and every chapter come from the site’s sitemaps (one chapter file per month); details and the newest chapters from each series page. Chapters that cost coins are marked as premium.',
    settings: {
      type: 'custom', baseUrl: 'https://qimanga.com', languages: 'en', includeChapters: true, gapMs: 1500,
      listing: 'sitemap', sitemaps: ['https://qimanga.com/sitemap.xml'], workPattern: '/series/*', chapterPattern: '/series/*/*', fullChapters: false,
      selectors: {
        workTitle: 'h1.series-title', workCover: 'img.cover-img@src', altTitles: 'p.alt-titles', altSeparator: '•', summary: '.description',
        genres: '.genres a.genre-tag', type: 'a.badge--type', status: 'a.badge--status', authors: '.status-author',
        chapter: 'li.cl-item', chapterLink: 'a.cl-row@href', chapterTitle: '.cl-chap-title || .cl-num', chapterDate: '.cl-date', chapterPremium: '.cl-price'
      },
      clean: { summary: { remove: '^Synopsis[^\\n]*\\n' } }
    }
  },
  {
    id: 'vortexscans', group: 'site', name: 'Vortex Scans', url: 'https://vortexscans.org', hosts: ['vortexscans.org'], checked: '2026-11-24',
    description: 'Manhwa translations. Works and every chapter come from the site’s sitemaps; details from each series page (its schema.org markup). The site’s robots.txt closes its API, so the chapter list is the sitemaps’ plus what the page shows.',
    settings: {
      type: 'custom', baseUrl: 'https://vortexscans.org', languages: 'en', includeChapters: true, gapMs: 1500,
      listing: 'sitemap', sitemaps: ['https://vortexscans.org/sitemap.xml'], workPattern: '/series/*', chapterPattern: '/series/*/*', fullChapters: false,
      selectors: {
        workTitle: 'h1[itemprop=name]', workCover: 'img[itemprop=image]@src', summary: '[itemprop=description]', genres: '[itemprop=genre]',
        type: 'a[href*="seriesType"]', status: 'dl > div:nth-child(1) dd', authors: 'dl > div:nth-child(3) dd',
        chapter: 'section section a[href*="/chapter-"]', chapterTitle: 'span', chapterDate: 'time'
      }
    }
  },
  {
    id: 'manganato', group: 'site', name: 'MangaNato', url: 'https://www.manganato.gg', hosts: ['manganato.gg'], checked: '2026-11-24',
    description: 'A large manga, manhwa and manhua catalog. Works come from the sitemaps (its robots.txt closes the numbered list pages); details from each manga page; the chapter list from the address the page itself loads it from.',
    settings: {
      type: 'custom', baseUrl: 'https://www.manganato.gg', languages: 'en', includeChapters: true, gapMs: 2000,
      listing: 'sitemap', sitemaps: ['https://www.manganato.gg/sitemap.xml'], workPattern: '/manga/*', chapterPattern: '/manga/*/*',
      selectors: {
        workTitle: '.manga-info-text h1', workCover: '.manga-info-pic img@src', altTitles: '.story-alternative', altSeparator: ',', summary: '#contentBox',
        genres: '.manga-info-text li.genres a', authors: '.manga-info-text li:nth-child(2) a || .manga-info-text li:nth-child(2)', status: '.manga-info-text li:nth-child(3)',
        chapter: '.chapter-list .row', chapterLink: 'a@href', chapterDate: 'span:nth-child(3)'
      },
      clean: { altTitles: { label: true }, authors: { label: true }, status: { label: true }, summary: { remove: '^[^\\n]*?summary:\\s*' } }
    }
  },
  {
    id: 'manta', group: 'site', name: 'Manta', url: 'https://manta.net', hosts: ['manta.net'], checked: '2026-11-24',
    description: 'Official comics, manga and novels. Works from the sitemap (English pages); details and the episode list from the data in each series page. Episodes are mostly paid: those not free right now are marked as premium.',
    notes: 'Spanish works: set the language to es (their pages are /es/series/…).',
    settings: { type: 'manta', baseUrl: 'https://manta.net', languages: 'en', includeChapters: true, gapMs: 2000, listing: 'sitemap', sitemaps: ['https://manta.net/sitemap.xml'], workPattern: '/en/series/*' }
  },
  {
    id: 'webtoons', group: 'site', name: 'WEBTOON', url: 'https://www.webtoons.com', hosts: ['webtoons.com'], checked: '2026-11-24',
    description: 'WEBTOON Originals, read by Thoth’s own WEBTOON reader: every Original from the genre pages, episodes from each series’ list pages. Pages the site’s robots.txt closes are skipped, so very long series may list only part of their episodes.',
    notes: 'Other languages: es, fr, de, th, id, zh-hant.',
    settings: { type: 'webtoons', baseUrl: 'https://www.webtoons.com', languages: 'en', includeChapters: true, gapMs: 1500 }
  },
  {
    id: 'mangadex', group: 'site', name: 'MangaDex', url: 'https://mangadex.org', hosts: ['mangadex.org'], checked: '2026-11-24',
    description: 'Read through MangaDex’s public API: every work with its titles in all languages, links to other databases, and chapters in the languages chosen.',
    settings: { type: 'mangadex', baseUrl: 'https://api.mangadex.org', languages: 'en', includeChapters: true, gapMs: 250, contentRating: 'safe,suggestive', iconUrl: 'https://mangadex.org/favicon.ico' }
  },
  {
    id: 'mangapill', group: 'site', name: 'MangaPill', url: 'https://mangapill.com', hosts: ['mangapill.com'], checked: '2026-11-24',
    description: 'Manga (the site removed its manhwa). Works from the sitemaps; details and the full chapter list from each manga page.',
    settings: {
      type: 'custom', baseUrl: 'https://mangapill.com', languages: 'en', includeChapters: true, gapMs: 1500,
      listing: 'sitemap', sitemaps: ['https://mangapill.com/sitemap.xml'], workPattern: '/manga/*/*', fullChapters: false,
      selectors: {
        workTitle: 'h1', altTitles: 'div.mb-3 > div.text-sm', workCover: 'div.flex-shrink-0 img@src', summary: 'p.text-sm',
        type: 'div.grid > div:nth-child(1) > div', status: 'div.grid > div:nth-child(2) > div', year: 'div.grid > div:nth-child(3) > div',
        genres: 'a[href*="genre="]', chapter: '#chapters a'
      }
    }
  },
  {
    id: 'mangakatana', group: 'site', name: 'MangaKatana', url: 'https://mangakatana.com', hosts: ['mangakatana.com'], checked: '2026-11-24',
    description: 'Manga and manhwa. Its sitemap lists no works, so the manga directory is read page by page (/manga/page/N); details and chapters from each manga page.',
    settings: {
      type: 'custom', baseUrl: 'https://mangakatana.com', languages: 'en', includeChapters: true, gapMs: 2000, listing: 'pages', fullChapters: false,
      selectors: {
        listUrl: '/manga/page/{page}', firstPage: '1', maxPages: '2000', item: '#book_list .item .title a',
        workTitle: 'h1.heading', workCover: '.cover img@src', altTitles: '.alt_name', altSeparator: ';', summary: '.summary p',
        genres: '#single_book .genres a', authors: '#single_book .authors a', status: '#single_book .value.status',
        chapter: '.chapters tr', chapterLink: 'a@href', chapterTitle: '.chapter a', chapterDate: '.update_time'
      }
    }
  },
  // Engines: any site that runs them (its address is asked for)
  {
    id: 'engine-madara', group: 'engine', name: 'Madara theme (WordPress)', hosts: [],
    description: 'Many scanlation sites run WordPress with the Madara theme (/manga/<title>/, chapters in li.wp-manga-chapter). Thoth’s Madara reader lists the works and loads the chapters the way the theme does.',
    settings: { type: 'madara', includeChapters: true, gapMs: 1500 }
  },
  {
    id: 'engine-mangareader', group: 'engine', name: 'MangaReader / Themesia theme (WordPress)', hosts: [],
    description: 'Sites with /manga/?page=N&order=update listings and a #chapterlist (the "ts" themes). Read by Thoth’s MangaReader reader.',
    settings: { type: 'mangareader', includeChapters: true, gapMs: 1500 }
  },
  {
    id: 'engine-nato', group: 'engine', name: 'MangaNato family (2025 sites)', hosts: [],
    description: 'Sites built like MangaNato (.manga-info-text, the chapter list loaded from /api/manga/<slug>/chapters): the same settings as the MangaNato template, for its sister sites. Check with Test.',
    settings: null // (filled from the MangaNato template below)
  }
];
SITES.find(t => t.id === 'engine-nato').settings = (() => { const s = JSON.parse(JSON.stringify(SITES.find(t => t.id === 'manganato').settings)); delete s.baseUrl; delete s.sitemaps; return s; })();

// A source's settings worth sharing: how it reads the site (not its schedule, limits, blacklist or access)
const SHARED = ['type', 'baseUrl', 'languages', 'contentRating', 'includeChapters', 'gapMs', 'concurrency', 'listPath', 'selectors', 'clean', 'actions', 'render', 'renderWaitMs',
  'listing', 'sitemaps', 'workPattern', 'chapterPattern', 'chaptersUrl', 'fullChapters', 'iconUrl'];
function settingsOf(src) {
  const out = {};
  for (const k of SHARED) if (src[k] != null && src[k] !== '' && !(Array.isArray(src[k]) && !src[k].length) && !(typeof src[k] === 'object' && !Array.isArray(src[k]) && !Object.keys(src[k]).length)) out[k] = JSON.parse(JSON.stringify(src[k]));
  return out;
}
const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

const view = (t, builtIn) => ({ id: t.id, group: t.group, name: t.name, url: t.url || (t.settings && t.settings.baseUrl ? new URL(t.settings.baseUrl).origin : null), hosts: t.hosts || [],
  description: t.description || '', notes: t.notes || '', checked: t.checked || null, builtIn, needsUrl: !(t.settings && t.settings.baseUrl),
  type: t.settings && t.settings.type, settings: t.settings, created: t.created || null, from: t.from || null });
function list() { return SITES.map(t => view(t, true)).concat(db.catalogTemplates.map(t => view(t, false))); }
function get(id) { const t = SITES.find(x => x.id === id) || db.catalogTemplates.find(x => x.id === id); return t ? view(t, SITES.includes(t)) : null; }
// The template for a site's address: the administrator's own first (a newer copy of a built-in one), then the built-in
function forUrl(url) {
  const h = hostOf(url);
  if (!h) return null;
  const hit = t => (t.hosts || []).some(x => h === x || h.endsWith('.' + x));
  const t = db.catalogTemplates.slice().reverse().find(hit) || SITES.find(hit);
  return t ? view(t, SITES.includes(t)) : null;
}

// Save one (from a source, or imported): validate(settings) is the source validator (throws on bad settings)
function save(body, validate) {
  const b = body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('nameRequired'), { status: 400, code: 'nameRequired' });
  const settings = settingsOf(validate(Object.assign({}, b.settings || {}, { name, baseUrl: (b.settings && b.settings.baseUrl) || b.url || '' })));
  const hosts = [...new Set((Array.isArray(b.hosts) ? b.hosts : [settings.baseUrl]).map(x => (/^[a-z][\w+.-]*:\/\//i.test(String(x)) ? hostOf(x) : String(x || '').trim().toLowerCase().replace(/^www\./, ''))).filter(x => /^[a-z0-9.-]+\.[a-z]{2,}$|^127\.0\.0\.1$|^localhost$/.test(x)))].slice(0, 10);
  const t = { id: 'my-' + crypto.randomBytes(4).toString('hex'), group: 'mine', name, url: settings.baseUrl ? new URL(settings.baseUrl).origin : null, hosts,
    description: String(b.description || '').trim().slice(0, 600), notes: String(b.notes || '').trim().slice(0, 600), settings, created: new Date().toISOString(), from: b.from ? String(b.from).slice(0, 40) : null };
  db.catalogTemplates.push(t);
  store.saveLibrary();
  return view(t, false);
}
function remove(id) {
  const i = db.catalogTemplates.findIndex(t => t.id === id);
  if (i === -1) throw Object.assign(new Error('notFound'), { status: SITES.some(t => t.id === id) ? 400 : 404, code: SITES.some(t => t.id === id) ? 'builtIn' : 'notFound' });
  db.catalogTemplates.splice(i, 1);
  store.saveLibrary();
}
// What a template file holds (Export): everything but the local bookkeeping
const exported = t => ({ thothTemplate: 1, name: t.name, url: t.url, hosts: t.hosts, description: t.description, notes: t.notes, checked: t.checked, settings: t.settings });

module.exports = { SITES, list, get, forUrl, save, remove, settingsOf, exported, hostOf };
