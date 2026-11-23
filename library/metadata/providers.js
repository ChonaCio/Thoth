// Online metadata providers. Each one can search by title and fetch details, returning a common shape:
//   search(query, keys) → [{ id, title, altTitles, year, type, cover, url }]
//   fetch(id, keys)     → { id, url, title, altTitles, summary, status, year, type, publisher, authors,
//                           tags, rating (0–100), cover (image URL), readingDirection, ageRating }
// type: manga | manhwa | manhua | webcomic | comic | novel | book | other
// No dependencies; requests are rate-limited per provider and identify as a generic client.
const UA = 'Thoth-Library-Server/1.0';
const TIMEOUT = 30000; // some services (MangaUpdates) can take a while; they get longer below

/* ---------------- HTTP with per-provider rate limits ---------------- */
const nextAt = {};
const wait = ms => new Promise(r => setTimeout(r, ms));
async function slot(provider, gapMs) {
  const now = Date.now();
  const at = Math.max(now, nextAt[provider] || 0);
  nextAt[provider] = at + gapMs;
  if (at > now) await wait(at - now);
}
function providerError(provider, message) {
  return Object.assign(new Error(`${provider}: ${message}`), { status: 502, code: 'providerError', provider });
}
async function request(provider, url, { method = 'GET', body, headers = {}, gap = 500, timeout = TIMEOUT, retried = false } = {}) {
  await slot(provider, gap);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, headers),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw providerError(provider, e.name === 'TimeoutError' ? 'no answer (timeout)' : `unreachable (${e.cause && e.cause.code || e.message})`);
  }
  if (res.status === 429 && !retried) {
    const after = Math.min(60, Number(res.headers.get('retry-after')) || 5);
    await wait(after * 1000);
    return request(provider, url, { method, body, headers, gap, timeout, retried: true });
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw providerError(provider, 'access refused (check the API key)');
  if (!res.ok) throw providerError(provider, `answered ${res.status}`);
  try { return await res.json(); } catch { throw providerError(provider, 'sent an unreadable answer'); }
}

/* ---------------- text helpers ---------------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m;
  });
}
function cleanText(s) {
  if (!s) return undefined;
  const t = decode(String(s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t || undefined;
}
const yearOf = v => { const m = /(\d{4})/.exec(String(v || '')); return m ? Number(m[1]) : undefined; };
const uniq = list => [...new Set(list.filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
// "Oda, Eiichiro" → "Eiichiro Oda"
const flipName = n => (/^[^,]+,\s*[^,]+$/.test(n) ? n.split(/,\s*/).reverse().join(' ') : n);

/* ================= AniList (manga, manhwa, manhua, light novels) ================= */
const ANILIST = 'https://graphql.anilist.co';
const anilistType = m => (m.format === 'NOVEL' ? 'novel'
  : m.countryOfOrigin === 'JP' ? 'manga' : m.countryOfOrigin === 'KR' ? 'manhwa' : (m.countryOfOrigin === 'CN' || m.countryOfOrigin === 'TW') ? 'manhua' : 'comic');
