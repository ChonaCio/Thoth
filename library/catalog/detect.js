// Working out a source's settings from its address: robots.txt (rules and the sitemaps it names), the sitemaps
// (the address patterns of works and chapters), the home page (name, icon, the WordPress theme it runs) and one
// work page (title, chapters). Nothing is saved; the result fills the source form.
const { createFetcher, sitemapsIn, robotsAllows, parseRobots } = require('./fetcher');
const { parse } = require('./html');
const sm = require('./sitemap');

const THEMES = [
  { type: 'madara', test: html => /wp-manga|manga-chapters-holder|summary_image|madara/i.test(html) },
  { type: 'mangareader', test: html => /listupd|chapterlist|eplister|bixbox|ts_reader|themesia/i.test(html) }
];
const errText = e => (e && e.code ? `${e.code}: ` : '') + (e && e.message || String(e));

async function detect(msg) {
  const fetcher = createFetcher({ gapMs: 400, allowLocal: msg.allowLocal });
  const get = fetcher.get;
  let origin;
  try { origin = new URL(String(msg.url || '').trim()).origin; } catch { throw Object.assign(new Error('Not a web address'), { code: 'invalidUrl' }); }
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const notes = [];
  const out = { settings: null, found: { origin, robots: null, sitemaps: [], patterns: [], works: 0, sampleWork: null, theme: null, icon: null }, notes, blocked: false };
  // Sites with their own reader
  if (/(^|\.)mangadex\.org$/.test(host)) {
    out.settings = { type: 'mangadex', name: 'MangaDex', baseUrl: 'https://api.mangadex.org', languages: 'en', includeChapters: true, iconUrl: 'https://mangadex.org/favicon.ico' };
    notes.push('mangadex'); out.found.icon = out.settings.iconUrl;
    return out;
  }
  if (/(^|\.)webtoons\.com$/.test(host)) {
    out.settings = { type: 'webtoons', name: 'WEBTOON', baseUrl: 'https://www.webtoons.com', languages: 'en', includeChapters: true }; // (its icon is found from its pages)
    notes.push('webtoons'); out.found.icon = out.settings.iconUrl;
    return out;
  }
  try {
    // 1. robots.txt: its rules and the sitemaps it names
    const robots = await fetcher.robotsFile(origin);
    const rules = parseRobots(robots || '');
    out.found.robots = robots == null ? 'none' : 'found';
    let roots = sitemapsIn(robots || '');
    if (!roots.length) {
      for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml']) {
        try { const x = await sm.readSitemap(get, origin + p); if (x.sitemaps.length || x.urls.length) { roots = [origin + p]; break; } } catch (e) { if (e.code === 'blocked') throw e; }
      }
      if (roots.length) notes.push('sitemapGuessed');
    }
    out.found.sitemaps = roots;
    // 2. The home page: the site's name, its icon, its theme
    let home = null;
    try { home = await get(origin + '/'); } catch (e) { if (e.code === 'blocked') throw e; notes.push('noHome'); }
    const doc = home ? parse(home.text) : null;
    const meta = p => doc && (doc.first(`meta[property="${p}"]`) || doc.first(`meta[name="${p}"]`) || { attr: () => null }).attr('content');
    const name = (meta('og:site_name') || (doc && (doc.first('title') || { text: () => '' }).text().split(/\s[|\-–—]\s/)[0]) || host).trim().slice(0, 80);
    const iconEl = doc && (doc.first('link[rel~="icon"]') || doc.first('link[rel="shortcut icon"]') || doc.first('link[rel="apple-touch-icon"]'));
    const icon = iconEl && iconEl.attr('href') ? new URL(iconEl.attr('href'), origin).href : origin + '/favicon.ico';
    out.found.icon = icon;
    // 3. The sitemaps: a sample of what they list, and the patterns of work and chapter pages
    const urls = [], hints = new Map();
    let files = 0;
    if (roots.length) {
      for await (const { file, urls: list } of sm.walk(get, roots, { maxFiles: 12 })) {
        files++;
        for (const u of list.slice(0, 3000)) { urls.push(u.loc); hints.set(u.loc, file); }
        if (urls.length > 20000) break;
      }
    }
    const pat = sm.inferPatterns(urls.filter(u => { try { return new URL(u).origin === origin; } catch { return false; } }), hints);
    out.found.patterns = pat.patterns;
    out.found.works = pat.works;
    out.found.sitemapFiles = files;
    if (!roots.length) notes.push('noSitemap');
    else if (!pat.workPattern) notes.push('noWorkPattern');
    // 4. One work page: the theme it uses, its title, its chapters
    const workUrl = pat.workPattern ? urls.find(u => sm.patternRegex(pat.workPattern).test(sm.pathOf(u))) : null;
    let theme = home && THEMES.find(t => t.test(home.text));
    let sample = null;
    if (workUrl) {
      if (!robotsAllows(rules, workUrl)) notes.push('robotsWorks');
      else {
        try {
          const page = await get(workUrl);
          const wd = parse(page.text);
          theme = theme || THEMES.find(t => t.test(page.text));
          const reCh = pat.chapterPattern ? sm.patternRegex(pat.chapterPattern) : null;
          const chapterLinks = reCh ? [...new Set(wd.select('a[href]').map(a => { try { return new URL(a.attr('href'), page.url).href; } catch { return null; } }).filter(u => u && reCh.test(sm.pathOf(u))))] : [];
          sample = { url: workUrl, title: ((wd.first('meta[property="og:title"]') || { attr: () => null }).attr('content') || (wd.first('h1') || { text: () => '' }).text() || '').trim(), chapterLinks: chapterLinks.length };
        } catch (e) { if (e.code === 'blocked') throw e; notes.push('workUnreadable'); }
      }
    }
    out.found.sampleWork = sample;
    out.found.theme = theme ? theme.type : null;
    // 5. The settings: a theme reader when the site runs one, else the generic reader (sitemaps + patterns)
    const listPath = pat.workPattern ? pat.workPattern.split('/').filter(Boolean)[0] : null;
    const type = theme ? theme.type : 'custom';
    out.settings = {
      type, name, baseUrl: origin, iconUrl: icon, includeChapters: true, languages: '',
      listing: pat.workPattern ? 'sitemap' : 'pages', sitemaps: roots, workPattern: pat.workPattern || '', chapterPattern: pat.chapterPattern || '',
      listPath: listPath && listPath !== '*' ? listPath : 'manga'
    };
    if (type === 'custom') {
      out.settings.selectors = {};
      if (!pat.workPattern) notes.push('needsSelectors');
    }
  } catch (e) {
    if (e.code === 'blocked') { out.blocked = true; notes.push('blocked'); out.error = errText(e); return out; }
    throw e;
  }
  return out;
}

module.exports = { detect };