const anilist = {
  id: 'anilist', name: 'AniList', homepage: 'https://anilist.co', types: ['manga', 'manhwa', 'manhua', 'novel'],
  async search(q) {
    const r = await request('anilist', ANILIST, { method: 'POST', gap: 800, body: {
      query: 'query($q:String){Page(perPage:8){media(search:$q,type:MANGA){id title{romaji english native} synonyms format countryOfOrigin startDate{year} coverImage{large} siteUrl}}}',
      variables: { q }
    } });
    return ((((r || {}).data || {}).Page || {}).media || []).map(m => ({
      id: String(m.id), title: m.title.english || m.title.romaji, altTitles: uniq([m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])]),
      year: m.startDate && m.startDate.year || undefined, type: anilistType(m), cover: m.coverImage && m.coverImage.large, url: m.siteUrl
    }));
  },
  async fetch(id) {
    const r = await request('anilist', ANILIST, { method: 'POST', gap: 800, body: {
      query: 'query($id:Int){Media(id:$id,type:MANGA){id title{romaji english native} synonyms description(asHtml:false) format status countryOfOrigin startDate{year} genres tags{name rank isMediaSpoiler} averageScore coverImage{extraLarge large} siteUrl isAdult staff(perPage:10){edges{role node{name{full}}}}}}',
      variables: { id: Number(id) }
    } });
    const m = r && r.data && r.data.Media;
    if (!m) return null;
    const authors = [];
    for (const e of (m.staff && m.staff.edges) || []) {
      const role = /story/i.test(e.role) && /art/i.test(e.role) ? ['writer', 'penciller'] : /story|original/i.test(e.role) ? ['writer'] : /art/i.test(e.role) ? ['penciller'] : [];
      for (const ro of role) authors.push({ name: e.node.name.full, role: ro });
    }
    const type = anilistType(m);
    return {
      id: String(m.id), url: m.siteUrl, title: m.title.english || m.title.romaji,
      altTitles: uniq([m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])]),
      summary: cleanText(m.description),
      status: { FINISHED: 'ended', RELEASING: 'ongoing', HIATUS: 'hiatus', CANCELLED: 'abandoned' }[m.status],
      year: m.startDate && m.startDate.year || undefined, type,
      authors: authors.length ? authors : undefined,
      // Genres, plus the community's strongest tags (AniList lists dozens per popular title)
      genres: uniq(m.genres || []),
      tags: uniq((m.tags || []).filter(t => t.rank >= 80 && !t.isMediaSpoiler).sort((a, b) => b.rank - a.rank).slice(0, 8).map(t => t.name)),
      rating: m.averageScore || undefined,
      cover: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large),
      readingDirection: type === 'manga' ? 'rtl' : undefined,
      ageRating: m.isAdult ? 'Adults Only 18+' : undefined
    };
  }
};

/* ================= MangaDex (manga, manhwa, manhua, webcomics) ================= */
const MD = 'https://api.mangadex.org';
const MD_RATINGS = '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic';
const firstValue = o => (o ? o.en || Object.values(o)[0] : undefined);
function mdType(a) {
  const tags = (a.tags || []).map(t => firstValue(t.attributes.name));
  const lang = a.originalLanguage || '';
  if (lang === 'ja') return 'manga';
  if (lang === 'ko') return 'manhwa';
  if (/^zh/.test(lang)) return 'manhua';
  return tags.includes('Web Comic') ? 'webcomic' : 'comic';
}
function mdBasics(m) {
  const a = m.attributes;
  const coverRel = (m.relationships || []).find(r => r.type === 'cover_art' && r.attributes);
  return {
    id: m.id, url: `https://mangadex.org/title/${m.id}`,
    title: firstValue(a.title),
    altTitles: uniq([...Object.values(a.title || {}), ...(a.altTitles || []).flatMap(o => Object.values(o))]),
    year: a.year || undefined, type: mdType(a),
    cover: coverRel ? `https://uploads.mangadex.org/covers/${m.id}/${coverRel.attributes.fileName}.512.jpg` : undefined
  };
}
const mangadex = {
  id: 'mangadex', name: 'MangaDex', homepage: 'https://mangadex.org', types: ['manga', 'manhwa', 'manhua', 'webcomic'],
  async search(q) {
    const r = await request('mangadex', `${MD}/manga?title=${encodeURIComponent(q)}&limit=8&includes[]=cover_art${MD_RATINGS}`, { gap: 300 });
    return ((r && r.data) || []).map(mdBasics);
  },
  async fetch(id) {
    const r = await request('mangadex', `${MD}/manga/${encodeURIComponent(id)}?includes[]=cover_art&includes[]=author&includes[]=artist`, { gap: 300 });
    const m = r && r.data;
    if (!m) return null;
    const a = m.attributes;
    const tags = (a.tags || []).map(t => firstValue(t.attributes.name));
    const genres = (a.tags || []).filter(t => t.attributes.group === 'genre').map(t => firstValue(t.attributes.name));
    const authors = (m.relationships || []).filter(x => (x.type === 'author' || x.type === 'artist') && x.attributes)
      .map(x => ({ name: x.attributes.name, role: x.type === 'author' ? 'writer' : 'penciller' }));
    const b = mdBasics(m);
    return Object.assign(b, {
      summary: cleanText(firstValue(a.description)),
      status: { ongoing: 'ongoing', completed: 'ended', hiatus: 'hiatus', cancelled: 'abandoned' }[a.status],
      authors: authors.length ? authors : undefined,
      genres: uniq(genres),
      tags: uniq([...tags.filter(t => !genres.includes(t) && t !== 'Long Strip' && t !== 'Web Comic' && t !== 'Full Color'), a.publicationDemographic && a.publicationDemographic[0].toUpperCase() + a.publicationDemographic.slice(1)]),
      readingDirection: tags.includes('Long Strip') ? 'vertical' : b.type === 'manga' ? 'rtl' : undefined,
      ageRating: a.contentRating === 'pornographic' || a.contentRating === 'erotica' ? 'Adults Only 18+' : undefined
    });
  }
};

/* ================= MangaUpdates (manga, manhwa, manhua, novels) ================= */
const MU = 'https://api.mangaupdates.com/v1';
const muType = t => {
  const s = String(t || '').toLowerCase();
  if (s === 'manga' || s === 'doujinshi') return 'manga';
  if (s === 'manhwa') return 'manhwa';
  if (s === 'manhua') return 'manhua';
  if (s.includes('novel')) return 'novel';
  if (s === 'artbook') return 'book';
  return s ? 'comic' : undefined;
};
const mangaupdates = {
  id: 'mangaupdates', name: 'MangaUpdates', homepage: 'https://www.mangaupdates.com', types: ['manga', 'manhwa', 'manhua', 'novel'],
  async search(q) {
    const r = await request('mangaupdates', `${MU}/series/search`, { method: 'POST', gap: 500, timeout: 60000, body: { search: q, perpage: 8 } });
    return ((r && r.results) || []).map(x => x.record).filter(Boolean).map(s => ({
      id: String(s.series_id), title: decode(s.title), altTitles: [], year: yearOf(s.year), type: muType(s.type),
      cover: s.image && s.image.url && s.image.url.original, url: s.url
    }));
  },
  async fetch(id) {
    const s = await request('mangaupdates', `${MU}/series/${encodeURIComponent(id)}`, { gap: 500, timeout: 60000 });
    if (!s) return null;
    const statusText = String(s.status || '');
    return {
      id: String(s.series_id), url: s.url, title: decode(s.title),
      altTitles: uniq((s.associated || []).map(a => decode(a.title))),
      summary: cleanText(s.description),
      status: s.completed ? 'ended' : /hiatus/i.test(statusText) ? 'hiatus' : /cancel|discontinu/i.test(statusText) ? 'abandoned' : /ongoing/i.test(statusText) ? 'ongoing' : undefined,
      year: yearOf(s.year), type: muType(s.type),
      publisher: ((s.publishers || []).find(p => p.type === 'Original') || (s.publishers || [])[0] || {}).publisher_name,
      authors: (s.authors || []).length ? s.authors.map(a => ({ name: a.name, role: a.type === 'Artist' ? 'penciller' : 'writer' })) : undefined,
      genres: uniq((s.genres || []).map(g => g.genre)),
      tags: uniq((s.categories || []).filter(c => (c.votes || 0) >= 5).sort((x, y) => (y.votes || 0) - (x.votes || 0)).slice(0, 8).map(c => c.category)),
      rating: s.bayesian_rating ? Math.round(s.bayesian_rating * 10) : undefined,
      cover: s.image && s.image.url && s.image.url.original,
      readingDirection: muType(s.type) === 'manga' ? 'rtl' : undefined
    };
  }
};

/* ================= Kitsu (manga, manhwa, manhua, novels) ================= */
const KITSU = 'https://kitsu.io/api/edge';
const kitsuType = t => ({ manga: 'manga', oneshot: 'manga', doujin: 'manga', manhwa: 'manhwa', manhua: 'manhua', novel: 'novel', oel: 'comic' })[t] || undefined;
function kitsuBasics(d) {
  const a = d.attributes;
  return {
    id: String(d.id), url: `https://kitsu.io/manga/${a.slug}`, title: a.canonicalTitle,
    altTitles: uniq([...Object.values(a.titles || {}), ...(a.abbreviatedTitles || [])]),
    year: yearOf(a.startDate), type: kitsuType(a.subtype), cover: a.posterImage && (a.posterImage.large || a.posterImage.original)
  };
}
const kitsu = {
  id: 'kitsu', name: 'Kitsu', homepage: 'https://kitsu.io', types: ['manga', 'manhwa', 'manhua', 'novel'],
  async search(q) {
    const r = await request('kitsu', `${KITSU}/manga?filter[text]=${encodeURIComponent(q)}&page[limit]=8`, { gap: 300, headers: { Accept: 'application/vnd.api+json' } });
    return ((r && r.data) || []).map(kitsuBasics);
  },
  async fetch(id) {
    const r = await request('kitsu', `${KITSU}/manga/${encodeURIComponent(id)}?include=categories,staff.person`, { gap: 300, headers: { Accept: 'application/vnd.api+json' } });
    if (!r || !r.data) return null;
    const a = r.data.attributes;
    const inc = r.included || [];
    const people = Object.fromEntries(inc.filter(x => x.type === 'people').map(x => [x.id, x.attributes.name]));
    const authors = inc.filter(x => x.type === 'mediaStaff').map(x => {
      const pid = x.relationships && x.relationships.person && x.relationships.person.data && x.relationships.person.data.id;
      const role = String(x.attributes.role || '');
      return people[pid] ? { name: people[pid], role: /art/i.test(role) && !/story/i.test(role) ? 'penciller' : 'writer' } : null;
    }).filter(Boolean);
    return Object.assign(kitsuBasics(r.data), {
      summary: cleanText(a.synopsis || a.description),
      status: { current: 'ongoing', finished: 'ended' }[a.status],
      authors: authors.length ? authors : undefined,
      genres: uniq(inc.filter(x => x.type === 'categories').map(x => x.attributes.title)),
      rating: a.averageRating ? Math.round(Number(a.averageRating)) : undefined,
      readingDirection: kitsuType(a.subtype) === 'manga' ? 'rtl' : undefined,
      ageRating: a.ageRating === 'R18' ? 'Adults Only 18+' : undefined
    });
  }
};

/* ================= MyAnimeList via Jikan (manga, manhwa, manhua, novels) ================= */
const JIKAN = 'https://api.jikan.moe/v4';
const malType = t => ({ Manga: 'manga', 'One-shot': 'manga', Doujinshi: 'manga', Manhwa: 'manhwa', Manhua: 'manhua', Novel: 'novel', 'Light Novel': 'novel', OEL: 'comic' })[t] || undefined;
function malBasics(m) {
  return {
    id: String(m.mal_id), url: m.url, title: m.title_english || m.title,
    altTitles: uniq([m.title, m.title_english, m.title_japanese, ...(m.titles || []).map(t => t.title), ...(m.title_synonyms || [])]),
    year: yearOf(m.published && m.published.from), type: malType(m.type),
    cover: m.images && m.images.jpg && (m.images.jpg.large_image_url || m.images.jpg.image_url)
  };
}
const myanimelist = {
  id: 'myanimelist', name: 'MyAnimeList', homepage: 'https://myanimelist.net', types: ['manga', 'manhwa', 'manhua', 'novel'],
  async search(q) {
    const r = await request('myanimelist', `${JIKAN}/manga?q=${encodeURIComponent(q)}&limit=8`, { gap: 1100 });
    return ((r && r.data) || []).map(malBasics);
  },
  async fetch(id) {
    const r = await request('myanimelist', `${JIKAN}/manga/${encodeURIComponent(id)}/full`, { gap: 1100 });
    const m = r && r.data;
    if (!m) return null;
    const type = malType(m.type);
    return Object.assign(malBasics(m), {
      summary: cleanText((m.synopsis || '').replace(/\[Written by MAL Rewrite\]/g, '')),
      status: { Publishing: 'ongoing', Finished: 'ended', 'On Hiatus': 'hiatus', Discontinued: 'abandoned' }[m.status],
      publisher: ((m.serializations || [])[0] || {}).name,
      authors: (m.authors || []).length ? m.authors.map(a => ({ name: flipName(a.name), role: 'writer' })) : undefined,
      genres: uniq((m.genres || []).map(g => g.name)),
      tags: uniq([...(m.themes || []), ...(m.demographics || [])].map(g => g.name)),
      rating: m.score ? Math.round(m.score * 10) : undefined,
      readingDirection: type === 'manga' ? 'rtl' : undefined
    });
  }
};

/* ================= Open Library (books, novels) ================= */
const OL = 'https://openlibrary.org';
// Many classic novels also list "comic books" (for adaptations), so fiction wins
const olType = subjects => {
  const s = (subjects || []).join(' ').toLowerCase();
  return /fiction|novel/.test(s) && !/^graphic novel/.test(s) ? 'novel' : /comic|graphic novel|manga/.test(s) ? 'comic' : 'book';
};
const openlibrary = {
  id: 'openlibrary', name: 'Open Library', homepage: 'https://openlibrary.org', types: ['book', 'novel', 'comic'],
  async search(q) {
    const r = await request('openlibrary', `${OL}/search.json?title=${encodeURIComponent(q)}&limit=8&fields=key,title,alternative_title,author_name,first_publish_year,subject,cover_i`, { gap: 400 });
    return ((r && r.docs) || []).map(d => ({
      id: d.key.replace('/works/', ''), url: `${OL}${d.key}`, title: d.title, altTitles: uniq(d.alternative_title || []),
      year: d.first_publish_year, type: olType(d.subject), cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined
    }));
  },
  async fetch(id) {
    const w = await request('openlibrary', `${OL}/works/${encodeURIComponent(id)}.json`, { gap: 400 });
    if (!w) return null;
    const authors = [];
    for (const a of (w.authors || []).slice(0, 3)) {
      const key = a.author && a.author.key;
      if (!key) continue;
      const p = await request('openlibrary', `${OL}${key}.json`, { gap: 400 }).catch(() => null);
      if (p && p.name) authors.push({ name: p.name, role: 'writer' });
    }
    const subjects = w.subjects || [];
    return {
      id, url: `${OL}/works/${id}`, title: w.title, altTitles: [],
      summary: cleanText(typeof w.description === 'string' ? w.description : w.description && w.description.value),
      year: yearOf(w.first_publish_date), type: olType(subjects),
      authors: authors.length ? authors : undefined,
      // Subjects are free-form: drop bookkeeping entries ("nyt:…=2009-03-15", "Accessible book") and long ones
      tags: uniq(subjects.filter(x => !/[:=]|accessible book|protected daisy|in library|large type|^fiction$/i.test(x) && x.length <= 40)
        .map(x => x.replace(/,\s*(fiction|juvenile fiction)$/i, '')).slice(0, 8)),
      cover: (w.covers || []).find(c => c > 0) ? `https://covers.openlibrary.org/b/id/${w.covers.find(c => c > 0)}-L.jpg` : undefined
    };
  }
};

/* ================= Google Books (books, novels, comics) ================= */
const GB = 'https://www.googleapis.com/books/v1';
const gbType = cats => { const s = (cats || []).join(' ').toLowerCase(); return /comics|graphic novel/.test(s) ? 'comic' : /fiction/.test(s) ? 'novel' : 'book'; };
const gbCover = links => { const u = links && (links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail); return u ? u.replace(/^http:/, 'https:') : undefined; };
function gbBasics(v) {
  const i = v.volumeInfo || {};
  return { id: v.id, url: i.infoLink || `https://books.google.com/books?id=${v.id}`, title: i.title, altTitles: i.subtitle ? [`${i.title}: ${i.subtitle}`] : [],
    year: yearOf(i.publishedDate), type: gbType(i.categories), cover: gbCover(i.imageLinks) };
}
const googlebooks = {
  // Works without a key, but keyless requests are often refused (429): off by default unless a key is set
  id: 'googlebooks', name: 'Google Books', homepage: 'https://books.google.com', types: ['book', 'novel', 'comic'], optionalKey: 'googleBooksApiKey', defaultOff: true,
  async search(q, keys) {
    const key = keys && keys.googleBooksApiKey ? `&key=${encodeURIComponent(keys.googleBooksApiKey)}` : '';
    const r = await request('googlebooks', `${GB}/volumes?q=${encodeURIComponent(`intitle:"${q}"`)}&maxResults=8&printType=books${key}`, { gap: 400 });
    return ((r && r.items) || []).map(gbBasics);
  },
  async fetch(id, keys) {
    const key = keys && keys.googleBooksApiKey ? `?key=${encodeURIComponent(keys.googleBooksApiKey)}` : '';
    const v = await request('googlebooks', `${GB}/volumes/${encodeURIComponent(id)}${key}`, { gap: 400 });
    if (!v) return null;
    const i = v.volumeInfo || {};
    return Object.assign(gbBasics(v), {
      summary: cleanText(i.description), publisher: i.publisher,
      authors: (i.authors || []).length ? i.authors.map(n => ({ name: n, role: 'writer' })) : undefined,
      genres: uniq((i.categories || []).flatMap(c => c.split(/\s*\/\s*/))),
      rating: i.averageRating ? Math.round(i.averageRating * 20) : undefined,
      ageRating: i.maturityRating === 'MATURE' ? 'Mature 17+' : undefined
    });
  }
};

/* ================= Comic Vine (western comics; needs a free API key) ================= */
const CV = 'https://comicvine.gamespot.com/api';
function cvBasics(v) {
  return { id: String(v.id), url: v.site_detail_url, title: v.name, altTitles: [], year: yearOf(v.start_year), type: 'comic',
    cover: v.image && (v.image.original_url || v.image.medium_url), publisher: v.publisher && v.publisher.name };
}
const comicvine = {
  id: 'comicvine', name: 'Comic Vine', homepage: 'https://comicvine.gamespot.com', types: ['comic'], needsKey: 'comicVineApiKey', defaultOff: true,
  async search(q, keys) {
    if (!keys || !keys.comicVineApiKey) throw providerError('comicvine', 'needs an API key (Server settings)');
    const r = await request('comicvine', `${CV}/search/?api_key=${encodeURIComponent(keys.comicVineApiKey)}&format=json&resources=volume&limit=8&query=${encodeURIComponent(q)}&field_list=id,name,start_year,publisher,image,site_detail_url`, { gap: 1100 });
    if (r && r.status_code === 100) throw providerError('comicvine', 'the API key was refused');
    return ((r && r.results) || []).map(cvBasics);
  },
  async fetch(id, keys) {
    if (!keys || !keys.comicVineApiKey) throw providerError('comicvine', 'needs an API key (Server settings)');
    const r = await request('comicvine', `${CV}/volume/4050-${encodeURIComponent(id)}/?api_key=${encodeURIComponent(keys.comicVineApiKey)}&format=json&field_list=id,name,deck,description,start_year,publisher,image,site_detail_url,people`, { gap: 1100 });
    const v = r && r.results;
    if (!v || Array.isArray(v)) return null;
    return Object.assign(cvBasics(v), {
      summary: cleanText(v.deck) || cleanText(v.description),
      authors: (v.people || []).length ? v.people.slice(0, 10).map(p => ({ name: p.name, role: 'creator' })) : undefined
    });
  }
};

const PROVIDERS = [anilist, mangadex, mangaupdates, kitsu, myanimelist, openlibrary, googlebooks, comicvine];
const BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

/* ---------------- matching a search result to a library title ---------------- */
function normTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(the|a|an) /, '').replace(/\s+/g, ' ').trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
// 0–1: best similarity of the query to the result's title or any alternative title; a far-off year lowers it
function matchScore(query, result, yearHint) {
  const q = normTitle(query);
  let best = 0;
  for (const t of [result.title, ...(result.altTitles || [])]) best = Math.max(best, similarity(q, normTitle(t)));
  if (yearHint && result.year && Math.abs(result.year - yearHint) > 1) best -= 0.1;
  return Math.max(0, Math.round(best * 1000) / 1000);
}

module.exports = { PROVIDERS, BY_ID, matchScore, normTitle, cleanText, request };
