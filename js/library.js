/*
 * Library pages: home, library browsing, series, book, search, collections, read lists,
 * and library management (admins). Each page has:
 *   render(route) → HTML from what's loaded so far (shows a spinner until data arrives)
 *   enter(route)  → loads data, then re-renders if the user is still on that page
 *   mount(el)     → optional, wires up things after the HTML is in place
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.from((r || document).querySelectorAll(s)); };
  var A = function () { return window.App; };
  var t = function (k, v) { return A().t(k, v); };
  var esc = function (s) { return A().esc(s); };
  var api = function (m, u, b) { return Store.request(m, u, b); };
  var isAdmin = function () { return A().isAdmin(); };
  var PAGE_SIZE = 60;

  var cache = {};
  function reset() { cache = { home: null, libs: {}, facets: {}, series: {}, book: {}, search: {}, collections: null, collection: {}, readlists: null, readlist: {}, manage: null }; }
  reset();

  /* ---------------- page cache ----------------
   * Every page keeps its data in `cache`, stamped with when it was fetched (_at). Coming back to a page:
   *   fresh (fetched less than FRESH_MS ago, nothing changed since) → shown as is, no request at all;
   *   older, or marked stale by a change (markStale) → shown at once, refreshed in the background.
   * So switching between pages never waits for the server unless the page was never opened. */
  var FRESH_MS = 60 * 1000;
  function stamp(x) { if (x && typeof x === 'object' && !x.error) { x._at = Date.now(); delete x.stale; } return x; }
  function isFresh(x) { return Boolean(x && !x.error && !x.stale && x._at && Date.now() - x._at < FRESH_MS); }
  // Mark one cached page, or every entry of a map of pages (cache.series, cache.book, …), as out of date
  function markStale(x) {
    if (!x || typeof x !== 'object') return;
    if ('_at' in x || 'error' in x) { x.stale = true; return; }
    Object.keys(x).forEach(function (k) { if (x[k] && typeof x[k] === 'object') x[k].stale = true; });
  }
  // get(): the cached entry this page shows (skips the request while it's fresh; stamped after loading)
  function load(hash, fn, get) {
    if (get && isFresh(get())) return Promise.resolve();
    return fn().then(function () { if (get) stamp(get()); A().rerenderIf(hash); }, function (err) {
      if (err && err.status === 401) return; // signed out; the app handles it
      A().rerenderIf(hash);
    });
  }

  /* ---------------- small building blocks ---------------- */
  var spinner = '<div class="loading" role="status"><span class="spinner"></span></div>';
  function errorBanner(err) { return '<div class="banner banner--error">' + esc(A().errMsg(err)) + '</div>'; }
  function icon(name) { return '<span data-icon="' + name + '"></span>'; }
  function count(n, one, many) { return n === 1 ? t(one) : t(many, { count: n }); }
  function fmtSize(bytes) {
    if (!bytes) return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function emptyState(iconName, title, text, action) {
    return '<div class="empty-state">' + icon(iconName) +
      (title ? '<h2 class="empty-state__title">' + esc(title) + '</h2>' : '') +
      (text ? '<p>' + esc(text) + '</p>' : '') + (action || '') + '</div>';
  }

  // Covers: CBZ books use their first page; PDFs and broken files get a placeholder
  function placeholder(format) {
    return '<div class="cover__placeholder">' + icon(format === 'pdf' ? 'pdf' : 'book') + '<span>' + esc((format || '').toUpperCase()) + '</span></div>';
  }
  function bookCoverHtml(b) {
    if (b.format === 'cbz' && b.pageCount && !b.error) {
      return '<img class="cover__img" loading="lazy" decoding="async" alt="" src="/api/books/' + b.id + '/thumbnail?v=' + b.v + '" />' + placeholder(b.format);
    }
    return placeholder(b.format);
  }
  function seriesCoverHtml(s) {
    // coverSource: 'metadata' (downloaded cover) or 'file' (first page); older servers only send coverFormat
    if (s.coverSource || (s.coverSource === undefined && s.coverFormat === 'cbz')) {
      return '<img class="cover__img" loading="lazy" decoding="async" alt="" src="/api/series/' + s.id + '/thumbnail?v=' + s.coverV + '" />' + placeholder('cbz');
    }
    return placeholder(s.coverFormat || 'cbz');
  }
  function progressPct(p, pageCount) {
    if (!p) return 0;
    if (p.completed) return 100;
    return pageCount ? Math.max(2, Math.round(p.page / pageCount * 100)) : 0;
  }

  // "3 books · 2 versions", "One-shot", or "3 books · Colored" for a single non-base version
  function editionLabel(e) { return t('edition.' + (e || 'base')); }
  // A version's name as a colored tag (Regular plain); plain for inside a tab
  function editionTag(e, inTab) {
    e = e || 'base';
    return e === 'base' ? esc(editionLabel(e)) : '<span class="edition-tag edition-tag--' + esc(e) + (inTab ? ' edition-tag--tab' : '') + '">' + esc(editionLabel(e)) + '</span>';
  }
  // Kinds of works the metadata providers recognize
  var WORK_TYPES = ['manga', 'manhwa', 'manhua', 'webcomic', 'comic', 'novel', 'book', 'other'];
  function cardSubtitle(s) {
    var main = s.oneshot ? t('lib.oneshot') : count(s.booksCount, 'lib.bookCount1', 'lib.booksCount');
    if (s.editions && s.editions.length > 1) return main + ' · ' + t('lib.versions', { count: s.editions.length });
    if (s.edition && s.edition !== 'base') return main + ' · ' + editionLabel(s.edition);
    return main;
  }

  function seriesCard(s, opts) {
    opts = opts || {};
    var unread = s.booksCount - s.booksRead;
    var badge = s.booksCount && s.booksRead === s.booksCount
      ? '<span class="cover__badge cover__badge--done">' + icon('check') + '</span>'
      : (unread > 0 && s.booksRead + s.booksInProgress > 0 ? '<span class="cover__badge">' + unread + '</span>' : '');
    // One-shots open their work page too, like any other work
    var href = '#series/' + s.id;
    if (s.oneshot) badge = s.booksRead ? '<span class="cover__badge cover__badge--done">' + icon('check') + '</span>' : '';
    return '<div class="media-card">' +
      '<a class="media-card__link" href="' + href + '">' +
        '<div class="cover">' + seriesCoverHtml(s) + badge + '</div>' +
        '<div class="media-card__title" title="' + esc(s.workTitle || s.title) + '">' + esc(s.workTitle || s.title) + '</div>' +
        '<div class="media-card__sub">' + esc(cardSubtitle(s)) + '</div>' +
      '</a>' +
      (opts.remove ? '<button class="media-card__remove icon-btn icon-btn--sm" data-lib="' + opts.remove + '" data-id="' + s.id + '" data-icon="close" title="' + esc(t('coll.remove')) + '" aria-label="' + esc(t('coll.remove')) + '"></button>' : '') +
    '</div>';
  }

  function bookCard(b, opts) {
    opts = opts || {};
    var pct = progressPct(b.progress, b.pageCount);
    var href = opts.read ? '#read/' + b.id + (opts.readlist ? '?readlist=' + opts.readlist : '') : '#book/' + b.id;
    var sub = opts.showSeries ? (b.oneshot ? t('lib.oneshot') : b.seriesTitle) : (b.pageCount ? t('book.pages', { count: b.pageCount }) : b.format.toUpperCase());
    return '<div class="media-card">' +
      '<a class="media-card__link" href="' + href + '">' +
        '<div class="cover">' + bookCoverHtml(b) +
          (b.progress && b.progress.completed ? '<span class="cover__badge cover__badge--done">' + icon('check') + '</span>' : '') +
          (opts.index ? '<span class="cover__index">' + opts.index + '</span>' : '') +
          (pct && pct < 100 ? '<div class="cover__progress"><span style="width:' + pct + '%"></span></div>' : '') +
          (b.error ? '<span class="cover__error" title="' + esc(b.error) + '">!</span>' : '') +
        '</div>' +
        '<div class="media-card__title" title="' + esc(b.title) + '">' +
          (opts.showSeries ? '' : '<span class="media-card__num">' + esc(b.number) + '</span> ') + esc(b.title) + '</div>' +
        '<div class="media-card__sub">' + esc(sub) + '</div>' +
      '</a>' +
      (opts.controls || '') +
    '</div>';
  }

  function shelf(titleKey, cards, moreHref) {
    if (!cards.length) return '';
    return '<section class="shelf"><div class="shelf__head"><h2 class="shelf__title">' + esc(t(titleKey)) + '</h2>' +
      (moreHref ? '<a class="btn btn--text" href="' + moreHref + '">' + esc(t('home.seeAll')) + '</a>' : '') + '</div>' +
      '<div class="shelf__row">' + cards.join('') + '</div></section>';
  }
  function grid(cards) { return '<div class="media-grid">' + cards.join('') + '</div>'; }

  // Chapters/books as a list: number, title, pages, progress, release date, and a Read button
  function bookList(books) {
    return '<ol class="book-list">' + books.map(function (b) {
      var p = b.progress, pct = progressPct(p, b.pageCount);
      var state = p ? (p.completed ? t('book.progressRead') : t('book.progressAt', { page: p.page, total: b.pageCount || '?' })) : t('book.unread');
      var readHref = '#read/' + b.id + (p && p.completed ? '?page=1' : '');
      return '<li class="book-row' + (p && p.completed ? ' is-read' : '') + '">' +
        '<a class="book-row__main" href="#book/' + b.id + '">' +
          '<span class="book-row__num">' + esc(b.number) + '</span>' +
          '<span class="book-row__text"><span class="book-row__title">' + esc(b.title) + '</span>' +
            '<span class="book-row__sub">' + esc([b.pageCount ? t('book.pages', { count: b.pageCount }) : b.format.toUpperCase(), b.releaseDate].filter(Boolean).join(' · ')) + '</span></span>' +
          '<span class="book-row__state">' + (p && p.completed ? icon('check') : '') + '<span>' + esc(state) + '</span>' +
            (pct && pct < 100 ? '<span class="book-row__bar"><span style="width:' + pct + '%"></span></span>' : '') + '</span>' +
          (b.error ? '<span class="cover__error" title="' + esc(b.error) + '">!</span>' : '') +
        '</a>' +
        (!b.error ? '<a class="icon-btn book-row__read" href="' + readHref + '" title="' + esc(t('book.read')) + '" aria-label="' + esc(t('book.read')) + ' ' + esc(b.title) + '" data-icon="play"></a>' : '') +
      '</li>';
    }).join('') + '</ol>';
  }

  // A one-shot's pages as tiles: each opens the reader at that page
  function pageGrid(b) {
    var p = b.progress;
    var tiles = [];
    for (var n = 1; n <= b.pageCount; n++) {
      var cur = p && !p.completed && p.page === n;
      tiles.push('<a class="page-tile' + (cur ? ' is-current' : '') + '" href="#read/' + b.id + '?page=' + n + '" title="' + esc(t('book.progressAt', { page: n, total: b.pageCount })) + '">' +
        '<img loading="lazy" decoding="async" alt="" src="/api/books/' + b.id + '/pages/' + n + '?v=' + b.v + '" />' +
        '<span class="page-tile__num">' + n + '</span></a>');
    }
    return '<div class="page-grid">' + tiles.join('') + '</div>';
  }
  function backLink(href, label) {
    return '<a class="back-link" href="' + href + '">' + icon('arrow_back') + '<span>' + esc(label) + '</span></a>';
  }

  /* ================= HOME ================= */
  var home = {
    title: function () { return t('nav.home'); },
    render: function () {
      var h = cache.home;
      var html = '<h1 class="page-title">' + esc(t('nav.home')) + '</h1>';
      if (h && h.error) return html + errorBanner(h.error);
      if (!h) return html + spinner;
      if (!h.libraries) {
        return html + (isAdmin()
          ? emptyState('library', t('home.emptyAdminTitle'), t('home.emptyAdmin'), '<a class="btn btn--primary" href="#manage-libraries">' + icon('add') + esc(t('home.addLibrary')) + '</a>')
          : emptyState('library', t('home.emptyUserTitle'), t('home.emptyUser')));
      }
      if (!h.recentSeries.length) return html + emptyState('library', t('lib.noSeriesTitle'), t('lib.noSeries'));
      return html +
        shelf('home.keepReading', h.keepReading.map(function (b) { return bookCard(b, { showSeries: true, read: true }); })) +
        shelf('home.onDeck', h.onDeck.map(function (b) { return bookCard(b, { showSeries: true, read: true }); })) +
        shelf('home.recentSeries', h.recentSeries.map(function (s) { return seriesCard(s); }), '#library/all?sort=added') +
        shelf('home.recentBooks', h.recentBooks.map(function (b) { return bookCard(b, { showSeries: true }); }));
    },
    enter: function (route) {
      load(route.hash, function () {
        return api('GET', '/api/home').then(function (r) { cache.home = r; }, function (e) { cache.home = { error: e }; throw e; });
      }, function () { return cache.home; });
    }
  };

  /* ================= LIBRARY (series grid) ================= */
  // The library (or 'all'); with ?deleted=1 an administrator sees the hidden works instead (own state)
  function libId(route) { return route.param || 'all'; }
  function libDeleted(route) { return isAdmin() && route.query.get('deleted') === '1'; }
  function libKey(route) { return libId(route) + (libDeleted(route) ? ':deleted' : ''); }

  /* Advanced search: every facet value can be included or excluded.
   *   genre/tag/person (lists; person = a writer, artist, … in any role): the work needs ALL included values and NONE of the excluded ones
   *   type/status/metadata (one value per work): ANY of the included values, none of the excluded
   * plus a year range and an author. In the address: genre=…&genre=…&xgenre=…&yearFrom=…&author=… */
  var MULTI = ['type', 'status', 'genre', 'tag', 'person', 'metadata'];
  function resetCriteria(st) {
    st.inc = {}; st.exc = {};
    MULTI.forEach(function (f) { st.inc[f] = []; st.exc[f] = []; });
    st.yearFrom = ''; st.yearTo = ''; st.author = '';
  }
  function libState(route) {
    var key = libKey(route);
    if (!cache.libs[key]) {
      // Order: from the address (e.g. "See all" on Home), else the library's default order
      var libDef = (A().state.libraries || []).filter(function (x) { return x.id === libId(route); })[0];
      cache.libs[key] = { items: null, total: 0, q: '', sort: route.query.get('sort') || (libDef && libDef.defaultSort) || 'title', read: route.query.get('read') || '', error: null, loading: false, panel: false };
      resetCriteria(cache.libs[key]);
    }
    return cache.libs[key];
  }
  var CRITERIA_KEYS = MULTI.concat(MULTI.map(function (f) { return 'x' + f; }), ['yearFrom', 'yearTo', 'author']);
  // Arriving at a library URL with criteria in it (a genre/tag chip, a bookmark): use them
  function applyRouteFilters(route) {
    var st = libState(route);
    if (st.lastHash === route.hash) return;
    st.lastHash = route.hash;
    if (CRITERIA_KEYS.some(function (k) { return route.query.has(k); })) {
      resetCriteria(st);
      MULTI.forEach(function (f) { st.inc[f] = route.query.getAll(f).filter(Boolean); st.exc[f] = route.query.getAll('x' + f).filter(Boolean); });
      st.yearFrom = route.query.get('yearFrom') || ''; st.yearTo = route.query.get('yearTo') || ''; st.author = route.query.get('author') || '';
      st.q = '';
      // The works on screen were for other criteria: load again (the page cache would show them as they are)
      st.stale = true;
      st.reset = true;
    }
  }
  // { genre: [...], xgenre: [...], yearFrom, … } for the API and the address
  function criteriaParams(st) {
    var p = {};
    MULTI.forEach(function (f) { if (st.inc[f].length) p[f] = st.inc[f]; if (st.exc[f].length) p['x' + f] = st.exc[f]; });
    if (st.yearFrom) p.yearFrom = st.yearFrom;
    if (st.yearTo) p.yearTo = st.yearTo;
    if (st.author) p.author = st.author;
    return p;
  }
  // Query string with repeated keys for lists (genre=a&genre=b)
  function qsMulti(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      [].concat(params[k]).forEach(function (v) { if (v !== '' && v != null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); });
    });
    return parts.join('&');
  }
  // Keep the address in step with the criteria (shareable, survives reload) without re-entering the page
  function syncFilterUrl(route) {
    var st = libState(route);
    var p = criteriaParams(st);
    if (libDeleted(route)) p.deleted = '1';
    var qs = qsMulti(p);
    var hash = route.hash.split('?')[0] + (qs ? '?' + qs : '');
    st.lastHash = hash;
    history.replaceState(history.state, '', hash); // keep the entry's key (scroll position)
  }
  function activeFilters(st) {
    var n = 0;
    MULTI.forEach(function (f) { n += st.inc[f].length + st.exc[f].length; });
    return n + (st.yearFrom ? 1 : 0) + (st.yearTo ? 1 : 0) + (st.author ? 1 : 0);
  }
  function libraryName(id) {
    if (id === 'all') return t('nav.allLibraries');
    var l = A().state.libraries.filter(function (x) { return x.id === id; })[0];
    return l ? l.name : '';
  }
  // append: the next page ("Load more"). keep: reload as many works as were loaded before (coming back to
  // the page), in pages of up to 200, while the old list stays on screen.
  function fetchSeries(route, append, keep) {
    var st = libState(route);
    var id = libId(route);
    st.loading = true;
    // Only the latest request counts (a slower earlier one must not overwrite it)
    var seq = st.seq = (st.seq || 0) + 1;
    if (!append) showGridLoading(route);
    var params = Object.assign({ library: id === 'all' ? '' : id, q: st.q, sort: st.sort, read: st.read, deleted: libDeleted(route) ? '1' : '' }, criteriaParams(st));
    var page = function (offset, limit) { return api('GET', '/api/series?' + qsMulti(Object.assign({ offset: offset, limit: limit }, params))); };
    var want = append ? PAGE_SIZE : Math.max(PAGE_SIZE, keep || 0);
    var start = append ? st.items.length : 0;
    var got = [];
    var total = 0;
    function more() {
      return page(start + got.length, Math.min(200, want - got.length)).then(function (r) {
        got = got.concat(r.items);
        total = r.total;
        if (got.length < want && got.length + start < total && r.items.length) return more();
      });
    }
    return more().then(function () {
      if (seq !== st.seq) return;
      st.items = append ? st.items.concat(got) : got;
      st.total = total;
      st.error = null;
      st.stale = false;
      st._at = Date.now();
    }, function (e) { if (seq === st.seq) st.error = e; }).then(function () {
      if (seq !== st.seq) return;
      st.loading = false;
      renderLibGrid(route);
    });
  }
  // While works are loading for new criteria/order: a bar over the grid and the old works dimmed
  function showGridLoading(route) {
    var el = $('#lib-grid');
    if (!el || location.hash.split('?')[0] !== route.hash.split('?')[0]) return;
    el.classList.add('is-loading');
    el.setAttribute('aria-busy', 'true');
    if (!$('.grid-loading', el)) el.insertAdjacentHTML('afterbegin', '<div class="grid-loading" role="status"><span class="spinner spinner--sm"></span>' + esc(t('lib.updating')) + '</div>');
  }
  function renderLibGrid(route) {
    var el = $('#lib-grid');
    if (!el || location.hash.split('?')[0] !== route.hash.split('?')[0]) return;
    var st = libState(route);
    var html;
    if (st.error) html = errorBanner(st.error);
    else if (!st.items) html = spinner;
    else if (!st.items.length) html = emptyState('library', '', st.q || st.read || activeFilters(st) ? t('lib.noMatch') : t('lib.noSeries'));
    else {
      html = '<p class="muted small grid-count">' + esc(count(st.total, 'lib.seriesCount1', 'lib.seriesCount')) + '</p>' +
        grid(st.items.map(function (s) { return seriesCard(s); })) +
        (st.items.length < st.total ? '<div class="load-more"><button class="btn btn--outline btn--pill" data-lib="more-series"' + (st.loading ? ' disabled' : '') + '>' + esc(t('lib.loadMore')) + '</button></div>' : '');
    }
    el.innerHTML = html;
    el.classList.toggle('is-loading', Boolean(st.loading && st.items));
    if (st.loading && st.items) el.insertAdjacentHTML('afterbegin', '<div class="grid-loading" role="status"><span class="spinner spinner--sm"></span>' + esc(t('lib.updating')) + '</div>');
    el.setAttribute('aria-busy', st.loading ? 'true' : 'false');
    renderIcons(el);
    A().restoreScroll(); // coming back: scroll to where the user was once the works are on screen
  }
  var filterTimer;
  var library = {
    title: function (route) { return (libDeleted(route) ? t('del.hiddenTitle') + ' · ' : '') + libraryName(libId(route)); },
    render: function (route) {
      var key = libId(route);
      applyRouteFilters(route);
      var st = libState(route);
      var lib = A().state.libraries.filter(function (x) { return x.id === key; })[0];
      if (key !== 'all' && !lib && A().state.libraries.length) return emptyState('library', t('lib.notFound'), '');
      var opt = function (v, k, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(t(k)) + '</option>'; };
      var deleted = libDeleted(route);
      var hiddenCount = lib && lib.hiddenCount;
      return (deleted ? backLink('#library/' + key, libraryName(key)) : '') +
        '<div class="page-head"><h1 class="page-title">' + esc(deleted ? t('del.hiddenTitle') : libraryName(key)) + '</h1>' +
          (isAdmin() && lib && !deleted ? '<button class="btn btn--outline btn--pill" data-lib="scan-library" data-id="' + key + '"' + (lib.scanning ? ' disabled' : '') + '>' + icon('sync') + esc(t(lib.scanning ? 'lib.scanning' : 'lib.scan')) + '</button>' : '') +
          (isAdmin() && hiddenCount && !deleted ? '<a class="btn btn--text" href="#library/' + key + '?deleted=1">' + icon('delete') + esc(t('del.hiddenLink', { count: hiddenCount })) + '</a>' : '') +
        '</div>' +
        (deleted ? '<p class="page-lead">' + esc(t('del.hiddenIntro')) + '</p>' : '') +
        '<div class="toolbar">' +
          '<label class="search-field">' + icon('search') +
            '<input type="search" id="lib-filter" placeholder="' + esc(t('lib.filterPlaceholder')) + '" value="' + esc(st.q) + '" /></label>' +
          '<div class="toolbar__group">' +
            '<select class="select select--compact" id="lib-sort" aria-label="' + esc(t('lib.sort')) + '">' +
              opt('title', 'lib.sortTitle', st.sort) + opt('added', 'lib.sortAdded', st.sort) + opt('updated', 'lib.sortUpdated', st.sort) + opt('rating', 'lib.sortRating', st.sort) + '</select>' +
            '<select class="select select--compact" id="lib-read" aria-label="' + esc(t('lib.read')) + '">' +
              opt('', 'lib.readAll', st.read) + opt('unread', 'lib.readUnread', st.read) + opt('inProgress', 'lib.readInProgress', st.read) + opt('read', 'lib.readRead', st.read) + '</select>' +
          '</div>' +
        '</div>' +
        '<div id="lib-filters">' + filtersHtml(route) + '</div>' +
        '<div id="lib-grid"></div>';
    },
    mount: function (el, route) {
      renderLibGrid(route);
      var st = libState(route);
      $('#lib-filter', el).addEventListener('input', function (e) {
        st.q = e.target.value;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(function () { fetchSeries(route); }, 250);
      });
      $('#lib-sort', el).addEventListener('change', function (e) { st.sort = e.target.value; fetchSeries(route); });
      $('#lib-read', el).addEventListener('change', function (e) { st.read = e.target.value; fetchSeries(route); });
      var box = $('#lib-filters', el);
      var changed = function (refetchNow) {
        syncFilterUrl(route);
        refreshFilters(route);
        clearTimeout(filterTimer);
        if (refetchNow) fetchSeries(route); else filterTimer = setTimeout(function () { fetchSeries(route); }, 350);
      };
      box.addEventListener('click', function (e) {
        var b;
        if ((b = e.target.closest('[data-adv-toggle]'))) { st.panel = !st.panel; return refreshFilters(route); }
        if ((b = e.target.closest('[data-filter-clear]'))) { resetCriteria(st); return changed(true); }
        if ((b = e.target.closest('[data-adv]'))) {
          // Each click: neutral → include → exclude → neutral
          var f = b.dataset.adv, v = b.dataset.value;
          var inI = st.inc[f].indexOf(v), inX = st.exc[f].indexOf(v);
          if (inI !== -1) { st.inc[f].splice(inI, 1); st.exc[f].push(v); }
          else if (inX !== -1) st.exc[f].splice(inX, 1);
          else st.inc[f].push(v);
          return changed(true);
        }
        if ((b = e.target.closest('[data-crit-remove]'))) {
          var parts = b.dataset.critRemove.split('|'), which = parts[0], ff = parts[1], val = parts.slice(2).join('|');
          if (which === 'inc' || which === 'exc') st[which][ff] = st[which][ff].filter(function (x) { return x !== val; });
          else st[ff] = '';
          return changed(true);
        }
      });
      box.addEventListener('input', function (e) {
        var t2 = e.target;
        if (t2.dataset.advSearch) {
          // Find any genre, tag or person (not only the ones listed): asked to the Search cache; the chips shown
          // narrow at once while the answer comes
          var f = t2.dataset.advSearch, term = t2.value.trim(), lower = term.toLowerCase();
          $$('[data-adv="' + f + '"]', box).forEach(function (c) { c.hidden = lower && c.dataset.value.toLowerCase().indexOf(lower) === -1; });
          clearTimeout(advTermTimer);
          if (!term) return;
          advTermTimer = setTimeout(function () {
            var lib = libId(route);
            api('GET', '/api/search/terms?' + Store.qs({ field: f, q: term, library: lib === 'all' ? '' : lib, limit: 60 })).then(function (r) {
              var holder = $('[data-adv-chips="' + f + '"]', box);
              if (!holder || t2.value.trim() !== term) return;
              var chosen = st.inc[f].concat(st.exc[f]);
              var list = chosen.filter(function (v) { return !r.terms.some(function (x) { return x.name === v; }); }).map(function (v) { return { name: v, count: 0 }; }).concat(r.terms);
              holder.innerHTML = list.length ? list.map(function (x) { return advChip(st, f, x.name, x.name, x.count); }).join('') : '<span class="muted small">' + esc(t('lib.noMatch')) + '</span>';
            }, function () { /* the chips narrowed above stay */ });
          }, 200);
          return;
        }
        if (t2.dataset.advField) {
          st[t2.dataset.advField] = t2.value.trim();
          syncFilterUrl(route);
          clearTimeout(filterTimer);
          filterTimer = setTimeout(function () { refreshChips(route); fetchSeries(route); }, 400);
        }
      });
    },
    enter: function (route) {
      // Coming back: the works loaded before stay on screen and are reloaded (as many as were loaded)
      var st = libState(route);
      // Fresh from a moment ago and nothing changed: show it as is (page cache)
      if (st.items && !st.stale && !st.error && st._at && Date.now() - st._at < FRESH_MS) { renderLibGrid(route); }
      else {
        // New criteria from the address: start from the first page, not as many works as before
        var keep = st.reset ? 0 : st.items ? st.items.length : 0;
        st.reset = false;
        renderLibGrid(route);
        fetchSeries(route, false, keep);
      }
      // What the search can offer (genres, tags, … with counts) for this library
      var id = libId(route);
      if (isFresh(cache.facets[id])) return;
      api('GET', '/api/series/facets?' + Store.qs({ library: id === 'all' ? '' : id })).then(function (r) {
        cache.facets[id] = stamp(r);
        refreshFilters(route);
      }, function () { /* the search keeps its fixed options */ });
    }
  };
  function refreshFilters(route) {
    var el = $('#lib-filters');
    if (!el || location.hash.split('?')[0] !== route.hash.split('?')[0]) return;
    var focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset : null;
    el.innerHTML = filtersHtml(route);
    renderIcons(el);
    // Keep typing in a search/year/author box after the panel re-renders
    if (focus && (focus.advSearch || focus.advField)) {
      var again = el.querySelector(focus.advSearch ? '[data-adv-search="' + focus.advSearch + '"]' : '[data-adv-field="' + focus.advField + '"]');
      if (again) { again.focus(); var v = again.value; again.value = ''; again.value = v; }
    }
  }
  function refreshChips(route) {
    var el = $('#lib-active');
    if (el) { el.outerHTML = activeChipsHtml(route); renderIcons($('#lib-filters')); }
  }
  // The chosen criteria as removable chips ("+ Action", "− Gore", "1990–2000", "Author: Oda")
  function activeChipsHtml(route) {
    var st = libState(route);
    var label = function (f, v) {
      return f === 'type' ? t('type.' + v) : f === 'status' ? t('series.status.' + v) : f === 'metadata' ? t('filter.metadata.' + v) : v;
    };
    var chips = [];
    MULTI.forEach(function (f) {
      st.inc[f].forEach(function (v) { chips.push(['inc', f, v, '+ ' + t('filter.' + f) + ': ' + label(f, v)]); });
      st.exc[f].forEach(function (v) { chips.push(['exc', f, v, '− ' + t('filter.' + f) + ': ' + label(f, v)]); });
    });
    if (st.yearFrom || st.yearTo) {
      if (st.yearFrom) chips.push(['val', 'yearFrom', '', t('adv.yearFrom') + ' ' + st.yearFrom]);
      if (st.yearTo) chips.push(['val', 'yearTo', '', t('adv.yearTo') + ' ' + st.yearTo]);
    }
    if (st.author) chips.push(['val', 'author', '', t('adv.author') + ': ' + st.author]);
    return '<div class="adv-active" id="lib-active">' + (chips.length ? chips.map(function (c) {
      return '<button type="button" class="chip chip--crit chip--' + c[0] + '" data-crit-remove="' + esc(c[0] + '|' + c[1] + '|' + c[2]) + '" title="' + esc(t('adv.remove')) + '">' +
        esc(c[3]) + ' ' + icon('close') + '</button>';
    }).join('') + '<button type="button" class="btn btn--text btn--small" data-filter-clear>' + esc(t('filter.clear')) + '</button>' : '') + '</div>';
  }
  // One value in the search panel: click → include → exclude → neither
  var advTermTimer = null;
  function advChip(st, f, v, label, count) {
    var s = st.inc[f].indexOf(v) !== -1 ? 'inc' : st.exc[f].indexOf(v) !== -1 ? 'exc' : '';
    return '<button type="button" class="chip chip--adv' + (s ? ' is-' + s : '') + '" data-adv="' + f + '" data-value="' + esc(v) + '" aria-pressed="' + (s ? 'true' : 'false') + '"' +
      ' title="' + esc(t(s === 'inc' ? 'adv.stateInc' : s === 'exc' ? 'adv.stateExc' : 'adv.stateNone')) + '">' +
      (s === 'inc' ? '+ ' : s === 'exc' ? '− ' : '') + esc(label) + (count ? ' <span class="chip__count">' + count + '</span>' : '') + '</button>';
  }
  // The "Search & filters" button, the active criteria and (when open) the panel with every value
  function filtersHtml(route) {
    var st = libState(route), fc = cache.facets[libId(route)] || null, n = activeFilters(st);
    var stateOf = function (f, v) { return st.inc[f].indexOf(v) !== -1 ? 'inc' : st.exc[f].indexOf(v) !== -1 ? 'exc' : ''; };
    var chip = function (f, v, label, count) { return advChip(st, f, v, label, count); };
    var section = function (f, values, searchable) {
      var chosen = st.inc[f].concat(st.exc[f]);
      // Keep chosen values visible even if the counts don't list them
      chosen.forEach(function (v) { if (!values.some(function (x) { return x.value === v; })) values.unshift({ value: v, label: v, count: 0 }); });
      if (!values.length) return '';
      return '<div class="adv-section"><div class="adv-section__head"><span class="adv-section__title">' + esc(t('filter.' + f)) + '</span>' +
          (searchable ? '<input type="search" class="adv-section__find" data-adv-search="' + f + '" placeholder="' + esc(t('adv.find')) + '" aria-label="' + esc(t('adv.find')) + ' ' + esc(t('filter.' + f)) + '" />' : '') +
        '</div><div class="adv-chips" data-adv-chips="' + f + '">' + values.map(function (x) { return chip(f, x.value, x.label, x.count); }).join('') + '</div></div>';
    };
    var map = function (obj, labeler, order) {
      return (order || Object.keys(obj || {})).filter(function (k) { return !fc || (obj && obj[k]); }).map(function (k) { return { value: k, label: labeler(k), count: obj ? obj[k] || 0 : 0 }; });
    };
    var named = function (list) { return (list || []).map(function (x) { return { value: x.name, label: x.name, count: x.count }; }); };
    var panel = st.panel ? '<div class="adv-panel" id="lib-adv">' +
        '<p class="muted small adv-help">' + esc(t('adv.help')) + '</p>' +
        section('type', map(fc && fc.types, function (k) { return t('type.' + k); }, WORK_TYPES.concat(['unknown']))) +
        section('status', map(fc && fc.statuses, function (k) { return t('series.status.' + k); }, ['ongoing', 'ended', 'hiatus', 'abandoned', 'unknown'])) +
        section('genre', named(fc && fc.genres), true) +
        section('tag', named(fc && fc.tags), true) +
        section('person', named(fc && fc.people), true) +
        section('metadata', map(fc && fc.metadata, function (k) { return t('filter.metadata.' + k); }, ['matched', 'unmatched', 'none'])) +
        '<div class="adv-section adv-fields">' +
          '<label class="adv-field"><span>' + esc(t('adv.yearFrom')) + '</span><input type="number" inputmode="numeric" min="1000" max="9999" data-adv-field="yearFrom" value="' + esc(st.yearFrom) + '" class="input--short" /></label>' +
          '<label class="adv-field"><span>' + esc(t('adv.yearTo')) + '</span><input type="number" inputmode="numeric" min="1000" max="9999" data-adv-field="yearTo" value="' + esc(st.yearTo) + '" class="input--short" /></label>' +
          '<label class="adv-field adv-field--grow"><span>' + esc(t('adv.author')) + '</span><input type="search" data-adv-field="author" value="' + esc(st.author) + '" placeholder="' + esc(t('adv.authorPlaceholder')) + '" /></label>' +
        '</div>' +
      '</div>' : '';
    return '<div class="toolbar toolbar--filters">' +
        '<button type="button" class="btn btn--outline btn--pill' + (st.panel ? ' is-active' : '') + '" data-adv-toggle aria-expanded="' + (st.panel ? 'true' : 'false') + '" aria-controls="lib-adv">' +
          icon('tune') + esc(t('adv.button')) + (n ? ' <span class="badge badge--primary">' + n + '</span>' : '') + '</button>' +
        activeChipsHtml(route) +
      '</div>' + panel;
  }

  /* ================= SERIES ================= */
  function nextToRead(books) {
    var inProgress = books.filter(function (b) { return b.progress && !b.progress.completed; })[0];
    if (inProgress) return { book: inProgress, key: 'series.continue' };
    var unread = books.filter(function (b) { return !b.progress; })[0];
    if (unread) return { book: unread, key: books.some(function (b) { return b.progress; }) ? 'series.continue' : 'series.read' };
    return books.length ? { book: books[0], key: 'series.readAgain', fromStart: true } : null;
  }
  function chips(list, cls) {
    return list.length ? '<div class="chips">' + list.map(function (x) { return '<span class="chip ' + (cls || '') + '">' + x + '</span>'; }).join('') + '</div>' : '';
  }
  // Genre/tag chips that open the work's library filtered by that value
  function filterChips(s, kind, values, cls) {
    if (!values.length) return '';
    return '<div class="chips" aria-label="' + esc(t(kind === 'genre' ? 'filter.genre' : 'filter.tag')) + '">' + values.map(function (v) {
      return '<a class="chip chip--filter ' + cls + '" href="#library/' + s.libraryId + '?' + kind + '=' + encodeURIComponent(v) + '">' + esc(v) + '</a>';
    }).join('') + '</div>';
  }

  // The chapters/books of a work: a one-shot shows its pages; otherwise tiles or a list (work setting,
  // else the library default)
  function booksSection(s, books) {
    if (!books.length) return '<h2 class="section-title">' + esc(t('series.books')) + '</h2>' + emptyState('book', '', t('lib.noBooks'));
    var only = books[0];
    if (s.oneshot && books.length === 1 && only.format === 'cbz' && only.pageCount && !only.error) {
      return '<h2 class="section-title">' + esc(t('series.pages', { count: only.pageCount })) + '</h2>' + pageGrid(only);
    }
    var list = s.bookLayout === 'list';
    // Order: the reader's own choice for this work (this browser), else the work's/library's default
    var order = bookOrderFor(s);
    var shown = order === 'desc' ? books.slice().reverse() : books;
    return '<div class="section-head"><h2 class="section-title">' + esc(t('series.books')) + '</h2>' +
        '<button class="btn btn--text btn--small" data-lib="book-order" data-id="' + s.id + '" title="' + esc(t('order.toggle')) + '">' +
          icon(order === 'desc' ? 'arrow_upward' : 'arrow_downward') + esc(t(order === 'desc' ? 'order.desc' : 'order.asc')) + '</button></div>' +
      (list ? bookList(shown) : grid(shown.map(function (b) { return bookCard(b); })));
  }
  function bookOrderFor(s) {
    var own = null;
    try { own = localStorage.getItem('thoth.order.' + s.id); } catch (e) { /* no storage */ }
    return own === 'asc' || own === 'desc' ? own : (s.bookOrder || 'asc');
  }

  // Online metadata: links to the sites it came from; admins can refresh, pick the right match or clear it
  var PROVIDER_NAMES = { anilist: 'AniList', mangadex: 'MangaDex', mangaupdates: 'MangaUpdates', kitsu: 'Kitsu', myanimelist: 'MyAnimeList',
    openlibrary: 'Open Library', googlebooks: 'Google Books', comicvine: 'Comic Vine' };
  function providerName(id) {
    if (PROVIDER_NAMES[id]) return PROVIDER_NAMES[id];
    var p = (providersCache || []).filter(function (x) { return x.id === id; })[0]; // folder sources have their own names
    return p ? p.name : id;
  }
  // People as chips like the tags ("Eiichiro Oda · Writer, Penciller"), one per person; each opens the
  // library filtered by that person (any role). Without a library (s null) they're plain chips.
  function authorsLine(list, s) {
    if (!list || !list.length) return '';
    var byName = [], seen = {};
    list.forEach(function (a) {
      if (!seen[a.name]) { seen[a.name] = { name: a.name, roles: [] }; byName.push(seen[a.name]); }
      if (a.role && seen[a.name].roles.indexOf(a.role) === -1) seen[a.name].roles.push(a.role);
    });
    return '<div class="chips detail__authors" aria-label="' + esc(t('filter.person')) + '">' + byName.slice(0, 12).map(function (a) {
      var inner = icon('person') + '<span>' + esc(a.name) + '</span>' +
        (a.roles.length ? '<span class="chip__role">' + esc(a.roles.map(function (r) { return t('author.' + r); }).join(', ')) + '</span>' : '');
      return s ? '<a class="chip chip--filter chip--person" href="#library/' + s.libraryId + '?person=' + encodeURIComponent(a.name) + '">' + inner + '</a>'
        : '<span class="chip chip--person">' + inner + '</span>';
    }).join('') + '</div>';
  }
  // "https://www.example.org/x" → "example.org"
  function linkHost(url) {
    var m = /^https?:\/\/(?:www\.)?([^/?#:]+)/i.exec(url || '');
    return m ? m[1] : url;
  }
  function metadataBlock(s) {
    var md = s.metadata, loc = s.localSources || [], urls = s.links || [];
    if (!md && !loc.length && !urls.length && !isAdmin()) return '';
    // One line per source: the folder sources (JSON files), then every link of the work (its pages on the
    // metadata sites it was matched to, links from its JSON files, links added by hand)
    var lines = loc.map(function (l) {
      return '<li>' + icon('description') + ' <span>' + esc(l.name) + (isAdmin() && s.localFile ? ' <span class="muted">· ' + esc(s.localFile) + '</span>' : '') + '</span></li>';
    }).concat(urls.map(function (l) {
      // Only the source's name (a known site, else the page's host), opening the address
      return '<li>' + icon('open_in_new') + ' <a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(l.url) + '">' +
        esc(l.site ? providerName(l.site) : linkHost(l.url)) + '</a></li>';
    }));
    var links = lines.length ? '<ul class="meta-links">' + lines.join('') + '</ul>' : '';
    var localLine = loc.length && isAdmin() && s.localCover ? '<p class="muted small">' + esc(t('msrc.withCover')) + '</p>' : '';
    var locked = md && md.locked ? [].concat(md.locked) : [];
    var status = !md ? t('meta.never')
      : md.matched ? t('meta.updated', { time: A().fmtDate(md.fetchedAt) }) + (locked.length ? ' · ' + t('meta.lockedTo', { provider: locked.map(function (l) { return providerName(l.provider); }).join(', ') }) : '') +
          (md.cover ? ' · ' + (md.coverProvider ? t('meta.coverFrom', { provider: providerName(md.coverProvider) }) : t('meta.coverDownloaded')) + (s.coverSource === 'metadata' ? '' : ' (' + t('meta.coverNotShown') + ')') : ' · ' + t('meta.noCover'))
      : t('meta.noMatch', { time: A().fmtDate(md.fetchedAt) });
    return '<div class="detail__in detail__meta-src">' +
      '<span class="muted small">' + esc(t('meta.sources')) + '</span>' + links + localLine +
      (isAdmin() ? '<p class="muted small">' + esc(status) + '</p>' +
        (md && md.errors && md.errors.length ? '<p class="notice notice--error small">' + esc(md.errors.slice(0, 2).join('; ')) + '</p>' : '') +
        '<div class="detail__actions detail__actions--small">' +
          '<button class="btn btn--text" data-lib="meta-refresh" data-id="' + s.id + '">' + icon('sync') + esc(t('meta.refresh')) + '</button>' +
          '<button class="btn btn--text" data-lib="meta-identify" data-id="' + s.id + '">' + icon('search') + esc(t('meta.identify')) + '</button>' +
          (md ? '<button class="btn btn--text btn--danger" data-lib="meta-clear" data-id="' + s.id + '">' + icon('delete') + esc(t('meta.clear')) + '</button>' : '') +
        '</div>' : '') +
    '</div>';
  }

  var series = {
    title: function (route) { var d = cache.series[route.param]; return d && d.series ? d.workTitle || d.series.title : ''; },
    render: function (route) {
      var d = cache.series[route.param];
      if (!d) return spinner;
      if (d.error) return errorBanner(d.error);
      var s = d.series, books = d.books;
      // w: the work's title, metadata and cover, shared by its versions (the main version's); s: this version
      // (its chapters, reading progress, folder)
      var w = d.work || s;
      var next = nextToRead(books);
      var allRead = s.booksCount && s.booksRead === s.booksCount;
      var meta = [
        '<a href="#library/' + s.libraryId + '">' + esc(s.libraryName) + '</a>',
        esc(count(s.booksCount, 'lib.bookCount1', 'lib.booksCount')),
        w.type ? '<span class="badge badge--primary">' + esc(t('type.' + w.type)) + '</span>' : '',
        w.year ? esc(w.year) : '',
        w.status !== 'unknown' ? '<span class="badge">' + esc(t('series.status.' + w.status)) + '</span>' : '',
        w.rating != null ? '<span title="' + esc(t('meta.rating')) + '">★ ' + esc((w.rating / 10).toFixed(1)) + '</span>' : '',
        w.publisher ? esc(w.publisher) : '',
        s.readingDirection !== 'ltr' ? esc(t('series.direction.' + s.readingDirection)) : ''
      ].filter(Boolean);
      var progressLine = s.booksRead || s.booksInProgress
        ? '<p class="muted small">' + esc(t('series.readOf', { read: s.booksRead, total: s.booksCount })) + '</p>' : '';
      // Versions of this work (Regular, Colored, Raw, Uncensored, Animated) as tabs over the chapters: the same
      // work, another chapter list
      var editions = d.editions || [];
      var tabs = editions.length > 1
        ? '<nav class="tabs version-tabs" aria-label="' + esc(t('series.versions')) + '">' + editions.map(function (e) {
            var active = e.id === s.id;
            var done = e.booksCount && e.booksRead === e.booksCount;
            var otherLib = e.libraryId !== s.libraryId ? ' <span class="tab__lib">' + esc(e.libraryName) + '</span>' : '';
            return '<a class="tab' + (active ? ' is-active' : '') + '" href="#series/' + e.id + '"' + (active ? ' aria-current="page"' : '') + '>' +
              editionTag(e.edition, true) + otherLib + '<span class="tab__count">' + (done ? icon('check') : e.booksCount) + '</span></a>';
          }).join('') + '</nav>'
        : '';
      // A hidden (logically deleted) work: only administrators get here; offer to restore it
      var hiddenBanner = s.hidden ? '<div class="banner banner--info"><span>' + esc(t('del.hiddenBanner', { time: A().fmtDate(s.hidden.at), by: s.hidden.by || '' })) + '</span>' +
        '<button class="btn btn--primary" data-lib="series-restore" data-id="' + s.id + '">' + esc(t('del.restore')) + '</button></div>' : '';
      return backLink('#library/' + s.libraryId, s.libraryName) + hiddenBanner +
        '<div class="detail">' +
          // The cover opens full size (click/Enter); a placeholder (no image) doesn't
          (w.coverSource ? '<button type="button" class="detail__cover cover cover--large cover--zoom" data-lib="cover-zoom" data-src="/api/series/' + w.id + '/thumbnail?v=' + w.coverV + '" aria-label="' + esc(t('series.coverZoom')) + '" title="' + esc(t('series.coverZoom')) + '">' + seriesCoverHtml(w) + '</button>'
            : '<div class="detail__cover cover cover--large">' + seriesCoverHtml(w) + '</div>') +
          '<div class="detail__body">' +
            // The version shown: a colored tag after the title (none for Regular)
            '<h1 class="detail__title">' + esc(w.title) + (s.edition !== 'base' ? ' ' + editionTag(s.edition) : '') + '</h1>' +
            '<div class="detail__meta">' + meta.join('<span class="dot">·</span>') + '</div>' +
            authorsLine(w.authors, w) +
            (w.altTitles && w.altTitles.length ? '<p class="muted small detail__alt">' + esc(w.altTitles.slice(0, 4).join(' · ')) + '</p>' : '') +
            progressLine +
            filterChips(w, 'genre', w.genres || [], 'chip--genre') +
            filterChips(w, 'tag', w.tags, '') +
            '<div class="detail__actions">' +
              (next ? '<a class="btn btn--primary" href="#read/' + next.book.id + (next.fromStart ? '?page=1' : '') + '">' + icon('play') + esc(t(next.key)) + '</a>' : '') +
              '<button class="btn btn--outline" data-lib="series-toggle-read" data-id="' + s.id + '" data-done="' + (allRead ? '1' : '') + '">' + icon(allRead ? 'remove_done' : 'done_all') + esc(t(allRead ? 'series.markUnread' : 'series.markRead')) + '</button>' +
              (isAdmin() ? '<button class="btn btn--text" data-lib="series-add-collection" data-id="' + s.id + '">' + icon('collections') + esc(t('series.addToCollection')) + '</button>' +
                '<button class="btn btn--text" data-lib="series-edit" data-id="' + w.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' +
                (s.hidden ? '' : '<button class="btn btn--text btn--danger" data-lib="series-delete" data-id="' + s.id + '">' + icon('delete') + esc(t('del.button')) + '</button>') : '') +
            '</div>' +
            (w.summary ? '<p class="detail__summary">' + esc(w.summary) + '</p>' : '') +
            metadataBlock(w) +
            (d.collections.length ? '<div class="detail__in"><span class="muted small">' + esc(t('series.inCollections')) + '</span>' +
              chips(d.collections.map(function (c) { return '<a href="#collection/' + c.id + '">' + esc(c.name) + '</a>'; }), 'chip--link') + '</div>' : '') +
            (isAdmin() && s.path != null ? '<p class="muted small detail__path">' + icon('folder_open') + esc(s.path || '/') + '</p>' : '') +
          '</div>' +
        '</div>' +
        tabs + booksSection(s, books);
    },
    enter: function (route) {
      var id = route.param;
      load(route.hash, function () {
        return api('GET', '/api/series/' + id).then(function (r) { cache.series[id] = r; }, function (e) { cache.series[id] = { error: e }; throw e; });
      }, function () { return cache.series[id]; });
    }
  };

  /* ================= BOOK ================= */
  var book = {
    title: function (route) { var d = cache.book[route.param]; return d && d.book ? d.book.title : ''; },
    render: function (route) {
      var d = cache.book[route.param];
      if (!d) return spinner;
      if (d.error) return errorBanner(d.error);
      var b = d.book, s = d.series, p = b.progress;
      var readHref = '#read/' + b.id;
      var readLabel = p && !p.completed ? t('book.continueAt', { page: p.page }) : t(p && p.completed ? 'series.readAgain' : 'book.read');
      if (p && p.completed) readHref += '?page=1';
      var status = p ? (p.completed ? t('book.progressRead') : t('book.progressAt', { page: p.page, total: b.pageCount || '?' })) : t('book.unread');
      var rows = [
        ['book.format', b.format.toUpperCase()],
        ['book.pagesLabel', b.pageCount ? String(b.pageCount) : t('book.pagesUnknown')],
        ['book.size', fmtSize(b.size)],
        b.releaseDate ? ['book.released', b.releaseDate] : null,
        ['book.status', status],
        isAdmin() && b.path ? ['book.file', b.path] : null,
        b.localSource ? ['msrc.bookSource', b.localSource.name + (isAdmin() && b.localFile ? ' (' + b.localFile + ')' : '')] : null
      ].filter(Boolean);
      var seriesLabel = s ? s.title + (s.edition !== 'base' ? ' (' + editionLabel(s.edition) + ')' : '') : '';
      var back = s ? backLink('#series/' + s.id, seriesLabel) : '';
      return back +
        (b.error ? '<div class="banner banner--error">' + esc(t('book.error', { error: b.error })) + '</div>' : '') +
        '<div class="detail">' +
          '<div class="detail__cover cover cover--large">' + bookCoverHtml(b) +
            (progressPct(p, b.pageCount) && !(p && p.completed) ? '<div class="cover__progress"><span style="width:' + progressPct(p, b.pageCount) + '%"></span></div>' : '') + '</div>' +
          '<div class="detail__body">' +
            '<p class="detail__eyebrow">' + esc(b.oneshot ? t('lib.oneshot') : t('book.number', { number: b.number })) + '</p>' +
            '<h1 class="detail__title">' + esc(b.title) + '</h1>' +
            (b.altTitles && b.altTitles.length ? '<p class="muted small detail__alt">' + esc(b.altTitles.slice(0, 4).join(' · ')) + '</p>' : '') +
            authorsLine(b.authors, s) +
            (s && b.genres && b.genres.length ? filterChips(s, 'genre', b.genres, 'chip--genre') : '') +
            (s && b.tags && b.tags.length ? filterChips(s, 'tag', b.tags, '') : '') +
            '<div class="detail__actions">' +
              (!b.error ? '<a class="btn btn--primary" href="' + readHref + '">' + icon('play') + esc(readLabel) + '</a>' : '') +
              (p && !p.completed ? '<a class="btn btn--outline" href="#read/' + b.id + '?page=1">' + esc(t('book.readFromStart')) + '</a>' : '') +
              '<button class="btn btn--outline" data-lib="book-toggle-read" data-id="' + b.id + '" data-done="' + (p && p.completed ? '1' : '') + '" data-pages="' + (b.pageCount || 1) + '">' +
                icon(p && p.completed ? 'remove_done' : 'done_all') + esc(t(p && p.completed ? 'series.markUnread' : 'series.markRead')) + '</button>' +
              '<a class="btn btn--text" href="/api/books/' + b.id + '/file?download=1" download>' + icon('download') + esc(t('book.download')) + '</a>' +
              (isAdmin() ? '<button class="btn btn--text" data-lib="book-add-readlist" data-id="' + b.id + '">' + icon('readlist') + esc(t('book.addToReadlist')) + '</button>' +
                '<button class="btn btn--text" data-lib="book-edit" data-id="' + b.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' : '') +
            '</div>' +
            '<dl class="pref-list detail__facts">' + rows.map(function (r) { return '<dt>' + esc(t(r[0])) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
            (b.summary ? '<p class="detail__summary">' + esc(b.summary) + '</p>' : '') +
            (d.readlists.length ? '<div class="detail__in"><span class="muted small">' + esc(t('book.inReadlists')) + '</span>' +
              chips(d.readlists.map(function (r) { return '<a href="#readlist/' + r.id + '">' + esc(r.name) + '</a>'; }), 'chip--link') + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="prev-next">' +
          (d.prev ? '<a class="prev-next__link" href="#book/' + d.prev.id + '">' + icon('chevron_left') + '<span><span class="muted small">' + esc(t('book.prev')) + '</span><br>' + esc(d.prev.number + ' · ' + d.prev.title) + '</span></a>' : '<span></span>') +
          (d.next ? '<a class="prev-next__link prev-next__link--next" href="#book/' + d.next.id + '"><span><span class="muted small">' + esc(t('book.next')) + '</span><br>' + esc(d.next.number + ' · ' + d.next.title) + '</span>' + icon('chevron_right') + '</a>' : '') +
        '</div>';
    },
    enter: function (route) {
      var id = route.param;
      load(route.hash, function () {
        return api('GET', '/api/books/' + id).then(function (r) { cache.book[id] = r; }, function (e) { cache.book[id] = { error: e }; throw e; });
      }, function () { return cache.book[id]; });
    }
  };

  /* ================= SEARCH ================= */
  var search = {
    title: function () { return t('nav.search'); },
    render: function (route) {
      var q = route.query.get('q') || '';
      var head = '<h1 class="page-title">' + esc(q ? t('search.title', { q: q }) : t('nav.search')) + '</h1>';
      if (!q) return head + emptyState('search', '', t('search.hint'));
      var r = cache.search[q];
      if (!r) return head + spinner;
      if (r.error) return head + errorBanner(r.error);
      if (!r.series.length && !r.books.length && !r.collections.length && !r.readlists.length) return head + emptyState('search', '', t('search.none', { q: q }));
      return head +
        (r.series.length ? '<h2 class="section-title">' + esc(t('search.series')) + '</h2>' + grid(r.series.map(function (s) { return seriesCard(s); })) : '') +
        (r.books.length ? '<h2 class="section-title">' + esc(t('search.books')) + '</h2>' + grid(r.books.map(function (b) { return bookCard(b, { showSeries: true }); })) : '') +
        (r.collections.length ? '<h2 class="section-title">' + esc(t('nav.collections')) + '</h2>' + grid(r.collections.map(collectionCard)) : '') +
        (r.readlists.length ? '<h2 class="section-title">' + esc(t('nav.readlists')) + '</h2>' + grid(r.readlists.map(readlistCard)) : '');
    },
    enter: function (route) {
      var q = route.query.get('q') || '';
      if (!q) return;
      load(route.hash, function () {
        return api('GET', '/api/search?q=' + encodeURIComponent(q)).then(function (r) { cache.search[q] = r; }, function (e) { cache.search[q] = { error: e }; throw e; });
      }, function () { return cache.search[q]; });
    }
  };

  /* ================= COLLECTIONS ================= */
  function stackCover(items) {
    if (!items.length) return '<div class="cover">' + placeholder('') + '</div>';
    return '<div class="cover cover--stack">' + items.slice(0, 3).map(function (x, i) {
      return '<div class="cover__layer cover__layer--' + i + '">' + x + '</div>';
    }).reverse().join('') + '</div>';
  }
  function collectionCard(c) {
    var covers = c.coverSeries.map(seriesCoverHtml);
    return '<div class="media-card"><a class="media-card__link" href="#collection/' + c.id + '">' + stackCover(covers) +
      '<div class="media-card__title">' + esc(c.name) + '</div><div class="media-card__sub">' + esc(count(c.seriesCount, 'lib.seriesCount1', 'lib.seriesCount')) + '</div></a></div>';
  }
  function readlistCard(r) {
    var covers = r.coverBooks.map(function (b) { return b.format === 'cbz' ? '<img class="cover__img" loading="lazy" alt="" src="/api/books/' + b.id + '/thumbnail?v=' + b.v + '" />' + placeholder('cbz') : placeholder(b.format); });
    return '<div class="media-card"><a class="media-card__link" href="#readlist/' + r.id + '">' + stackCover(covers) +
      '<div class="media-card__title">' + esc(r.name) + '</div><div class="media-card__sub">' + esc(t('rl.progress', { read: r.booksRead, total: r.booksCount })) + '</div></a></div>';
  }

  var collections = {
    title: function () { return t('nav.collections'); },
    render: function () {
      var c = cache.collections;
      var head = '<div class="page-head"><h1 class="page-title">' + esc(t('nav.collections')) + '</h1>' +
        (isAdmin() ? '<button class="btn btn--primary" data-lib="collection-new">' + icon('add') + esc(t('coll.new')) + '</button>' : '') + '</div>';
      if (!c) return head + spinner;
      if (c.error) return head + errorBanner(c.error);
      if (!c.list.length) return head + emptyState('collections', t('coll.empty'), isAdmin() ? t('coll.emptyAdmin') : '');
      return head + grid(c.list.map(collectionCard));
    },
    enter: function (route) {
      load(route.hash, function () {
        return api('GET', '/api/collections').then(function (r) { cache.collections = { list: r.collections }; }, function (e) { cache.collections = { error: e }; throw e; });
      }, function () { return cache.collections; });
    }
  };
  var collection = {
    title: function (route) { var d = cache.collection[route.param]; return d && d.name ? d.name : t('nav.collections'); },
    render: function (route) {
      var d = cache.collection[route.param];
      if (!d) return spinner;
      if (d.error) return backLink('#collections', t('nav.collections')) + errorBanner(d.error);
      return backLink('#collections', t('nav.collections')) +
        '<div class="page-head"><h1 class="page-title">' + esc(d.name) + '</h1>' +
          (isAdmin() ? '<div class="toolbar__group">' +
            '<button class="btn btn--text" data-lib="collection-rename" data-id="' + d.id + '">' + icon('edit') + esc(t('coll.rename')) + '</button>' +
            '<button class="btn btn--text btn--danger" data-lib="collection-delete" data-id="' + d.id + '">' + icon('delete') + esc(t('coll.delete')) + '</button></div>' : '') +
        '</div>' +
        '<p class="muted small grid-count">' + esc(count(d.seriesCount, 'lib.seriesCount1', 'lib.seriesCount')) + '</p>' +
        (d.series.length ? grid(d.series.map(function (s) { return seriesCard(s, { remove: isAdmin() ? 'collection-remove-series' : '' }); })) : emptyState('collections', '', t('coll.noSeries')));
    },
    enter: function (route) {
      var id = route.param;
      load(route.hash, function () {
        return api('GET', '/api/collections/' + id).then(function (r) { cache.collection[id] = r.collection; }, function (e) { cache.collection[id] = { error: e }; throw e; });
      }, function () { return cache.collection[id]; });
    }
  };

  /* ================= READ LISTS ================= */
  var readlists = {
    title: function () { return t('nav.readlists'); },
    render: function () {
      var c = cache.readlists;
      var head = '<div class="page-head"><h1 class="page-title">' + esc(t('nav.readlists')) + '</h1>' +
        (isAdmin() ? '<button class="btn btn--primary" data-lib="readlist-new">' + icon('add') + esc(t('rl.new')) + '</button>' : '') + '</div>';
      if (!c) return head + spinner;
      if (c.error) return head + errorBanner(c.error);
      if (!c.list.length) return head + emptyState('readlist', t('rl.empty'), isAdmin() ? t('rl.emptyAdmin') : '');
      return head + grid(c.list.map(readlistCard));
    },
    enter: function (route) {
      load(route.hash, function () {
        return api('GET', '/api/readlists').then(function (r) { cache.readlists = { list: r.readlists }; }, function (e) { cache.readlists = { error: e }; throw e; });
      }, function () { return cache.readlists; });
    }
  };
  var readlist = {
    title: function (route) { var d = cache.readlist[route.param]; return d && d.name ? d.name : t('nav.readlists'); },
    render: function (route) {
      var d = cache.readlist[route.param];
      if (!d) return spinner;
      if (d.error) return backLink('#readlists', t('nav.readlists')) + errorBanner(d.error);
      var next = nextToRead(d.books);
      var admin = isAdmin();
      return backLink('#readlists', t('nav.readlists')) +
        '<div class="page-head"><h1 class="page-title">' + esc(d.name) + '</h1>' +
          (admin ? '<div class="toolbar__group">' +
            '<button class="btn btn--text" data-lib="readlist-rename" data-id="' + d.id + '">' + icon('edit') + esc(t('coll.rename')) + '</button>' +
            '<button class="btn btn--text btn--danger" data-lib="readlist-delete" data-id="' + d.id + '">' + icon('delete') + esc(t('coll.delete')) + '</button></div>' : '') +
        '</div>' +
        (d.summary ? '<p class="page-lead">' + esc(d.summary) + '</p>' : '') +
        '<div class="detail__actions">' +
          (next ? '<a class="btn btn--primary" href="#read/' + next.book.id + '?readlist=' + d.id + (next.fromStart ? '&page=1' : '') + '">' + icon('play') + esc(t(next.key)) + '</a>' : '') +
          '<span class="muted small">' + esc(t('rl.progress', { read: d.booksRead, total: d.booksCount })) + '</span>' +
        '</div>' +
        (d.books.length ? grid(d.books.map(function (b, i) {
          return bookCard(b, {
            showSeries: true, index: i + 1,
            controls: admin ? '<div class="media-card__tools">' +
              '<button class="icon-btn icon-btn--sm" data-lib="readlist-move" data-id="' + b.id + '" data-dir="-1" data-icon="chevron_left" title="' + esc(t('rl.moveUp')) + '" aria-label="' + esc(t('rl.moveUp')) + '"' + (i === 0 ? ' disabled' : '') + '></button>' +
              '<button class="icon-btn icon-btn--sm icon-btn--danger" data-lib="readlist-remove-book" data-id="' + b.id + '" data-icon="close" title="' + esc(t('rl.remove')) + '" aria-label="' + esc(t('rl.remove')) + '"></button>' +
              '<button class="icon-btn icon-btn--sm" data-lib="readlist-move" data-id="' + b.id + '" data-dir="1" data-icon="chevron_right" title="' + esc(t('rl.moveDown')) + '" aria-label="' + esc(t('rl.moveDown')) + '"' + (i === d.books.length - 1 ? ' disabled' : '') + '></button>' +
            '</div>' : ''
          });
        })) : emptyState('readlist', '', t('rl.noBooks')));
    },
    enter: function (route) {
      var id = route.param;
      load(route.hash, function () {
        return api('GET', '/api/readlists/' + id).then(function (r) { cache.readlist[id] = r.readlist; }, function (e) { cache.readlist[id] = { error: e }; throw e; });
      }, function () { return cache.readlist[id]; });
    }
  };

  /* ================= PROGRESS BARS ================= */
  // "45 s", "3 min", "1 h 20 min"
  function fmtTime(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return t('time.seconds', { n: s });
    var m = Math.round(s / 60);
    if (m < 60) return t('time.minutes', { n: m });
    return t('time.hours', { h: Math.floor(m / 60), m: m % 60 });
  }
  // p: { percent (null = not known yet), etaMs (null = not estimated yet), elapsedMs }
  function progressBar(p, label, detail) {
    var known = p && p.percent != null;
    var eta = !p ? '' : p.etaMs != null ? (p.etaMs < 5000 ? t('progress.almostDone') : t('progress.left', { time: fmtTime(p.etaMs) })) : known && p.percent < 100 ? t('progress.estimating') : '';
    var parts = [label, known ? p.percent + '%' : '', detail || '', eta].filter(Boolean);
    return '<div class="progress' + (known ? '' : ' progress--indeterminate') + '" role="progressbar" aria-label="' + esc(label) + '"' +
        (known ? ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p.percent + '"' : '') + '>' +
      '<div class="progress__track"><span class="progress__fill" style="width:' + (known ? p.percent : 30) + '%"></span></div>' +
      '<div class="progress__text small">' + esc(parts.join(' · ')) + (p && p.elapsedMs ? '<span class="muted"> · ' + esc(t('progress.elapsed', { time: fmtTime(p.elapsedMs) })) + '</span>' : '') + '</div>' +
    '</div>';
  }
  // A running library scan: finding files (count so far) → reading new/changed files (x of y) → saving
  function scanProgressBar(prog, full) {
    var p = prog || { phase: 'listing' };
    var label = (full ? scanModeLabel(typeof full === 'object' ? full : { full: true }) + ': ' : '') + t('progress.phase.' + (p.phase || 'listing'));
    var detail = p.phase === 'reading' ? t('progress.files', { done: p.done, total: p.total })
      : p.phase === 'listing' ? t('progress.found', { count: p.filesSeen || 0 }) : '';
    return progressBar(p, label, detail);
  }

  // "Quick scan" / "Scan changes" / "Full scan" for a scan report, running scan or queue entry
  function scanModeLabel(x) {
    var m = x.scanMode || (x.full ? 'full' : 'changes');
    return t(m === 'quick' ? 'manage.modeQuick' : m === 'full' ? 'manage.modeFull' : 'manage.modeChanges');
  }

  /* ================= MANAGE LIBRARIES (admins) ================= */
  var pollTimer = null;
  function scanSummary(l) {
    if (l.scanning) {
      var p = l.scanProgress || {};
      if (p.serviceStopped) return '<p class="notice">' + esc(t('manage.queuedStopped')) + ' <a href="#processes">' + esc(t('nav.processes')) + '</a></p>';
      if (p.queued) return '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc(t('manage.queued')) + '</p>';
      if (p.progress) return scanProgressBar(p.progress, p);
      return '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc((p.full ? t('manage.modeFull') + ': ' : '') + t('manage.scanningNow', { seen: p.filesSeen || 0, analyzed: p.analyzed || 0 })) + '</p>';
    }
    if (l.scanError) return '<p class="notice notice--error">' + esc(A().errMsg({ code: l.scanError, message: l.scanError })) + '</p>';
    var s = l.lastScan;
    if (!s) return '<p class="muted small">' + esc(t('manage.neverScanned')) + '</p>';
    var html = '<p class="muted small">' + esc(t('manage.lastScan', { time: A().fmtDate(s.at) })) + ' (' + esc(scanModeLabel(s) + (s.reason ? ', ' + t('manage.reason.' + s.reason) : '')) + ') · ' +
      esc(t('manage.scanSummary', { series: s.series, books: s.books, added: s.added, updated: s.updated, removed: s.removed })) +
      (s.scanMode === 'quick' && s.folders ? ' · ' + esc(t('manage.foldersSkipped', { skipped: s.foldersSkipped || 0, total: s.folders })) : '') + '</p>';
    if (s.unsupported) html += '<p class="notice">' + esc(t(s.unsupported === 1 ? 'manage.unsupported1' : 'manage.unsupported', { count: s.unsupported, examples: (s.unsupportedExamples || []).slice(0, 2).join(', ') })) + '</p>';
    if (s.failedBooks) html += '<p class="notice notice--error">' + esc(t(s.failedBooks === 1 ? 'manage.failed1' : 'manage.failed', { count: s.failedBooks })) + '</p>';
    if (s.errors && s.errors.length) html += '<p class="notice notice--error">' + esc(t('manage.scanErrors')) + ': ' + esc(s.errors.slice(0, 3).join('; ')) + '</p>';
    return html;
  }
  // "Metadata: AniList → MangaDex → … · 12 of 40 works matched"
  function metadataLine(l) {
    if (!l.metadata) return '';
    var on = l.metadata.providers.filter(function (p) { return p.enabled; }).map(function (p) { return providerName(p.id); });
    return '<p class="muted small">' + esc(t('meta.line', { providers: on.length ? on.join(' → ') : t('meta.noneOn') })) +
      (l.seriesCount ? ' · ' + esc(t('meta.matched', { count: l.metadataCount || 0, total: l.seriesCount })) : '') + '</p>';
  }
  var manage = {
    title: function () { return t('nav.manageLibraries'); },
    render: function () {
      var m = cache.manage;
      var head = '<div class="page-head"><h1 class="page-title">' + esc(t('nav.manageLibraries')) + '</h1>' +
        '<button class="btn btn--primary" data-lib="library-add">' + icon('add') + esc(t('manage.add')) + '</button></div>' +
        '<p class="page-lead">' + esc(t('manage.intro')) + ' ' + esc(t('manage.formats')) + '</p>';
      if (!m) return head + spinner;
      if (m.error) return head + errorBanner(m.error);
      var interval = String(m.settings.scanIntervalMinutes);
      var opts = [['0', 'manage.never'], ['15', 'manage.every15'], ['60', 'manage.every60'], ['360', 'manage.every360'], ['1440', 'manage.every1440']];
      if (!opts.some(function (o) { return o[0] === interval; })) opts.push([interval, interval + ' min']);
      return head +
        (m.libraries.length ? '<div class="lib-list">' + m.libraries.map(function (l) {
          return '<section class="card lib-card">' +
            '<div class="lib-card__head"><span class="lib-card__icon">' + icon('library') + '</span>' +
              '<div class="lib-card__text"><h2 class="card__title"><a href="#library/' + l.id + '">' + esc(l.name) + '</a></h2>' +
              '<p class="muted small lib-card__path">' + icon('folder_open') + '<span>' + esc(l.root) + '</span></p></div></div>' +
            '<p class="small">' + esc(count(l.seriesCount, 'lib.seriesCount1', 'lib.seriesCount')) + ' · ' + esc(count(l.booksCount, 'lib.bookCount1', 'lib.booksCount')) + '</p>' +
            '<p class="muted small">' + esc(oneshotsOf(l).folder
              ? t('manage.oneshotsLineExtra', { folder: oneshotsOf(l).folder })
              : t('manage.oneshotsLineRoot')) + '</p>' +
            metadataLine(l) +
            scanSummary(l) +
            '<div class="lib-card__actions">' +
              '<button class="btn btn--outline btn--pill" data-lib="scan-library" data-id="' + l.id + '"' + (l.scanning ? ' disabled' : '') + ' title="' + esc(t('manage.scanChangesHelp')) + '">' + icon('sync') + esc(t(l.scanning ? 'lib.scanning' : 'manage.scanChanges')) + '</button>' +
              '<button class="btn btn--text" data-lib="scan-library" data-full="1" data-id="' + l.id + '"' + (l.scanning ? ' disabled' : '') + ' title="' + esc(t('manage.scanFullHelp')) + '">' + icon('update') + esc(t('manage.scanFull')) + '</button>' +
              '<button class="btn btn--text" data-lib="library-metadata" data-mode="stale" data-id="' + l.id + '" title="' + esc(t('meta.updateHelp')) + '">' + icon('download') + esc(t('meta.update')) + '</button>' +
              '<button class="btn btn--text" data-lib="library-metadata" data-mode="all" data-id="' + l.id + '" title="' + esc(t('meta.refreshAllHelp')) + '">' + icon('sync') + esc(t('meta.refreshAll')) + '</button>' +
              '<button class="btn btn--text" data-lib="library-edit" data-id="' + l.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' +
              '<button class="btn btn--text btn--danger" data-lib="library-delete" data-id="' + l.id + '">' + icon('delete') + esc(t('manage.delete')) + '</button>' +
            '</div></section>';
        }).join('') + '</div>' : emptyState('library', t('manage.empty'), '')) +
        '<section class="card card--wide">' +
          '<h2 class="card__title">' + esc(t('manage.interval')) + '</h2>' +
          '<div class="field"><select class="select" id="scan-interval">' +
            opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === interval ? ' selected' : '') + '>' + esc(o[1].indexOf('manage.') === 0 ? t(o[1]) : o[1]) + '</option>'; }).join('') +
          '</select><small class="field__help">' + esc(t('manage.intervalHelp')) + '</small></div>' +
        '</section>';
    },
    mount: function (el) {
      var sel = $('#scan-interval', el);
      if (sel) sel.addEventListener('change', function () {
        api('PATCH', '/api/library-settings', { scanIntervalMinutes: Number(sel.value) }).then(function (r) {
          cache.manage.settings = r; A().toast(t('manage.intervalSaved'));
        }, function (e) { A().toast(A().errMsg(e)); });
      });
    },
    enter: function (route) {
      clearTimeout(pollTimer);
      load(route.hash, function () {
        // (sources: so folder sources show their names on the cards)
        return Promise.all([api('GET', '/api/libraries'), api('GET', '/api/library-settings'), loadProviders()]).then(function (r) {
          var wasScanning = cache.manage && cache.manage.libraries.some(function (l) { return l.scanning; });
          cache.manage = { libraries: r[0].libraries, settings: r[1] };
          var scanning = r[0].libraries.some(function (l) { return l.scanning; });
          // Keep the page live while a scan runs; refresh the sidebar counts when it ends
          if (scanning) pollTimer = setTimeout(function () { if (location.hash === route.hash) manage.enter(route); }, 1500);
          if (wasScanning && !scanning) { A().refreshLibraries(); invalidate(); }
        }, function (e) { cache.manage = { error: e }; throw e; });
      });
    }
  };

  /* ================= RENAME FILES (admins) ================= */
  // Check a library for files to rename (chapter-1.cbz → Chapter 1.cbz), review, rename the picked ones
  var RENAME_ERRORS = { changed: 'ren.err.changed', exists: 'ren.status.exists', conflict: 'ren.status.conflict', 'read-only': 'ren.err.readOnly', 'no permission': 'ren.err.noPermission', locked: 'ren.err.locked', stalled: 'ren.err.stalled',notEmpty: 'files.err.notEmpty', notDeletable: 'files.err.notDeletable', otherDisk: 'files.err.otherDisk' };
  // Selection: mode 'all' = every valid proposal (also those not listed: the list shows the first 2000)
  // except `excluded`; mode 'some' = only the ticked ones (`selected`)
  function renameState() {
    if (!cache.rename) cache.rename = { library: 'all', data: null, mode: 'all', selected: {}, excluded: {}, guessPicked: {}, renameJson: true, loading: false, result: null, error: null, job: null, rules: null };
    return cache.rename;
  }
  function renameSelectedCount(st) {
    if (!st.data) return 0;
    var guesses = Object.keys(st.guessPicked || {}).length;
    if (st.mode === 'all') return Math.max(0, (st.data.ok != null ? st.data.ok : st.data.items.filter(function (x) { return x.status === 'ok'; }).length) - Object.keys(st.excluded).length) + guesses;
    return Object.keys(st.selected).length + guesses;
  }
  function isRenameSelected(st, id) { return st.mode === 'all' ? !st.excluded[id] : Boolean(st.selected[id]); }
  function runRenamePreview() {
    var st = renameState();
    st.loading = true; st.error = null;
    A().renderPage();
    return api('GET', '/api/rename/preview?' + Store.qs({ library: st.library })).then(function (r) {
      st.data = r;
      st.mode = 'all'; st.selected = {}; st.excluded = {}; st.guessPicked = {};
    }, function (e) { st.error = e; }).then(function () { st.loading = false; if (isFilesRoute()) A().renderPage(); });
  }
  // A queued/running rename job: its progress until it's done, then the result and a fresh check
  var renamePollTimer = null;
  function pollRenameJob() {
    clearTimeout(renamePollTimer);
    var st = renameState();
    if (!st.job) return;
    api('GET', '/api/rename/jobs/' + st.job.id).then(function (r) {
      st.job = r.job;
      var finished = r.job.status === 'done' || r.job.status === 'failed';
      if (finished) {
        st.result = r.job; st.job = null;
        invalidate(); markStale(cache.series); markStale(cache.book);
        if (isFilesRoute()) runRenamePreview(); else st.data = null;
        return;
      }
      if (isFilesRoute()) { var el = $('#ren-job'); if (el) el.outerHTML = renameJobHtml(st.job); else A().renderPage(); }
      renamePollTimer = setTimeout(pollRenameJob, 700);
    }, function () { renamePollTimer = setTimeout(pollRenameJob, 2000); });
  }
  function renameJobHtml(j) {
    if (!j) return '';
    var p = { percent: j.status === 'queued' ? null : j.progress, done: j.done, total: j.total, etaMs: null, elapsedMs: 0, phase: j.status };
    return '<div id="ren-job" class="card card--wide ren-job" role="status">' +
      progressBar(p, t(j.status === 'queued' ? 'ren.jobQueued' : 'ren.jobRunning'), t('ren.jobProgress', { done: j.done, total: j.total || '…', renamed: j.renamed })) +
      renamePhaseHtml(j) +
      '<p class="muted small">' + esc(t('ren.jobHelp')) + '</p></div>';
  }
  // What the job is doing right now, and a warning when the disk hasn't answered for a while
  function renamePhaseHtml(j) {
    var d = j.phaseDetail || {}, text = '';
    if (j.phase === 'waiting') text = t(j.waitingFor ? 'ren.phase.waiting' : 'ren.phase.starting');
    else if (j.phase === 'sources') text = t('ren.phase.sources', { name: d.name || '', n: d.n || 1, of: d.of || 1 });
    else if (j.phase === 'checking') text = t('ren.phase.checking');
    else if (j.phase === 'files') text = j.file ? t('ren.phase.file', { file: j.file }) : t('ren.phase.files');
    var quiet = j.status === 'running' && j.quietSec >= 20 ? '<p class="small warn-text">' + esc(t(j.phase === 'files' ? 'ren.phase.quietFiles' : 'ren.phase.quiet', { sec: j.quietSec })) + '</p>' : '';
    return (text ? '<p class="small ren-phase">' + esc(text) + '</p>' : '') + quiet;
  }
  // File management: tabs for renaming (and deleting files whose new name is taken) and merging works
  function isFilesRoute() { var n = A().parseRoute().name; return n === 'files' || n === 'rename'; }
  function filesTabs(active) {
    return '<h1 class="page-title">' + esc(t('nav.files')) + '</h1>' +
      '<nav class="tabs files-tabs" aria-label="' + esc(t('nav.files')) + '">' +
        '<a class="tab' + (active === 'rename' ? ' is-active' : '') + '" href="#files"' + (active === 'rename' ? ' aria-current="page"' : '') + '>' + icon('edit') + esc(t('files.tabRename')) + '</a>' +
        '<a class="tab' + (active === 'merge' ? ' is-active' : '') + '" href="#files/merge"' + (active === 'merge' ? ' aria-current="page"' : '') + '>' + icon('collections') + esc(t('files.tabMerge')) + '</a>' +
      '</nav>';
  }
  // Every file involved in a name clash (this one, the one that has the name, others that want it) with what
  // helps to choose: pages, size, date, readers; one that looks like the same chapter twice is marked
  function involvedTable(x, st) {
    var role = { 'this': 'ren.role.this', has: 'ren.role.has', wants: 'ren.role.wants' };
    var largest = Math.max.apply(null, x.involved.map(function (f) { return f.pageCount || 0; }));
    return '<div class="files-dup"><table class="table ren-involved"><thead><tr><th>' + esc(t('ren.col.file')) + '</th><th>' + esc(t('ren.col.pages')) + '</th><th>' + esc(t('ren.col.size')) +
        '</th><th>' + esc(t('ren.col.modified')) + '</th><th>' + esc(t('ren.col.readers')) + '</th><th></th></tr></thead><tbody>' +
      x.involved.map(function (f) {
        return '<tr' + (f.role === 'this' ? ' class="is-this"' : '') + '><td><code>' + esc(f.fileName) + '</code> <span class="muted small">' + esc(t(role[f.role])) + '</span>' +
            (f.same ? ' <span class="badge">' + esc(t('ren.same')) + '</span>' : '') + (f.error ? ' <span class="badge badge--danger">' + esc(t('ren.unreadable')) + '</span>' : '') + '</td>' +
          '<td' + (f.pageCount && f.pageCount === largest && x.involved.length > 1 ? ' class="ren-most"' : '') + '>' + esc(f.pageCount || '—') + '</td>' +
          '<td>' + esc(f.size ? fmtSize(f.size) : '—') + '</td><td>' + esc(f.modified ? A().fmtDate(f.modified) : '—') + '</td><td>' + esc(f.readers || 0) + '</td>' +
          '<td><button class="btn btn--text btn--small btn--danger" data-lib="files-del" data-id="' + esc(f.bookId) + '" data-name="' + esc(f.fileName) + '"' + (st.job ? ' disabled' : '') + '>' + icon('delete') + esc(t('files.deleteThis')) + '</button></td></tr>';
      }).join('') + '</tbody></table>' +
      (x.status === 'exists' && x.other ? '<span class="files-dup__actions"><button class="btn btn--text btn--small" data-lib="files-replace" data-id="' + x.bookId + '" data-name="' + esc(x.other.fileName) + '"' + (st.job ? ' disabled' : '') + '>' + icon('edit') + esc(t('files.keepThis')) + '</button></span>' : '') +
      '<p class="muted small">' + esc(t(x.status === 'exists' ? 'ren.involvedHelpExists' : 'ren.involvedHelp')) + '</p></div>';
  }
  function fmtFileInfo(x) {
    return [x.size ? fmtSize(x.size) : '', x.pageCount ? t('series.pages', { count: x.pageCount }) : ''].filter(Boolean).join(' · ');
  }
  // The result of a finished file job (rename, delete or merge)
  function fileJobResult(r) {
    if (!r) return '';
    var lines = [];
    if (r.renamed) lines.push(t('ren.done', { count: r.renamed }));
    if (r.json) lines.push(t('ren.doneJson', { count: r.json }));
    if (r.deleted) lines.push(t('files.deletedCount', { count: r.deleted }));
    if (r.moved) lines.push(t('files.movedCount', { count: r.moved }));
    if (r.skipped) lines.push(t('files.repeatsCount', { count: r.skipped }));
    if (!lines.length) lines.push(t('ren.done', { count: 0 }));
    var failed = r.failed || [];
    return '<div class="banner ' + (failed.length || r.status === 'failed' ? 'banner--error' : 'banner--ok') + '"><div>' +
      '<strong>' + esc(lines.join(' ')) + '</strong>' +
      (r.error ? '<p>' + esc(r.error) + '</p>' : '') +
      (r.foldersDeleted && r.foldersDeleted.length ? '<p class="small">' + esc(t('files.foldersDeleted', { folders: r.foldersDeleted.join(', ') })) + '</p>' : '') +
      (r.repeats && r.repeats.length && !(r.foldersDeleted && r.foldersDeleted.length) ? '<p class="small">' + esc(t('files.repeatsLeft', { files: r.repeats.slice(0, 10).join(', ') + (r.skipped > 10 ? '…' : '') })) + '</p>' : '') +
      (r.foldersKept && r.foldersKept.length ? '<p class="small">' + esc(t('files.foldersKept', { folders: r.foldersKept.join(', ') })) + '</p>' : '') +
      (r.failedCount > failed.length ? '<p class="small">' + esc(t('ren.failedMore', { count: r.failedCount })) + '</p>' : '') +
      (failed.length ? '<ul class="msrc-examples">' + failed.slice(0, 20).map(function (f) { return '<li><code>' + esc(f.from) + '</code> — ' + esc(RENAME_ERRORS[f.error] ? t(RENAME_ERRORS[f.error]) : f.error) + '</li>'; }).join('') + '</ul>' : '') +
    '</div></div>';
  }
  var renamePage = {
    title: function () { return t('nav.files'); },
    render: function (route) {
      if (route && route.param === 'merge') return mergeRender();
      var st = renameState();
      var libs = A().state.libraries || [];
      var head = filesTabs('rename') +
        '<p class="page-lead">' + esc(t('ren.intro')) + '</p>' +
        '<details class="card card--wide msrc-how"><summary class="card__title">' + esc(t('ren.rulesTitle')) + '</summary>' +
          // Examples worked out by the server with the current rules ("—" = left as it is)
          (st.rules ? '<pre class="msrc-pre">' + esc(st.rules.map(function (x) {
            var pad = Math.max.apply(null, st.rules.map(function (y) { return y.from.length; }));
            return x.from + new Array(pad - x.from.length + 2).join(' ') + '→ ' + (x.to || t('ren.unchanged'));
          }).join('\n')) + '</pre>' : '') +
          '<p class="small muted">' + esc(t('ren.rulesHelp')) + '</p></details>' +
        renameJobHtml(st.job) +
        '<div class="toolbar">' +
          '<div class="toolbar__group">' +
            '<select class="select select--compact" id="ren-library" aria-label="' + esc(t('ren.library')) + '">' +
              '<option value="all"' + (st.library === 'all' ? ' selected' : '') + '>' + esc(t('nav.allLibraries')) + '</option>' +
              libs.map(function (l) { return '<option value="' + l.id + '"' + (st.library === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') +
            '</select>' +
            '<button class="btn btn--primary btn--pill" data-lib="ren-check"' + (st.loading ? ' disabled' : '') + '>' + icon('search') + esc(t('ren.check')) + '</button>' +
          '</div>' +
        '</div>';
      if (st.error) return head + errorBanner(st.error);
      if (st.loading) return head + spinner;
      var res = fileJobResult(st.result);
      if (!st.data) return head + res + emptyState('edit', '', t('ren.start'));
      var items = st.data.items;
      var okTotal = st.data.ok != null ? st.data.ok : items.filter(function (x) { return x.status === 'ok'; }).length;
      var nSel = renameSelectedCount(st);
      var summary = '<p class="muted small">' + esc(t('ren.summary', { checked: st.data.checked, count: okTotal, conflicts: st.data.conflicts != null ? st.data.conflicts : items.length - okTotal })) + '</p>' +
        (st.data.truncated ? '<p class="notice notice--info small">' + esc(t('ren.truncated', { shown: items.length, total: st.data.total })) + '</p>' : '') +
        (st.data.guesses ? '<p class="notice notice--info small">' + esc(t('ren.guessSummary', { count: st.data.guesses })) + '</p>' : '') +
        // The list of files was behind the disk (files already renamed there): not proposed, being re-checked
        (st.data.stale && st.data.stale.count ? '<p class="notice notice--info small">' + esc(t('ren.stale', { count: st.data.stale.count })) + '</p>' : '') +
        // Files whose new name is already taken by another file: delete one of the two (all at once or per file)
        (st.data.exists ? '<div class="notice notice--info files-exists"><span>' + esc(t('files.existsSummary', { count: st.data.exists })) + '</span>' +
          '<span class="files-exists__actions">' +
            '<button class="btn btn--outline btn--small" data-lib="files-del-all" data-keep="existing"' + (st.job ? ' disabled' : '') + '>' + icon('delete') + esc(t('files.deleteAllRenamed')) + '</button>' +
            '<button class="btn btn--outline btn--small" data-lib="files-del-all" data-keep="renamed"' + (st.job ? ' disabled' : '') + '>' + icon('delete') + esc(t('files.deleteAllExisting')) + '</button>' +
          '</span></div>' : '');
      if (!items.length) return head + res + summary + emptyState('check', t('ren.allGoodTitle'), t('ren.allGood'));
      // Grouped by work
      var groups = [], byWork = {};
      items.forEach(function (x) {
        var k = x.seriesId;
        if (!byWork[k]) { byWork[k] = { work: x.work, library: x.library, seriesId: x.seriesId, list: [] }; groups.push(byWork[k]); }
        byWork[k].list.push(x);
      });
      return head + res + summary +
        '<div class="ren-actions">' +
          '<label class="checkbox"><input type="checkbox" id="ren-all"' + (st.mode === 'all' && okTotal ? ' checked' : '') + ' /><span>' + esc(t('ren.selectAll')) + '</span></label>' +
          '<label class="checkbox"><input type="checkbox" id="ren-json"' + (st.renameJson ? ' checked' : '') + ' /><span>' + esc(t('ren.json')) + '</span></label>' +
          '<button class="btn btn--primary" data-lib="ren-apply"' + (nSel && !st.job ? '' : ' disabled') + '>' + icon('edit') + esc(t('ren.apply', { count: nSel })) + '</button>' +
        '</div>' +
        groups.map(function (g) {
          return '<section class="ren-group"><h3 class="ren-group__title"><a href="#series/' + g.seriesId + '">' + esc(g.work) + '</a> <span class="muted small">' + esc(g.library) + '</span></h3>' +
            '<ul class="ren-list">' + g.list.map(function (x) {
              var guess = x.status === 'guess';
              var bad = x.status !== 'ok' && !guess;
              var checked = guess ? Boolean(st.guessPicked[x.bookId]) : isRenameSelected(st, x.bookId);
              return '<li class="ren-row' + (bad ? ' is-conflict' : '') + (guess ? ' is-guess' : '') + '"><label class="checkbox"><input type="checkbox" ' + (guess ? 'data-ren-guess' : 'data-ren') + '="' + x.bookId + '"' + (bad ? ' disabled' : checked ? ' checked' : '') + ' aria-label="' + esc(x.fromName) + '" />' +
                '<span class="ren-row__names"><code class="ren-from">' + esc(x.fromName) + '</code><span class="ren-arrow" aria-hidden="true">→</span><code class="ren-to">' + esc(x.toName) + '</code></span></label>' +
                (bad ? '<span class="badge badge--danger" title="' + esc(x.with || '') + '">' + esc(t('ren.status.' + x.status)) + '</span>' : '') +
                // A number that probably lost its decimal point (505 in a work with chapters 1–70): only a suggestion
                (x.guess ? '<span class="badge badge--warn" title="' + esc(t('ren.guessHelp')) + '">' + esc(t('ren.guessBadge', { from: x.guess.from, to: x.guess.to })) + '</span>' +
                  '<p class="ren-guess muted small">' + esc(t('ren.guessWhy', { from: x.guess.from, first: x.guess.first, last: x.guess.last, to: x.guess.to })) + '</p>' : '') +
                // The new name is taken or wanted by other files: all of them, to choose which to keep
                (x.involved ? involvedTable(x, st) : '') + '</li>';
            }).join('') + '</ul></section>';
        }).join('');
    },
    mount: function (el, route) {
      if (route && route.param === 'merge') return mergeMount(el);
      var st = renameState();
      var lib = $('#ren-library', el);
      if (lib) lib.addEventListener('change', function () { st.library = lib.value; st.data = null; st.result = null; runRenamePreview(); });
      el.addEventListener('change', function (e) {
        var tg = e.target;
        if (tg.id === 'ren-json') { st.renameJson = tg.checked; return; }
        if (tg.id === 'ren-all') {
          st.mode = tg.checked ? 'all' : 'some'; st.selected = {}; st.excluded = {};
          return A().renderPage();
        }
        if (tg.dataset.renGuess) { if (tg.checked) st.guessPicked[tg.dataset.renGuess] = true; else delete st.guessPicked[tg.dataset.renGuess]; return A().renderPage(); }
        if (tg.dataset.ren) {
          var bid = tg.dataset.ren;
          if (st.mode === 'all') { if (tg.checked) delete st.excluded[bid]; else st.excluded[bid] = true; }
          else if (tg.checked) st.selected[bid] = true; else delete st.selected[bid];
          A().renderPage();
        }
      });
    },
    enter: function (route) {
      if (route && route.param === 'merge') return mergeEnter();
      var st = renameState();
      if (!st.rules) api('GET', '/api/rename/rules').then(function (r) { st.rules = r.examples; if (isFilesRoute()) A().renderPage(); }, function () {});
      // A job still running (or started on another visit): follow it
      if (!st.job) api('GET', '/api/rename/jobs').then(function (r) {
        var live = (r.jobs || []).filter(function (j) { return j.status === 'queued' || j.status === 'running'; }).pop();
        if (live && !st.job) { st.job = live; pollRenameJob(); }
      }, function () {});
      else pollRenameJob();
      if (!st.data && !st.loading) runRenamePreview();
    }
  };

  /* ---- File management → Merge works ----
   * Suggestions (works the metadata says are the same) and a manual merge: pick works, choose the one to keep;
   * the others' files move into its folder (a job in the same queue as renaming). */
  function mergeState() {
    if (!cache.merge) cache.merge = { library: 'all', data: null, loading: false, error: null, choice: {}, job: null, result: null, q: '', found: null, manual: [], manualTarget: null, deleteSources: {} };
    return cache.merge;
  }
  function loadMergeSuggestions() {
    var st = mergeState();
    st.loading = true; st.error = null;
    if (isFilesRoute()) A().renderPage();
    return api('GET', '/api/files/merge-suggestions?' + Store.qs({ library: st.library })).then(function (r) {
      st.data = r; st.choice = {};
      r.groups.forEach(function (g) { var inc = {}; g.works.forEach(function (w) { inc[w.id] = true; }); st.choice[g.key] = { target: g.target, include: inc }; });
    }, function (e) { st.error = e; }).then(function () { st.loading = false; if (isFilesRoute()) A().renderPage(); });
  }
  var mergePollTimer = null;
  function pollMergeJob() {
    clearTimeout(mergePollTimer);
    var st = mergeState();
    if (!st.job) return;
    api('GET', '/api/files/jobs/' + st.job.id).then(function (r) {
      st.job = r.job;
      if (r.job.status === 'done' || r.job.status === 'failed') {
        st.result = r.job; st.job = null; st.manual = []; st.manualTarget = null; st.found = null;
        invalidate(); markStale(cache.series); markStale(cache.book); A().refreshLibraries();
        if (isFilesRoute()) loadMergeSuggestions(); else st.data = null;
        return;
      }
      if (isFilesRoute()) A().renderPage();
      mergePollTimer = setTimeout(pollMergeJob, 700);
    }, function () { mergePollTimer = setTimeout(pollMergeJob, 2000); });
  }
  function mergeJobHtml(j) {
    if (!j) return '';
    var p = { percent: j.status === 'queued' ? null : j.progress, done: j.done, total: j.total, etaMs: null, elapsedMs: 0 };
    return '<div class="card card--wide ren-job" role="status">' + progressBar(p, t(j.status === 'queued' ? 'files.mergeQueued' : 'files.merging'), t('files.mergeProgress', { done: j.done, total: j.total || '…' })) + '</div>';
  }
  function reasonText(g) {
    var d = g.detail || {};
    if (g.reason === 'match') return t('files.reason.match', { site: providerName(d.provider || ''), id: d.id || '' });
    if (g.reason === 'link') return t('files.reason.link', { url: d.url || '' });
    return t('files.reason.title', { title: d.title || '' });
  }
  // One work in a merge list: keep it (radio) / include it (checkbox)
  function mergeRow(name, w, target, included) {
    var isTarget = w.id === target;
    return '<li class="merge-row' + (isTarget ? ' is-target' : '') + '">' +
      '<label class="merge-row__keep" title="' + esc(t('files.keepTitle')) + '"><input type="radio" name="' + esc(name) + '" value="' + w.id + '" data-merge-target="' + esc(name) + '"' + (isTarget ? ' checked' : '') + (w.oneshot ? ' disabled' : '') + ' /><span class="small">' + esc(t('files.keep')) + '</span></label>' +
      '<label class="checkbox"><input type="checkbox" data-merge-include="' + esc(name) + '" value="' + w.id + '"' + (included || isTarget ? ' checked' : '') + (isTarget ? ' disabled' : '') + ' />' +
        '<span class="merge-row__what"><a href="#series/' + w.id + '">' + esc(w.title) + '</a>' +
        ' <span class="muted small">' + esc([w.library, w.path, t(w.books === 1 ? 'lib.bookCount1' : 'lib.booksCount', { count: w.books })].filter(Boolean).join(' · ')) + '</span>' +
        (w.oneshot ? ' <span class="badge">' + esc(t('lib.oneshot')) + '</span>' : '') + '</span></label></li>';
  }
  // "Delete the other folders when done": per suggestion / for the manual merge
  function mergeDeleteBox(st, key) {
    return '<label class="checkbox merge-delete"><input type="checkbox" data-merge-delete="' + esc(key) + '"' + (st.deleteSources[key] ? ' checked' : '') + ' />' +
      '<span>' + esc(t('files.deleteSources')) + '</span></label>';
  }
  function mergeRender() {
    var st = mergeState();
    var libs = A().state.libraries || [];
    var head = filesTabs('merge') + '<p class="page-lead">' + esc(t('files.mergeIntro')) + '</p>' +
      mergeJobHtml(st.job) + fileJobResult(st.result);
    // Manual merge: find works, add them, choose the one to keep
    var manual = '<section class="card card--wide merge-manual"><h2 class="card__title">' + esc(t('files.manualTitle')) + '</h2>' +
      '<p class="muted small">' + esc(t('files.manualHelp')) + '</p>' +
      '<label class="search-field">' + icon('search') + '<input type="search" id="merge-find" placeholder="' + esc(t('files.findWorks')) + '" value="' + esc(st.q) + '" /></label>' +
      (st.found ? (st.found.length ? '<ul class="merge-found">' + st.found.map(function (w) {
        var added = st.manual.some(function (x) { return x.id === w.id; });
        return '<li><span>' + esc(w.title) + ' <span class="muted small">' + esc([w.library, w.path, t(w.books === 1 ? 'lib.bookCount1' : 'lib.booksCount', { count: w.books })].filter(Boolean).join(' · ')) + '</span></span>' +
          '<button class="btn btn--text btn--small" data-lib="merge-add" data-id="' + w.id + '"' + (added ? ' disabled' : '') + '>' + icon('add') + esc(t(added ? 'files.added' : 'files.add')) + '</button></li>';
      }).join('') + '</ul>' : '<p class="muted small">' + esc(t('lib.noMatch')) + '</p>') : '') +
      (st.manual.length ? '<ul class="merge-list">' + st.manual.map(function (w) { return mergeRow('manual', w, st.manualTarget, true); }).join('') + '</ul>' +
        '<div class="merge-actions">' + mergeDeleteBox(st, 'manual') + '<button class="btn btn--primary" data-lib="merge-go" data-key="manual"' + (st.manual.length < 2 || !st.manualTarget || st.job ? ' disabled' : '') + '>' + icon('collections') + esc(t('files.mergeN', { count: st.manual.length })) + '</button>' +
        '<button class="btn btn--text" data-lib="merge-clear">' + esc(t('filter.clear')) + '</button></div>' : '') +
      '</section>';
    var toolbar = '<div class="toolbar"><div class="toolbar__group">' +
      '<select class="select select--compact" id="merge-library" aria-label="' + esc(t('ren.library')) + '">' +
        '<option value="all"' + (st.library === 'all' ? ' selected' : '') + '>' + esc(t('nav.allLibraries')) + '</option>' +
        libs.map(function (l) { return '<option value="' + l.id + '"' + (st.library === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn btn--primary btn--pill" data-lib="merge-check"' + (st.loading ? ' disabled' : '') + '>' + icon('search') + esc(t('files.findDuplicates')) + '</button>' +
    '</div></div>';
    var body;
    if (st.error) body = errorBanner(st.error);
    else if (st.loading || !st.data) body = spinner;
    else if (!st.data.groups.length) body = emptyState('check', t('files.noSuggestionsTitle'), t('files.noSuggestions'));
    else body = '<h2 class="section-title">' + esc(t('files.suggestions', { count: st.data.total })) + '</h2>' + st.data.groups.map(function (g) {
      var ch = st.choice[g.key] || { target: g.target, include: {} };
      var n = g.works.filter(function (w) { return ch.include[w.id] || w.id === ch.target; }).length;
      return '<section class="card card--wide merge-group" data-key="' + esc(g.key) + '">' +
        '<p class="merge-group__why">' + icon('dataset') + '<span>' + esc(reasonText(g)) + '</span></p>' +
        '<ul class="merge-list">' + g.works.map(function (w) { return mergeRow(g.key, w, ch.target, ch.include[w.id]); }).join('') + '</ul>' +
        '<div class="merge-actions">' + mergeDeleteBox(st, g.key) +
          '<button class="btn btn--primary" data-lib="merge-go" data-key="' + esc(g.key) + '"' + (n < 2 || !ch.target || st.job ? ' disabled' : '') + '>' + icon('collections') + esc(t('files.mergeN', { count: n })) + '</button>' +
          '<button class="btn btn--text" data-lib="merge-dismiss" data-key="' + esc(g.key) + '">' + esc(t('files.notSame')) + '</button>' +
        '</div></section>';
    }).join('');
    return head + manual + toolbar + body;
  }
  var mergeFindTimer = null;
  function mergeMount(el) {
    var st = mergeState();
    var lib = $('#merge-library', el);
    if (lib) lib.addEventListener('change', function () { st.library = lib.value; loadMergeSuggestions(); });
    var find = $('#merge-find', el);
    if (find) find.addEventListener('input', function () {
      st.q = find.value;
      clearTimeout(mergeFindTimer);
      mergeFindTimer = setTimeout(function () {
        if (!st.q.trim()) { st.found = null; return A().renderPage(); }
        api('GET', '/api/files/works?' + Store.qs({ q: st.q })).then(function (r) {
          st.found = r.works;
          A().renderPage();
          var again = $('#merge-find'); if (again) { again.focus(); var v = again.value; again.value = ''; again.value = v; }
        }, function () {});
      }, 300);
    });
    el.addEventListener('change', function (e) {
      var tg = e.target, key;
      if ((key = tg.dataset.mergeTarget)) {
        if (key === 'manual') st.manualTarget = tg.value;
        else { st.choice[key].target = tg.value; st.choice[key].include[tg.value] = true; }
        return A().renderPage();
      }
      if ((key = tg.dataset.mergeDelete)) { st.deleteSources[key] = tg.checked; return; }
      if ((key = tg.dataset.mergeInclude)) {
        if (key === 'manual') { if (!tg.checked) st.manual = st.manual.filter(function (w) { return w.id !== tg.value; }); }
        else st.choice[key].include[tg.value] = tg.checked;
        return A().renderPage();
      }
    });
  }
  function mergeEnter() {
    var st = mergeState();
    if (!st.data && !st.loading) loadMergeSuggestions();
    if (st.job) pollMergeJob();
  }
  function startMerge(key) {
    var st = mergeState();
    var target, sources, works;
    if (key === 'manual') { works = st.manual; target = st.manualTarget; sources = works.map(function (w) { return w.id; }); }
    else {
      var g = st.data.groups.filter(function (x) { return x.key === key; })[0];
      var ch = st.choice[key];
      works = g.works; target = ch.target;
      sources = g.works.filter(function (w) { return ch.include[w.id]; }).map(function (w) { return w.id; });
    }
    sources = sources.filter(function (id) { return id !== target; });
    var tw = works.filter(function (w) { return w.id === target; })[0];
    if (!tw || !sources.length) return;
    var del = Boolean(st.deleteSources[key]);
    if (!confirm(t(del ? 'files.mergeConfirmDelete' : 'files.mergeConfirm', { count: sources.length, title: tw.title, path: tw.path }))) return;
    return api('POST', '/api/files/merge', { target: target, sources: sources, deleteSources: del }).then(function (r) {
      st.job = r.job; st.result = null;
      A().toast(t('files.mergeStarted'));
      A().renderPage();
      pollMergeJob();
    }, fail);
  }

  /* ================= EXTERNAL CATALOG ================= */
  // #catalog: every work found on the external sources (merged ones once), marked when the library has it;
  // #catalog/work?key=: one work with each source's chapter list; #catalog/merge (admins): merge suggestions;
  // #catalog/sources (admins): the sites crawled, their settings and crawls.
  function isCatalogRoute() { return A().parseRoute().name === 'catalog'; }
  function catalogTabs(active) {
    var tab = function (id, href, ic, key) {
      return '<a class="tab' + (active === id ? ' is-active' : '') + '" href="' + href + '"' + (active === id ? ' aria-current="page"' : '') + '>' + icon(ic) + esc(t(key)) + '</a>';
    };
    return '<h1 class="page-title">' + esc(t('nav.catalog')) + '</h1>' +
      '<nav class="tabs files-tabs" aria-label="' + esc(t('nav.catalog')) + '">' +
        tab('browse', '#catalog', 'travel_explore', 'cat.tabBrowse') +
        tab('merge', '#catalog/merge', 'collections', 'cat.tabMerge') + tab('sources', '#catalog/sources', 'dataset', 'cat.tabSources') +
        tab('files', '#catalog/files', 'description', 'cat.tabFiles') +
      '</nav>';
  }
  function catState() {
    if (!cache.catalog) cache.catalog = { q: '', source: '', inLibrary: '', genre: '', sort: 'title', items: null, total: 0, error: null, loading: false, facets: null, seq: 0 };
    return cache.catalog;
  }
  var catCover = function (key) { return '/api/catalog/cover?key=' + encodeURIComponent(key); };
  // A source's own icon (its site's), with the generic one underneath in case the site has none
  function sourceIconHtml(id, cls) {
    return '<span class="' + (cls || '') + ' src-icon">' + icon('travel_explore') + '<img alt="" loading="lazy" src="/api/catalog/sources/' + encodeURIComponent(id) + '/icon" onerror="this.remove()" /></span>';
  }
  function catalogCard(it) {
    return '<article class="media-card cat-card">' +
      '<a class="media-card__link" href="#catalog/work?key=' + encodeURIComponent(it.key) + '">' +
        '<div class="cover">' + (it.cover ? '<img class="cover__img" loading="lazy" decoding="async" alt="" src="' + catCover(it.coverKey) + '" />' : '') + placeholder('cbz') +
          (it.inLibrary ? '<span class="cat-card__have" title="' + esc(t('cat.inLibraryAs', { title: it.inLibrary.title })) + '">' + icon('check') + esc(t('cat.inLibrary')) + '</span>' : '') + '</div>' +
        '<div class="media-card__body"><h3 class="media-card__title">' + esc(it.title) + '</h3>' +
          '<p class="media-card__meta cat-card__meta">' + it.sources.map(function (s) { return sourceIconHtml(s.sourceId, 'src-icon--xs'); }).join('') + '<span>' + esc([it.sources.map(function (s) { return s.name; }).join(', '), it.chapters ? t('cat.chapters', { count: it.chapters }) : '',
            it.versions && it.versions.length > 1 ? t('lib.versions', { count: it.versions.length }) : ''].filter(Boolean).join(' · ')) + '</span></p></div>' +
      '</a></article>';
  }
  function fetchCatalog(append) {
    var st = catState();
    var seq = ++st.seq;
    st.loading = true;
    var grid = $('#cat-grid');
    if (grid && !append) { grid.classList.add('is-loading'); }
    return api('GET', '/api/catalog?' + Store.qs({ q: st.q, source: st.source, inLibrary: st.inLibrary, genre: st.genre, sort: st.sort, offset: append ? st.items.length : 0, limit: 60 })).then(function (r) {
      if (seq !== st.seq) return;
      st.items = append ? st.items.concat(r.items) : r.items; st.total = r.total; st.error = null;
    }, function (e) { if (seq === st.seq) st.error = e; }).then(function () { if (seq === st.seq) { st.loading = false; renderCatalogGrid(); } });
  }
  function renderCatalogGrid() {
    var el = $('#cat-grid');
    if (!el) return;
    var st = catState();
    var html;
    if (st.error) html = errorBanner(st.error);
    else if (!st.items) html = spinner;
    else if (!st.items.length) html = emptyState('travel_explore', st.facets && !st.facets.sources.length ? t('cat.noSourcesTitle') : '', st.facets && !st.facets.sources.length ? t(isAdmin() ? 'cat.noSourcesAdmin' : 'cat.noSources') : t('lib.noMatch'));
    else html = '<p class="muted small grid-count">' + esc(t('cat.count', { count: st.total })) + '</p>' + grid(st.items.map(catalogCard)) +
      (st.items.length < st.total ? '<div class="load-more"><button class="btn btn--outline btn--pill" data-lib="cat-more"' + (st.loading ? ' disabled' : '') + '>' + esc(t('lib.loadMore')) + '</button></div>' : '');
    el.innerHTML = html;
    el.classList.toggle('is-loading', false);
    renderIcons(el);
    A().restoreScroll();
  }
  function catalogBrowse() {
    var st = catState(), fc = st.facets;
    var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; };
    return catalogTabs('browse') +
      '<p class="page-lead">' + esc(t('cat.intro')) + (fc ? ' ' + esc(t('cat.summary', { total: fc.total, have: fc.inLibrary })) : '') + '</p>' +
      '<div class="toolbar">' +
        '<label class="search-field">' + icon('search') + '<input type="search" id="cat-q" placeholder="' + esc(t('cat.searchPlaceholder')) + '" value="' + esc(st.q) + '" /></label>' +
        '<div class="toolbar__group">' +
          '<select class="select select--compact" id="cat-source" aria-label="' + esc(t('cat.source')) + '">' + opt('', t('cat.allSources'), st.source) +
            ((fc && fc.sources) || []).map(function (s) { return opt(s.id, s.name + ' (' + s.works + ')', st.source); }).join('') + '</select>' +
          '<select class="select select--compact" id="cat-have" aria-label="' + esc(t('cat.inLibrary')) + '">' + opt('', t('cat.haveAll'), st.inLibrary) + opt('yes', t('cat.haveYes'), st.inLibrary) + opt('no', t('cat.haveNo'), st.inLibrary) + '</select>' +
          '<select class="select select--compact" id="cat-genre" aria-label="' + esc(t('filter.genre')) + '">' + opt('', t('cat.allGenres'), st.genre) +
            ((fc && fc.genres) || []).map(function (g) { return opt(g.name, g.name + ' (' + g.count + ')', st.genre); }).join('') + '</select>' +
          '<select class="select select--compact" id="cat-sort" aria-label="' + esc(t('lib.sort')) + '">' + opt('title', t('lib.sortTitle'), st.sort) + opt('updated', t('cat.sortUpdated'), st.sort) + opt('chapters', t('cat.sortChapters'), st.sort) + '</select>' +
        '</div>' +
      '</div>' +
      '<div id="cat-grid"></div>';
  }
  var catTimer = null;
  function catalogBrowseMount(el) {
    var st = catState();
    renderCatalogGrid();
    $('#cat-q', el).addEventListener('input', function (e) { st.q = e.target.value; clearTimeout(catTimer); catTimer = setTimeout(function () { fetchCatalog(); }, 250); });
    [['#cat-source', 'source'], ['#cat-have', 'inLibrary'], ['#cat-genre', 'genre'], ['#cat-sort', 'sort']].forEach(function (x) {
      $(x[0], el).addEventListener('change', function (e) { st[x[1]] = e.target.value; fetchCatalog(); });
    });
  }

  // One work: every source with its chapter list; what the library has
  // A chapter that can't be read for free right now (premium, locked behind coins or a pass)
  function premiumBadge(c) { return c.pr ? ' <span class="badge badge--premium" title="' + esc(t('cat.premiumHelp')) + '">' + icon('lock') + esc(t('cat.premium')) + '</span>' : ''; }
  function catWorkState(key) { cache.catWork = cache.catWork || {}; return cache.catWork[key]; }
  function catalogWork(route) {
    var key = route.query.get('key') || '';
    var d = catWorkState(key);
    var back = backLink('#catalog', t('nav.catalog'));
    if (!d) return back + spinner;
    if (d.error) return back + errorBanner(d.error);
    var w = d.work;
    var miss = w.missing;
    var lib = w.inLibrary ? '<div class="banner banner--ok cat-have"><div><strong>' + esc(t('cat.inLibraryAs', { title: w.inLibrary.title })) + '</strong>' +
        (miss ? '<p class="small">' + esc(miss.chapters.length ? t('cat.missingCount', { count: miss.chapters.length, have: miss.have }) : t('cat.missingNone', { have: miss.have })) + '</p>' : '') + '</div>' +
        '<a class="btn btn--primary" href="#series/' + w.inLibrary.seriesId + '">' + esc(t('cat.openInLibrary')) + '</a></div>' : '';
    var missingList = miss && miss.chapters.length ? '<details class="card card--wide cat-missing"><summary class="card__title">' + esc(t('cat.missingTitle', { count: miss.chapters.length })) + '</summary><ul class="cat-chapters">' +
        miss.chapters.slice(0, 500).map(function (c) { return '<li' + (c.pr ? ' class="is-premium"' : '') + '><span class="cat-ch__n">' + esc(c.n) + '</span><span class="cat-ch__t">' + esc(c.t || '') + premiumBadge(c) + '</span><span class="muted small">' + esc(c.source) + '</span>' +
          (c.u ? '<a class="small" href="' + esc(c.u) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') + '</a>' : '') + '</li>'; }).join('') + '</ul></details>' : '';
    // A version's name: its tags (Raw + Uncensored…), or Regular
    var versionLabel = function (v) { return (v.editions && v.editions.length ? v.editions : ['base']).map(function (e) { return editionTag(e, true); }).join(' '); };
    var versionTabs = w.versions && w.versions.length > 1 ? '<nav class="tabs version-tabs" aria-label="' + esc(t('series.versions')) + '">' + w.versions.map(function (v) {
        var on = v.key === w.key;
        return '<a class="tab' + (on ? ' is-active' : '') + '" href="#catalog/work?key=' + encodeURIComponent(v.key) + '"' + (on ? ' aria-current="page"' : '') + '>' + versionLabel(v) + '<span class="tab__count">' + v.chapters + '</span></a>';
      }).join('') + '</nav>' : '';
    // Chapters: every chapter of every source in one list (each with its sources' links), or one source's
    var tab = d.tab && (d.tab === 'all' || w.sources.some(function (s) { return s.key === d.tab; })) ? d.tab : 'all';
    var chapterTabs = '<nav class="tabs cat-ch-tabs" role="tablist" aria-label="' + esc(t('cat.chaptersTabs')) + '">' +
      '<button type="button" role="tab" class="tab' + (tab === 'all' ? ' is-active' : '') + '" aria-selected="' + (tab === 'all') + '" data-lib="cat-ch-tab" data-id="all" data-work="' + esc(key) + '">' + icon('list') + esc(t('cat.allChapters')) + '<span class="tab__count">' + (w.allChapters || []).length + '</span></button>' +
      w.sources.map(function (s) {
        return '<button type="button" role="tab" class="tab' + (tab === s.key ? ' is-active' : '') + '" aria-selected="' + (tab === s.key) + '" data-lib="cat-ch-tab" data-id="' + esc(s.key) + '" data-work="' + esc(key) + '">' + sourceIconHtml(s.sourceId, 'src-icon--xs') + esc(s.name) + '<span class="tab__count">' + s.chapterList.length + '</span></button>';
      }).join('') + '</nav>';
    var unified = function () {
      var list = w.allChapters || [], all = d.showAll && d.showAll.all, rows = all ? list : list.slice(0, 100);
      return '<section class="card card--wide cat-source">' +
        '<p class="muted small">' + esc(t('cat.allChaptersHelp', { count: list.length, sources: w.sources.length })) + '</p>' +
        (rows.length ? '<ul class="cat-chapters cat-chapters--all">' + rows.map(function (c) {
          return '<li' + (c.pr ? ' class="is-premium"' : '') + '><span class="cat-ch__n">' + esc(c.n != null ? c.n : '—') + '</span><span class="cat-ch__t">' + esc(c.t || '') + premiumBadge(c) + '</span>' +
            '<span class="cat-ch__links">' + c.links.map(function (l) {
              return l.u ? '<a class="chip chip--link cat-ch__src' + (l.pr ? ' is-premium' : '') + '" href="' + esc(l.u) + '" target="_blank" rel="noopener noreferrer" title="' + esc(t('cat.readOn', { source: l.name }) + (l.pr ? ' — ' + t('cat.premium') : '')) + '">' + sourceIconHtml(l.sourceId, 'src-icon--xs') + esc(l.name) + (l.pr ? icon('lock') : '') + '</a>'
                : '<span class="chip">' + esc(l.name) + '</span>';
            }).join('') + '</span>' + (c.d ? '<span class="muted small">' + esc(c.d) + '</span>' : '') + '</li>';
          }).join('') + '</ul>' : '<p class="muted">' + esc(t('cat.noChapters')) + '</p>') +
        (!all && list.length > 100 ? '<button class="btn btn--text btn--small" data-lib="cat-all-chapters" data-key="all" data-work="' + esc(key) + '">' + esc(t('cat.showAll', { count: list.length })) + '</button>' : '') +
      '</section>';
    };
    var sources = tab === 'all' ? unified() : w.sources.filter(function (s) { return s.key === tab; }).map(function (s, i) {
      var all = d.showAll && d.showAll[s.key];
      var rows = all ? s.chapterList : s.chapterList.slice(0, 50);
      return '<section class="card card--wide cat-source">' +
        '<div class="cat-source__head"><h2 class="card__title cat-source__title">' + sourceIconHtml(s.sourceId, 'src-icon--sm') + esc(s.name) + '</h2>' +
          (s.url ? '<a class="btn btn--text btn--small" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') + esc(t('cat.openOnSite')) + '</a>' : '') +
          // A merged work: this source's entry can be split off (it becomes its own work again)
          (isAdmin() && w.groupId && w.sources.length > 1 ? '<button class="btn btn--text btn--small" data-lib="cat-split" data-id="' + esc(w.groupId) + '" data-key="' + esc(s.key) + '" title="' + esc(t('cat.splitHelp')) + '">' + esc(t('cat.split')) + '</button>' : '') + '</div>' +
        (s.title && s.title !== w.title ? '<p class="small"><strong>' + esc(s.title) + '</strong></p>' : '') +
        (s.error ? '<p class="notice notice--error small">' + esc(s.error) + '</p>' : '') +
        (s.partial ? '<p class="notice notice--info small">' + esc(t('cat.partial')) + '</p>' : '') +
        '<p class="muted small">' + esc(t('cat.chapters', { count: s.chapterList.length }) + (s.premium ? ' · ' + t('cat.premiumCount', { count: s.premium }) : '') + (s.detailAt ? ' · ' + t('cat.readAt', { time: A().fmtDate(s.detailAt) }) : '')) + '</p>' +
        (rows.length ? '<ul class="cat-chapters">' + rows.map(function (c) {
          return '<li' + (c.pr ? ' class="is-premium"' : '') + '><span class="cat-ch__n">' + esc(c.n != null ? c.n : '—') + '</span><span class="cat-ch__t">' + esc(c.t || '') + premiumBadge(c) + '</span><span class="muted small">' + esc([c.d, c.l].filter(Boolean).join(' · ')) + '</span>' +
            (c.u ? '<a class="small" href="' + esc(c.u) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(t('cat.openOnSite')) + '">' + icon('open_in_new') + '</a>' : '') + '</li>';
        }).join('') + '</ul>' : '') +
        (!all && s.chapterList.length > 50 ? '<button class="btn btn--text btn--small" data-lib="cat-all-chapters" data-key="' + esc(s.key) + '" data-work="' + esc(key) + '">' + esc(t('cat.showAll', { count: s.chapterList.length })) + '</button>' : '') +
      '</section>';
    }).join('');
    return back + lib +
      '<div class="detail">' +
        '<div class="detail__cover cover cover--large">' + (w.cover ? '<img class="cover__img" alt="" src="' + catCover(w.coverKey) + '" />' : '') + placeholder('cbz') + '</div>' +
        '<div class="detail__body">' +
          '<h1 class="detail__title">' + esc(w.title) + (w.editions && w.editions.length ? ' ' + w.editions.map(function (e) { return editionTag(e); }).join(' ') : '') + '</h1>' +
          '<div class="detail__meta">' + [w.type ? '<span class="badge badge--primary">' + esc(t('type.' + w.type)) + '</span>' : '', w.year ? esc(w.year) : '',
            w.status && w.status !== 'unknown' ? '<span class="badge">' + esc(t('series.status.' + w.status)) + '</span>' : '', esc(t('cat.chapters', { count: w.chapters })),
            w.lastChapter ? esc(t('cat.lastChapter', { n: w.lastChapter })) : ''].filter(Boolean).join('<span class="dot">·</span>') + '</div>' +
          (w.authors.length ? '<p class="detail__authors">' + esc(w.authors.join(', ')) + '</p>' : '') +
          (w.altTitles.length ? '<p class="muted small detail__alt">' + esc(w.altTitles.slice(0, 6).join(' · ')) + '</p>' : '') +
          (w.genres.length ? chips(w.genres.map(esc), 'chip--genre') : '') +
          (w.summary ? '<p class="detail__summary">' + esc(w.summary) + '</p>' : '') +
          '<p class="muted small">' + esc(t('cat.foundOn', { sources: w.sources.map(function (s) { return s.name; }).join(', ') })) + '</p>' +
          (isAdmin() && w.groupId ? '<button class="btn btn--text btn--danger" data-lib="cat-unmerge" data-id="' + esc(w.groupId) + '" data-work="' + esc(key) + '">' + esc(t('cat.unmerge')) + '</button>' : '') +
        '</div>' +
      '</div>' + missingList + versionTabs + chapterTabs + sources;
  }

  // Merge tab (admins): the same work on several sites. Suggestions to confirm, and the works merged already
  // (by hand or automatically, when it was certain) with a way to split them. Filter: one source's works.
  function catMergeState() {
    if (!cache.catMerge) cache.catMerge = { data: null, merged: null, sources: null, source: '', loading: false, error: null, choice: {} };
    return cache.catMerge;
  }
  function loadCatMerge() {
    var st = catMergeState();
    st.loading = true; st.error = null;
    if (isCatalogRoute()) A().renderPage();
    var qs = st.source ? '?source=' + encodeURIComponent(st.source) : '';
    return Promise.all([api('GET', '/api/catalog/merge-suggestions' + qs), api('GET', '/api/catalog/merged' + qs), st.sources ? Promise.resolve(null) : api('GET', '/api/catalog/facets')]).then(function (r) {
      st.data = r[0]; st.merged = r[1]; if (r[2]) st.sources = r[2].sources; st.choice = {};
      r[0].groups.forEach(function (g) { var inc = {}; g.works.forEach(function (w) { inc[w.key] = true; }); st.choice[g.key] = { primary: g.primary, include: inc }; });
    }, function (e) { st.error = e; }).then(function () { st.loading = false; if (isCatalogRoute()) A().renderPage(); });
  }
  // One work as compared: cover, title (link), source, chapters, other titles, authors
  function mergeWorkHtml(w) {
    var facts = [w.source, t('cat.chapters', { count: w.chapters })].concat(w.lastChapter ? [t('cat.lastChapter', { n: w.lastChapter })] : []).concat(w.type ? [w.type] : []).concat(w.year ? [String(w.year)] : []);
    return '<span class="merge-thumb">' + (w.cover ? '<img alt="" loading="lazy" src="' + esc(catCover(w.key)) + '" onerror="this.remove()" />' : '') + icon('menu_book') + '</span>' +
      '<span class="merge-row__what"><a href="#catalog/work?key=' + encodeURIComponent(w.key) + '">' + esc(w.title || '—') + '</a>' +
        (w.merged ? ' <span class="badge">' + esc(t('cat.alreadyMerged')) + '</span>' : '') +
        '<span class="muted small merge-row__facts">' + esc(facts.join(' · ')) + '</span>' +
        (w.authors && w.authors.length ? '<span class="muted small">' + esc(t('cat.by', { people: w.authors.join(', ') })) + '</span>' : '') +
        (w.altTitles && w.altTitles.length ? '<span class="muted small merge-row__alt">' + esc(w.altTitles.join(' · ')) + '</span>' : '') +
      '</span>';
  }
  var MERGE_WHY = { link: 'cat.reason.link', titleAuthor: 'cat.reason.titleAuthor', titleAlt: 'cat.reason.titleAlt' };
  function mergeWhyText(why) {
    var d = (why && why.detail) || {};
    return t(MERGE_WHY[why && why.reason] || 'files.reason.title', { title: d.title || '', author: d.author || '', alt: d.alt || '' });
  }
  function catalogMerge() {
    var st = catMergeState();
    var sources = st.sources || [];
    var head = catalogTabs('merge') + '<p class="page-lead">' + esc(t('cat.mergeIntro')) + '</p>' +
      '<div class="toolbar"><div class="toolbar__group">' +
        '<select class="select select--compact" data-lib-change="cat-merge-source" aria-label="' + esc(t('cat.filterSource')) + '">' +
          '<option value="">' + esc(t('cat.allSources')) + '</option>' +
          sources.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === st.source ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
        '</select>' +
        '<button class="btn btn--primary btn--pill" data-lib="cat-merge-check"' + (st.loading ? ' disabled' : '') + '>' + icon('search') + esc(t('files.findDuplicates')) + '</button>' +
        '<button class="btn btn--outline btn--pill" data-lib="cat-merge-auto"' + (st.loading ? ' disabled' : '') + ' title="' + esc(t('cat.autoMergeHelp')) + '">' + icon('collections') + esc(t('cat.autoMerge')) + '</button>' +
      '</div></div>';
    if (st.error) return head + errorBanner(st.error);
    if (st.loading || !st.data) return head + spinner;
    var suggestions = st.data.groups.length ? '<h2 class="section-title">' + esc(t('files.suggestions', { count: st.data.total })) + '</h2>' + st.data.groups.map(function (g) {
      var ch = st.choice[g.key];
      var n = g.works.filter(function (w) { return ch.include[w.key]; }).length;
      return '<section class="card card--wide merge-group">' +
        '<p class="merge-group__why">' + icon('dataset') + '<span>' + esc(mergeWhyText(g)) + '</span>' +
          (g.inLibrary ? ' <a class="badge badge--ok" href="#series/' + g.inLibrary.seriesId + '">' + esc(t('cat.inLibrary')) + '</a>' : '') + '</p>' +
        '<ul class="merge-list">' + g.works.map(function (w) {
          var main = w.key === ch.primary;
          return '<li class="merge-row' + (main ? ' is-target' : '') + '">' +
            '<label class="merge-row__keep" title="' + esc(t('cat.primaryTitle')) + '"><input type="radio" name="p-' + esc(g.key) + '" value="' + esc(w.key) + '" data-cat-primary="' + esc(g.key) + '"' + (main ? ' checked' : '') + ' /><span class="small">' + esc(t('cat.primary')) + '</span></label>' +
            '<label class="checkbox merge-row__pick"><input type="checkbox" data-cat-include="' + esc(g.key) + '" value="' + esc(w.key) + '"' + (ch.include[w.key] || main ? ' checked' : '') + (main ? ' disabled' : '') + ' />' + mergeWorkHtml(w) + '</label></li>';
        }).join('') + '</ul>' +
        '<div class="merge-actions"><button class="btn btn--primary" data-lib="cat-merge-go" data-key="' + esc(g.key) + '"' + (n < 2 ? ' disabled' : '') + '>' + icon('collections') + esc(t('cat.mergeN', { count: n })) + '</button>' +
          '<button class="btn btn--text" data-lib="cat-merge-dismiss" data-key="' + esc(g.key) + '">' + esc(t('files.notSame')) + '</button></div>' +
      '</section>';
    }).join('') : emptyState('check', t('files.noSuggestionsTitle'), t('cat.noSuggestions'));
    var merged = st.merged && st.merged.groups.length ? '<h2 class="section-title">' + esc(t('cat.mergedTitle', { count: st.merged.total })) + '</h2>' + st.merged.groups.map(function (g) {
      return '<section class="card card--wide merge-group">' +
        '<p class="merge-group__why">' + icon('collections') + '<span>' + esc(g.auto ? t('cat.mergedAuto', { why: mergeWhyText(g.auto) }) : t('cat.mergedByHand')) + '</span></p>' +
        '<ul class="merge-list">' + g.works.map(function (w) {
          return '<li class="merge-row' + (w.key === g.primary ? ' is-target' : '') + '"><span class="merge-row__pick">' + mergeWorkHtml(w) + '</span>' +
            '<button class="btn btn--text btn--small" data-lib="cat-split" data-id="' + esc(g.id) + '" data-key="' + esc(w.key) + '" title="' + esc(t('cat.splitHelp')) + '">' + esc(t('cat.split')) + '</button></li>';
        }).join('') + '</ul>' +
        '<div class="merge-actions"><button class="btn btn--text btn--danger" data-lib="cat-unmerge-group" data-id="' + esc(g.id) + '">' + esc(t('cat.unmerge')) + '</button></div>' +
      '</section>';
    }).join('') : '';
    return head + suggestions + merged;
  }

  // Sources (admins): add/edit/delete, crawl, follow the crawl, test the settings
  function catSourcesState() {
    if (!cache.catSources) cache.catSources = { data: null, types: null, error: null, tests: {} };
    return cache.catSources;
  }
  var catPollTimer = null;
  function loadCatSources() {
    var st = catSourcesState();
    clearTimeout(catPollTimer);
    return Promise.all([api('GET', '/api/catalog/sources'), st.types ? Promise.resolve({ types: st.types }) : api('GET', '/api/catalog/types')]).then(function (r) {
      st.data = r[0]; st.types = r[1].types; st.error = null;
    }, function (e) { st.error = e; }).then(function () {
      if (A().parseRoute().name === 'catalog' && A().parseRoute().param === 'sources') {
        A().renderPage();
        if (st.data && st.data.sources.some(function (s) { return s.job; })) catPollTimer = setTimeout(loadCatSources, 1500);
      }
    });
  }
  function crawlLine(s) {
    var j = s.job;
    if (!j) return '';
    var p = j.progress || {};
    var listing = !p.phase || p.phase === 'listing';
    // (the time left comes from the crawl: the speed of the works read so far)
    var bar = { percent: listing || !p.total ? null : Math.min(100, Math.floor((p.done || 0) / p.total * 100)), etaMs: listing ? null : p.etaMs != null ? p.etaMs : null, elapsedMs: j.startedAt ? Date.now() - Date.parse(j.startedAt) : 0 };
    return progressBar(bar, t(j.status === 'queued' ? 'cat.crawlQueued' : listing ? 'cat.crawlListing' : 'cat.crawlReading'),
      listing ? t('cat.crawlListed', { count: p.listed || 0 }) : t('cat.crawlProgress', { done: p.done || 0, total: p.total || 0, errors: p.errors || 0 })) + requestsLine(p.requestsNow);
  }
  // How a crawl is fetching right now: works at once, requests in progress and waiting, the pause per site
  function requestsLine(r) {
    if (!r) return '';
    var gap = function (ms) { return ((ms || 0) / 1000).toFixed(1).replace(/\.0$/, ''); };
    return '<p class="muted small crawl-requests">' + esc(t('cat.crawlRequests', { lanes: r.lanes || 1, active: r.active || 0, waiting: r.waiting || 0, parallel: r.parallel || 1, gap: gap(r.gapMs) }) +
      (r.crawlDelay != null ? ' · ' + t('cat.crawlDelay', { s: r.crawlDelay }) : '')) + '</p>';
  }
  function testReport(r) {
    if (!r) return '';
    if (r.loading) return '<p class="muted small"><span class="spinner spinner--sm"></span> ' + esc(t('cat.testing')) + '</p>';
    if (r.error) return '<p class="notice notice--error small">' + esc(A().errMsg(r.error)) + '</p>';
    var x = r.test, w = x.work;
    return '<div class="msrc-report">' +
      (x.errors.length ? '<p class="notice notice--error small">' + esc(x.errors.join(' · ')) + '</p>' : '') +
      '<p class="small"><strong>' + esc(t('cat.testList', { count: x.firstPageCount })) + '</strong> ' + esc(x.works.map(function (s) { return s.title || s.sid; }).join(' · ')) + '</p>' +
      (w ? '<p class="small">' + esc(t('cat.testWork', { title: w.title || '—', chapters: w.chapterCount == null ? '—' : w.chapterCount, genres: (w.genres || []).join(', ') || '—', authors: (w.authors || []).join(', ') || '—' })) + '</p>' +
        (w.firstChapters && w.firstChapters.length ? '<p class="muted small">' + esc(w.firstChapters.map(function (c) { return (c.n || '?') + ' ' + (c.t || ''); }).join(' · ')) + '</p>' : '') : '') +
      '<p class="muted small">' + esc(t('cat.testRequests', { count: x.requests })) + '</p></div>';
  }
  function catalogSources() {
    var st = catSourcesState();
    var head = catalogTabs('sources') + '<p class="page-lead">' + esc(t('cat.sourcesIntro')) + '</p>' +
      '<div class="toolbar"><div class="toolbar__group"><button class="btn btn--primary btn--pill" data-lib="cat-src-add">' + icon('add') + esc(t('cat.addSource')) + '</button></div></div>';
    if (st.error) return head + errorBanner(st.error);
    if (!st.data) return head + spinner;
    if (!st.data.sources.length) return head + emptyState('travel_explore', t('cat.noSourcesTitle'), t('cat.noSourcesAdmin'));
    return head + '<div class="lib-list">' + st.data.sources.map(function (s) {
      var stats = s.lastStats;
      return '<section class="card lib-card cat-src">' +
        '<div class="lib-card__head">' + sourceIconHtml(s.id, 'lib-card__icon') + '<div class="lib-card__titles">' +
          '<h2 class="card__title">' + esc(s.name) + '</h2><p class="muted small">' + esc(s.label + ' · ' + s.baseUrl) + '</p></div></div>' +
        '<p class="small">' + esc(t('cat.srcWorks', { count: s.works })) + (s.lastCrawlAt ? ' · ' + esc(t('cat.srcLast', { time: A().fmtDate(s.lastCompleteAt || s.lastCrawlAt) })) : ' · ' + esc(t('cat.srcNever'))) +
          ' · ' + esc(t('cat.schedule.' + (s.schedule || 'manual'))) + '</p>' +
        (stats ? '<p class="muted small">' + esc(t('cat.srcStats', { listed: stats.listed, added: stats.added, read: stats.read, errors: stats.errors, chapters: stats.chapters })) + (stats.partial ? ' · ' + esc(t('cat.srcPartial', { count: stats.partial })) : '') + '</p>' : '') +
        // What detection found (automatic sources: at creation, then at every crawl)
        (s.autoDetect === true && s.detected ? '<p class="muted small cat-detected">' + icon('search') + '<span>' + esc(t('cat.detectedAt', { time: A().fmtDate(s.detected.at) }) + ' ' + detectSummary({ notes: s.detected.notes, found: s.detected.found || {}, blocked: s.detected.blocked, settings: s })) + '</span></p>' : '') +
        (s.autoDetect !== true ? '<p class="muted small">' + esc(t('cat.manualSettings')) + '</p>' : '') +
        (s.lastError ? '<p class="notice notice--error small">' + esc(s.lastError) + '</p>' : '') +
        (s.interrupted ? '<p class="notice notice--info small">' + esc(t('cat.interrupted')) + '</p>' : '') +
        crawlLine(s) +
        '<div class="lib-card__actions">' +
          (s.job ? '<button class="btn btn--outline btn--small" data-lib="cat-src-stop" data-id="' + s.id + '">' + icon('stop') + esc(t('proc.stop')) + '</button>'
            : '<button class="btn btn--primary btn--small" data-lib="cat-src-crawl" data-id="' + s.id + '" data-mode="' + (s.lastCrawlAt ? 'update' : 'full') + '">' + icon('sync') + esc(t(s.lastCrawlAt ? 'cat.update' : (s.interrupted ? 'cat.resume' : 'cat.crawl'))) + '</button>' +
              (s.lastCrawlAt ? '<button class="btn btn--text btn--small" data-lib="cat-src-crawl" data-id="' + s.id + '" data-mode="full">' + esc(t('cat.fullCrawl')) + '</button>' : '')) +
          '<button class="btn btn--text btn--small" data-lib="cat-src-test" data-id="' + s.id + '">' + icon('search') + esc(t('cat.test')) + '</button>' +
          '<button class="btn btn--text btn--small" data-lib="cat-src-edit" data-id="' + s.id + '">' + icon('edit') + esc(t('cat.edit')) + '</button>' +
          '<button class="btn btn--text btn--small btn--danger" data-lib="cat-src-delete" data-id="' + s.id + '">' + icon('delete') + esc(t('manage.delete')) + '</button>' +
        '</div>' + testReport(st.tests[s.id]) +
      '</section>';
    }).join('') + '</div>';
  }
  /* ---------------- Source wizard (Add / Edit a source) ----------------
   * Step by step, everything a source needs: the site (and what Detect finds there), the kind of site, how its
   * works are listed, what a work page holds, its chapters, how to crawl it, then a Test before saving. Steps that
   * don't apply are skipped (a source set up automatically needs only the first and the last ones; a site with a
   * known theme doesn't need selectors). Selectors can be typed or picked: the preview shows one of the site's
   * pages (fetched by the server, inert: no scripts, nothing loaded from the site by the browser), where hovering
   * shows an element and clicking it picks it — like the browser's "select an element" tool — or, in Navigate
   * mode, follows a link. */
  var WZ_SEL = {
    item: { page: 'list', kind: 'repeat' }, link: { page: 'list', kind: 'rel', rel: 'item', attr: 'href' }, title: { page: 'list', kind: 'rel', rel: 'item' }, cover: { page: 'list', kind: 'rel', rel: 'item', attr: 'src' },
    workTitle: { page: 'work', kind: 'single' }, workCover: { page: 'work', kind: 'single', attr: 'src' }, summary: { page: 'work', kind: 'single' }, genres: { page: 'work', kind: 'multi' },
    authors: { page: 'work', kind: 'multi' }, altTitles: { page: 'work', kind: 'single' }, status: { page: 'work', kind: 'single' },
    chapter: { page: 'work', kind: 'repeat' }, chapterLink: { page: 'work', kind: 'rel', rel: 'chapter', attr: 'href' }, chapterTitle: { page: 'work', kind: 'rel', rel: 'chapter' }, chapterDate: { page: 'work', kind: 'rel', rel: 'chapter' }
  };
  var wz = null;
  var wzCopyAct = function (a) { return { kind: a.kind === 'scroll' ? 'scroll' : 'click', selector: a.selector || '', mode: a.mode === 'open' ? 'open' : 'add', loads: (a.loads || []).slice(0, 2) }; };
  // A setting being picked: a selector ('item'…) or a click ('act:work:0')
  var WZ_CLICK = { kind: 'click' };
  var WZ_SCROLLBOX = { kind: 'scrollbox' };
  var wzSpec = function (key) {
    var m = /^act:(list|work|chapters):(\d)$/.exec(key || '');
    if (!m) return WZ_SEL[key] || null;
    var a = wz.draft.actions[m[1]][Number(m[2])];
    return a && a.kind === 'scroll' ? WZ_SCROLLBOX : WZ_CLICK;
  };
  var wzFieldLabel = function (key) { var m = /^act:(\w+):(\d)$/.exec(key || ''); return m ? t('wz.clickN', { n: Number(m[2]) + 1 }) : t('cat.sel.' + key); };
  // The clicks the preview makes for a step (the chapters' come after the work page's)
  var wzActionsFor = function (step) { var a = wz.draft.actions; return step === 'list' ? a.list : step === 'work' ? a.work : step === 'chapters' ? a.work.concat(a.chapters) : []; };
  function wzDraftFrom(s) {
    var d = Object.assign({ name: '', siteUrl: '', autoDetect: true, type: 'custom', baseUrl: '', languages: '', listPath: '', contentRating: 'safe,suggestive,erotica', listing: 'pages', sitemaps: '',
      workPattern: '', chapterPattern: '', includeChapters: true, maxWorks: '', gapMs: '', concurrency: '', schedule: 'manual' }, s || {});
    d.sitemaps = Array.isArray(d.sitemaps) ? d.sitemaps.join('\n') : d.sitemaps || '';
    d.selectors = Object.assign({}, (s && s.selectors) || {});
    // Clicks to make before collecting, per page: { list, work, chapters: [{ selector, mode }] }
    var acts = (s && s.actions) || {};
    d.actions = { list: (acts.list || []).map(wzCopyAct), work: (acts.work || []).map(wzCopyAct), chapters: (acts.chapters || []).map(wzCopyAct) };
    if (s) { d.siteUrl = s.siteUrl || s.baseUrl || ''; d.autoDetect = s.autoDetect === true; d.maxWorks = s.maxWorks || ''; d.gapMs = s.gapMs || ''; d.concurrency = s.concurrency || ''; }
    return d;
  }
  // The steps that apply to this draft
  function wzSteps() {
    var d = wz.draft, theme = d.type === 'madara' || d.type === 'mangareader';
    if (d.autoDetect) return ['site', 'crawl', 'review'];
    var list = ['site', 'kind'];
    if (d.type === 'custom' || theme) list.push('list');
    if (d.type === 'custom') { list.push('work'); if (d.includeChapters) list.push('chapters'); }
    return list.concat(['crawl', 'review']);
  }
  function openSourceWizard(src) {
    var st = catSourcesState();
    wz = { editing: src ? src.id : null, draft: wzDraftFrom(src), step: 'site', detected: src && src.detected ? { found: src.detected.found, notes: src.detected.notes, at: src.detected.at } : null,
      detecting: false, test: null, saving: false, error: null, pv: { url: '', page: null, loading: false, error: null, mode: 'pick', target: null, info: null, images: true, scripts: false, wait: 0 }, sampleWork: (src && src.detected && src.detected.found && src.detected.found.sampleWork && src.detected.found.sampleWork.url) || '', types: st.types || [] };
    var dlg = $('#src-wizard');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'src-wizard'; dlg.className = 'wizard';
      dlg.setAttribute('aria-labelledby', 'wz-title');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', wzClick);
      dlg.addEventListener('input', wzInput);
      dlg.addEventListener('change', wzInput);
      dlg.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'wz-pv-url') { e.preventDefault(); var u = e.target.value.trim(); if (u) wzLoadPreview(u); } });
      dlg.addEventListener('close', function () { wz = null; });
    }
    wzRender();
    if (!dlg.open) dlg.showModal();
  }
  function wzField(key, label, opts) {
    opts = opts || {};
    var d = wz.draft, sel = key.indexOf('sel.') === 0, k = sel ? key.slice(4) : key;
    var v = sel ? d.selectors[k] || '' : d[k];
    var id = 'wz-' + key.replace(/\./g, '-');
    var input;
    if (opts.type === 'select') input = '<select class="select" id="' + id + '" data-wz="' + key + '">' + opts.options.map(function (o) { return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>';
    else if (opts.type === 'checkbox') return '<label class="checkbox wz-check"><input type="checkbox" id="' + id + '" data-wz="' + key + '"' + (v ? ' checked' : '') + ' /><span>' + esc(label) + '</span></label>' + (opts.help ? '<small class="field__help">' + esc(opts.help) + '</small>' : '');
    else if (opts.type === 'textarea') input = '<textarea id="' + id + '" data-wz="' + key + '" rows="' + (opts.rows || 3) + '" placeholder="' + esc(opts.placeholder || '') + '">' + esc(v) + '</textarea>';
    else input = '<input type="text" id="' + id + '" data-wz="' + key + '" value="' + esc(v) + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" />';
    // A selector that can be picked in the preview
    var pick = sel && WZ_SEL[k] ? '<button type="button" class="btn btn--outline btn--small wz-pick' + (wz.pv.target === k ? ' is-active' : '') + '" data-wz-pick="' + k + '" title="' + esc(t('wz.pickHelp')) + '" aria-pressed="' + (wz.pv.target === k ? 'true' : 'false') + '">' + icon('ads_click') + esc(t('wz.pick')) + '</button>' : '';
    return '<div class="field wz-field"><label for="' + id + '">' + esc(label) + '</label><div class="wz-field__row">' + input + pick + '</div>' + (opts.help ? '<small class="field__help">' + esc(opts.help) + '</small>' : '') + '</div>';
  }
  var WZ_TITLES = { site: 'wz.step.site', kind: 'wz.step.kind', list: 'wz.step.list', work: 'wz.step.work', chapters: 'wz.step.chapters', crawl: 'wz.step.crawl', review: 'wz.step.review' };
  function wzStepBody(step) {
    var d = wz.draft, sel = function (k, ph) { return wzField('sel.' + k, t('cat.sel.' + k), { placeholder: ph }); };
    if (step === 'site') {
      var det = wz.detected;
      return '<p class="muted">' + esc(t('wz.siteIntro')) + '</p>' +
        wzField('name', t('manage.name'), { placeholder: t('cat.srcNamePlaceholder') }) +
        wzField('siteUrl', t('cat.srcSiteUrl'), { placeholder: 'https://example.com', help: t('cat.detectHelp') }) +
        '<div class="wz-actions"><button type="button" class="btn btn--outline" data-wz-act="detect"' + (wz.detecting ? ' disabled' : '') + '>' + (wz.detecting ? '<span class="spinner spinner--sm"></span>' : icon('search')) + esc(t('cat.detect')) + '</button></div>' +
        (det ? '<div class="notice notice--info wz-detected">' + esc(detectSummary(Object.assign({ settings: wz.draft }, det))) + '</div>' : '') +
        wzField('autoDetect', t('cat.srcAuto'), { type: 'checkbox', help: t('cat.srcAutoHelp') });
    }
    if (step === 'kind') {
      return wzField('type', t('cat.srcType'), { type: 'select', help: t('cat.srcTypeHelp'), options: wz.types.map(function (x) { return { value: x.type, label: x.label }; }) }) +
        wzField('baseUrl', t('cat.srcUrl'), { placeholder: 'https://example.com', help: t('cat.srcUrlHelp') }) +
        wzField('languages', t('cat.srcLanguages'), { placeholder: 'en, es', help: t('cat.srcLanguagesHelp') }) +
        (d.type === 'mangadex' ? wzField('contentRating', t('cat.srcRating'), { help: t('cat.srcRatingHelp') }) : '') +
        wzField('includeChapters', t('cat.srcChapters'), { type: 'checkbox', help: t('cat.srcChaptersHelp') });
    }
    if (step === 'list') {
      var out = wzField('listing', t('cat.srcListing'), { type: 'select', help: t('cat.srcListingHelp'), options: [{ value: 'sitemap', label: t('cat.listing.sitemap') }, { value: 'pages', label: t('cat.listing.pages') }] });
      if (d.listing === 'sitemap') {
        out += wzField('sitemaps', t('cat.srcSitemaps'), { type: 'textarea', rows: 2, help: t('cat.srcSitemapsHelp') }) +
          wzField('workPattern', t('cat.srcWorkPattern'), { placeholder: '/manga/*/', help: t('cat.srcPatternHelp') });
        var pats = wz.detected && wz.detected.found && wz.detected.found.patterns;
        if (pats && pats.length) out += '<p class="muted small">' + esc(t('wz.patternsSeen')) + ' ' + pats.slice(0, 6).map(function (p) { return p.pattern + ' (' + p.count + ')'; }).join(' · ') + '</p>';
      } else if (d.type === 'custom') {
        out += '<p class="muted small">' + esc(t('wz.listIntro')) + '</p>' +
          wzField('sel.listUrl', t('cat.sel.listUrl'), { placeholder: 'https://site.com/manga/page/{page}/', help: t('wz.listUrlHelp') }) +
          wzField('sel.firstPage', t('wz.firstPage'), { placeholder: '1' }) +
          wzActionsBox('list') + sel('item', '.manga-list .item') + sel('link', 'a@href') + sel('title', 'h3') + sel('cover', 'img@src');
      }
      if (d.type === 'madara' || d.type === 'mangareader') out += wzField('listPath', t('cat.srcListPath'), { placeholder: 'manga', help: t('cat.srcListPathHelp') });
      return out;
    }
    if (step === 'work') {
      return '<p class="muted small">' + esc(t('wz.workIntro')) + '</p>' + wzActionsBox('work') +
        sel('workTitle', 'h1') + sel('workCover', '.cover img@src') + sel('summary', '.description') + sel('genres', '.genres a') + sel('authors', '.author a') + sel('altTitles', '.alt-names') + sel('status', '.status');
    }
    if (step === 'chapters') {
      return '<p class="muted small">' + esc(t('wz.chaptersIntro')) + '</p>' + wzActionsBox('chapters') +
        sel('chapter', '.chapter-list li') + sel('chapterLink', 'a@href') + sel('chapterTitle', 'a') + sel('chapterDate', '.date') +
        wzField('chapterPattern', t('cat.srcChapterPattern'), { placeholder: '/manga/*/*/', help: t('cat.srcChapterPatternHelp') });
    }
    if (step === 'crawl') {
      return wzField('schedule', t('cat.srcSchedule'), { type: 'select', options: ['manual', 'daily', 'weekly'].map(function (x) { return { value: x, label: t('cat.schedule.' + x) }; }) }) +
        wzField('concurrency', t('cat.srcConcurrency'), { placeholder: String((catSourcesState().data && catSourcesState().data.defaultConcurrency) || 3), help: t('cat.srcConcurrencyHelp') }) +
        (d.autoDetect ? '' : wzField('gapMs', t('cat.srcGap'), { placeholder: '1500', help: t('cat.srcGapHelp') }) + wzField('maxWorks', t('cat.srcMax'), { placeholder: '0', help: t('cat.srcMaxHelp') }));
    }
    // review: what will be saved, and a Test with these settings
    var rows = d.autoDetect ? [[t('cat.srcSiteUrl'), d.siteUrl], [t('cat.srcAuto'), t('common.yes')]] :
      [[t('cat.srcType'), (wz.types.filter(function (x) { return x.type === d.type; })[0] || {}).label || d.type], [t('cat.srcUrl'), d.baseUrl], [t('cat.srcListing'), t('cat.listing.' + d.listing)]]
        .concat(Object.keys(d.selectors).filter(function (k) { return d.selectors[k]; }).map(function (k) { return [t('cat.sel.' + k) !== 'cat.sel.' + k ? t('cat.sel.' + k) : k, d.selectors[k]]; }));
    rows.push([t('cat.srcSchedule'), t('cat.schedule.' + d.schedule)]);
    return '<dl class="pref-list wz-review">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd><code>' + esc(r[1] || '—') + '</code></dd>'; }).join('') + '</dl>' +
      (d.autoDetect ? '<p class="muted small">' + esc(t('cat.detectNote')) + '</p>' :
        '<div class="wz-actions"><button type="button" class="btn btn--outline" data-wz-act="test"' + (wz.test && wz.test.loading ? ' disabled' : '') + '>' + icon('play') + esc(t('cat.test')) + '</button></div>' + testReport(wz.test));
  }
  // "Before collecting, click": the buttons or tabs to press first on this page (a tab with the chapters, "Show
  // all"…), each picked in the preview; what each did in the preview is shown under it
  var WZ_ACT_RESULTS = { scrolled: 'wz.act.scrolled', noRequest: 'wz.act.noRequest', opened: 'wz.act.opened', added: 'wz.act.added', inPage: 'wz.act.inPage', notFound: 'wz.act.notFound', failed: 'wz.act.failed', otherSite: 'wz.act.otherSite', clicked: 'wz.act.clicked', missing: 'wz.act.notFound' };
  function wzActionsBox(group) {
    var list = wz.draft.actions[group], pv = wz.pv;
    // The preview's report: for this step's clicks (on the chapters step, after the work page's)
    var offset = group === 'chapters' ? wz.draft.actions.work.length : 0;
    var report = pv.page && pv.reportFor === wz.step ? pv.report || [] : [];
    return '<div class="wz-clicks"><h3 class="wz-clicks__title">' + esc(t('wz.clicksTitle')) + '</h3><p class="muted small">' + esc(t('wz.clicksHelp')) + '</p>' +
      list.map(function (a, i) {
        var key = 'act:' + group + ':' + i, r = report[offset + i];
        var scroll = a.kind === 'scroll';
        return '<div class="wz-click' + (scroll ? ' wz-click--scroll' : '') + '"><span class="wz-click__n">' + (i + 1) + '</span>' +
          '<input type="text" id="wz-' + key.replace(/:/g, '-') + '" data-wz="' + key + '" value="' + esc(a.selector) + '" placeholder="' + esc(t(scroll ? 'wz.scrollPlaceholder' : 'wz.clickPlaceholder')) + '" aria-label="' + esc(t('wz.clickN', { n: i + 1 })) + '" />' +
          '<button type="button" class="btn btn--outline btn--small wz-pick' + (pv.target === key ? ' is-active' : '') + '" data-wz-pick="' + key + '" aria-pressed="' + (pv.target === key) + '" title="' + esc(t('wz.pickHelp')) + '">' + icon('ads_click') + esc(t('wz.pick')) + '</button>' +
          '<select class="select select--compact" data-wz="actmode:' + group + ':' + i + '" aria-label="' + esc(t('wz.clickMode')) + '">' +
            '<option value="add"' + (!scroll && a.mode !== 'open' ? ' selected' : '') + '>' + esc(t('wz.clickAdd')) + '</option>' +
            '<option value="open"' + (!scroll && a.mode === 'open' ? ' selected' : '') + '>' + esc(t('wz.clickOpen')) + '</option>' +
            '<option value="scroll"' + (scroll ? ' selected' : '') + '>' + esc(t('wz.scrollKind')) + '</option></select>' +
          (scroll ? '<div class="wz-click__loads"><input type="url" data-wz="actloads:' + group + ':' + i + '" value="' + esc(a.loads[0] || '') + '" placeholder="https://…" aria-label="' + esc(t('wz.scrollLoads')) + '" />' +
            '<button type="button" class="btn btn--outline btn--small" data-wz-act="act-scroll" data-group="' + group + '" data-i="' + i + '" title="' + esc(t('wz.scrollTryHelp')) + '"' + (pv.scripts ? '' : ' disabled') + '>' + icon('sync') + esc(t('wz.scrollTry')) + '</button>' +
            '<small class="field__help">' + esc(t(pv.scripts ? 'wz.scrollLoadsHelp' : 'wz.scrollNeedsScripts')) + '</small></div>' : '') +
          '<button type="button" class="icon-btn" data-wz-act="act-del" data-group="' + group + '" data-i="' + i + '" aria-label="' + esc(t('wz.clickRemove')) + '">' + icon('close') + '</button>' +
          (r ? '<p class="small wz-click__result' + (/notFound|failed|otherSite|missing|noRequest/.test(r.result) ? ' is-bad' : '') + '">' + esc(t(WZ_ACT_RESULTS[r.result] || 'wz.act.inPage', { url: r.url || '', error: r.error || '', pages: r.pages || 0, chapters: r.chapters || 0 })) + '</p>' : '') +
        '</div>';
      }).join('') +
      (list.length < 5 ? '<button type="button" class="btn btn--text btn--small" data-wz-act="act-add" data-group="' + group + '">' + icon('add') + esc(t('wz.clickAdd1')) + '</button>' : '') +
    '</div>';
  }

  /* -------- the preview of the site's pages (steps with selectors) --------
   * The page as the site sent it (fetched by the server), shown in a sandboxed frame that may run scripts but has
   * no access to Thoth (an opaque origin: not the app's pages, cookies or API). It loads the site's images, styles
   * and fonts itself; the site's own scripts run only when asked ("Site scripts"), and the picker can wait a few
   * seconds for the page to finish loading. With "Images and styles" off, a copy that loads nothing from the site
   * is shown instead. The picker runs inside the frame (wzPickerMain) and talks to the wizard with messages. */
  var wzHasPreview = function (step) { return !wz.draft.autoDetect && ((step === 'list' && wz.draft.type === 'custom' && wz.draft.listing !== 'sitemap') || step === 'work' || step === 'chapters'); };
  function wzPreviewBar() {
    var pv = wz.pv;
    return '<input type="url" id="wz-pv-url" value="' + esc(pv.typed != null ? pv.typed : pv.url) + '" placeholder="https://…" aria-label="' + esc(t('wz.pageAddress')) + '" />' +
      '<button type="button" class="btn btn--outline btn--small" data-wz-act="load">' + esc(t('wz.load')) + '</button>' +
      '<button type="button" class="btn btn--text btn--small" data-wz-act="reload" title="' + esc(t('wz.reload')) + '" aria-label="' + esc(t('wz.reload')) + '">' + icon('sync') + '</button>' +
      '<div class="seg" role="group" aria-label="' + esc(t('wz.mode')) + '">' +
        '<button type="button" class="seg__btn' + (pv.mode === 'pick' ? ' is-active' : '') + '" data-wz-mode="pick" aria-pressed="' + (pv.mode === 'pick') + '">' + icon('ads_click') + esc(t('wz.modePick')) + '</button>' +
        '<button type="button" class="seg__btn' + (pv.mode === 'interact' ? ' is-active' : '') + '" data-wz-mode="interact" aria-pressed="' + (pv.mode === 'interact') + '" title="' + esc(t('wz.interactHelp')) + '">' + icon('touch_app') + esc(t('wz.modeInteract')) + '</button>' +
        '<button type="button" class="seg__btn' + (pv.mode === 'navigate' ? ' is-active' : '') + '" data-wz-mode="navigate" aria-pressed="' + (pv.mode === 'navigate') + '">' + icon('open_in_new') + esc(t('wz.modeNavigate')) + '</button>' +
      '</div>' +
      '<div class="wz-preview__opts">' +
        '<label class="checkbox small"><input type="checkbox" id="wz-pv-images"' + (pv.images ? ' checked' : '') + ' /><span>' + esc(t('wz.images')) + '</span></label>' +
        '<label class="checkbox small" title="' + esc(t('wz.scriptsHelp')) + '"><input type="checkbox" id="wz-pv-scripts"' + (pv.scripts ? ' checked' : '') + (pv.images ? '' : ' disabled') + ' /><span>' + esc(t('wz.scripts')) + '</span></label>' +
        '<label class="checkbox small" title="' + esc(t('wz.revealHelp')) + '"><input type="checkbox" id="wz-pv-reveal"' + (pv.reveal ? ' checked' : '') + ' /><span>' + esc(t('wz.reveal')) + '</span></label>' +
        '<label class="small wz-wait">' + esc(t('wz.wait')) + ' <input type="number" id="wz-pv-wait" min="0" max="60" step="1" value="' + esc(pv.wait) + '" /> ' + esc(t('wz.seconds')) + '</label>' +
      '</div>';
  }
  function wzStatusText() {
    var pv = wz.pv, target = pv.target ? wzFieldLabel(pv.target) : null;
    if (pv.loading) return t('wz.fetching');
    if (pv.page && !pv.ready) return pv.clicking ? t('wz.clicking', { n: pv.clicking }) : pv.waitLeft > 0 ? t('wz.waiting', { s: pv.waitLeft }) : t('wz.pageLoading');
    if (pv.info) return pv.info;
    if (pv.scrolling) return t('wz.scrolling');
    return pv.mode === 'navigate' ? t('wz.navigateHelp') : pv.mode === 'interact' ? (pv.interacted ? t('wz.interacted', { selector: pv.interacted }) : t('wz.interactHelp')) : target ? t('wz.pickingFor', { field: target }) : t('wz.chooseField');
  }
  function wzStatus() {
    var p = $('#wz-pv-status'); if (p && wz) p.textContent = wzStatusText();
    // A click made in Interact mode can become one of this step's clicks before collecting
    var x = $('#wz-pv-keep'), pv = wz && wz.pv, group = wz && ({ list: 'list', work: 'work', chapters: 'chapters' })[wz.step];
    if (x) x.innerHTML = pv && pv.mode === 'interact' && pv.interacted && group && wz.draft.actions[group].length < 5 ? '<button type="button" class="btn btn--outline btn--small" data-wz-act="keep-click">' + icon('add') + esc(t('wz.keepClick')) + '</button>' : '';
  }
  function wzRender() {
    var dlg = $('#src-wizard');
    if (!dlg || !wz) return;
    var steps = wzSteps();
    if (steps.indexOf(wz.step) === -1) wz.step = steps[0];
    var i = steps.indexOf(wz.step), last = i === steps.length - 1;
    var preview = wzHasPreview(wz.step);
    // The frame is built once per kind of page shown (list or work page), so the page and what it loaded stay
    // while settings are picked; the rest is drawn again
    var layout = preview ? 'pv-' + WZ_PAGE[wz.step] : 'form';
    if (dlg.dataset.layout !== layout || !$('#wz-form', dlg)) {
      dlg.dataset.layout = layout;
      dlg.innerHTML = '<div class="wizard__frame">' +
        '<header class="wizard__head"><h2 id="wz-title">' + esc(t(wz.editing ? 'cat.editSource' : 'cat.addSource')) + '</h2>' +
          '<button type="button" class="icon-btn" data-wz-act="close" aria-label="' + esc(t('common.close')) + '">' + icon('close') + '</button></header>' +
        '<ol class="wizard__steps" id="wz-steps"></ol>' +
        '<div class="wizard__body' + (preview ? ' wizard__body--split' : '') + '"><div class="wizard__form" id="wz-form"></div>' +
          (preview ? '<section class="wz-preview" aria-label="' + esc(t('wz.preview')) + '"><div class="wz-preview__bar" id="wz-pv-bar"></div>' +
            '<p class="small wz-preview__status" id="wz-pv-status" role="status"></p><div class="wz-preview__keep" id="wz-pv-keep"></div><div id="wz-pv-error"></div><div class="wz-preview__holder" id="wz-frame-holder"></div></section>' : '') + '</div>' +
        '<footer class="wizard__foot" id="wz-foot"></footer></div>';
    }
    $('#wz-steps', dlg).innerHTML = steps.map(function (s, k) { return '<li class="' + (k === i ? 'is-current' : k < i ? 'is-done' : '') + '"><button type="button" data-wz-go="' + s + '"' + (k === i ? ' aria-current="step"' : '') + '>' + (k + 1) + '. ' + esc(t(WZ_TITLES[s])) + '</button></li>'; }).join('');
    $('#wz-form', dlg).innerHTML = wzStepBody(wz.step);
    $('#wz-foot', dlg).innerHTML = '<p class="wizard__error" role="alert">' + (wz.error ? esc(A().errMsg(wz.error)) : '') + '</p>' +
      (i > 0 ? '<button type="button" class="btn btn--text" data-wz-act="back">' + esc(t('wz.back')) + '</button>' : '') +
      (last ? '<button type="button" class="btn btn--primary" data-wz-act="save"' + (wz.saving ? ' disabled' : '') + '>' + esc(t('common.save')) + '</button>'
        : '<button type="button" class="btn btn--primary" data-wz-act="next">' + esc(t('wz.next')) + '</button>');
    if (preview) {
      $('#wz-pv-bar', dlg).innerHTML = wzPreviewBar();
      $('#wz-pv-error', dlg).innerHTML = wz.pv.error ? errorBanner(wz.pv.error) : '';
      wzStatus();
    }
    if (window.renderIcons) window.renderIcons(dlg);
    if (preview) wzShowPreview();
  }
  // The frame showing the page; built again only when the page or how it's shown changes
  function wzShowPreview() {
    var pv = wz.pv, holder = $('#wz-frame-holder');
    if (!holder) return;
    if (!pv.page && !pv.loading && !pv.error && !pv.tried) {
      var url = wzDefaultPreviewUrl();
      pv.tried = true;
      if (url) return wzLoadPreview(url);
    }
    // The clicks of this step: made by the server (as crawls make them) — the page is fetched again when they
    // change; with the site's scripts, made in the page itself (real clicks)
    var acts = JSON.stringify(wzActionsFor(wz.step).filter(function (a) { return a.selector || (a.kind === 'scroll' && a.loads.length); }));
    if (pv.page && !pv.loading && !pv.scripts && pv.page.actionsKey !== acts && pv.base) return wzLoadPreview(pv.base);
    var key = pv.page ? [pv.seq, pv.images ? 1 : 0, pv.scripts ? 1 : 0, pv.wait, pv.reloads || 0, pv.scripts ? acts : ''].join('|') : 'empty' + (pv.loading ? '-loading' : '');
    var frame = $('#wz-frame');
    if (frame && frame.dataset.key === key) return wzSendConfig();
    holder.innerHTML = '';
    frame = document.createElement('iframe');
    frame.id = 'wz-frame'; frame.className = 'wz-preview__frame'; frame.title = t('wz.preview');
    // With the site's scripts: fully isolated from Thoth (an opaque origin). Without them: only the picker can run
    // (removed scripts and handlers, and a policy that lets only its nonce run), so the frame may share Thoth's
    // origin, which lets the browser load the site's images and styles from any address
    frame.setAttribute('sandbox', pv.scripts ? 'allow-scripts' : 'allow-scripts allow-same-origin');
    frame.dataset.key = key;
    pv.ready = false; pv.waitLeft = 0;
    frame.srcdoc = pv.page ? wzBuildDoc(pv.page) : '<p style="font:14px sans-serif;color:#777;padding:16px">' + esc(pv.loading ? t('wz.fetching') : t('wz.noPage')) + '</p>';
    holder.appendChild(frame);
    wzStatus();
  }
  function wzDefaultPreviewUrl() {
    var d = wz.draft;
    if (wz.step === 'list') {
      var lu = d.selectors.listUrl;
      if (lu) try { return new URL(lu.replace('{page}', d.selectors.firstPage || '1'), d.baseUrl || d.siteUrl).href; } catch (e) { /* not an address */ }
      return d.baseUrl || d.siteUrl;
    }
    return wz.sampleWork || '';
  }
  function wzLoadPreview(url) {
    var pv = wz.pv, seq = pv.seq = (pv.seq || 0) + 1; // (only the latest page asked for is shown)
    pv.url = url; pv.base = url; pv.typed = null; pv.loading = true; pv.error = null; pv.info = null; pv.page = null; pv.srcDoc = null;
    var acts = wzActionsFor(wz.step).filter(function (a) { return a.selector || (a.kind === 'scroll' && a.loads.length); }), actsKey = JSON.stringify(acts), step = wz.step;
    wzRender();
    api('GET', '/api/catalog/preview?' + Store.qs({ url: url, inert: pv.images ? undefined : '1', actions: acts.length && !pv.scripts ? actsKey : undefined })).then(function (r) {
      if (pv.seq !== seq) return;
      pv.page = r.page; pv.url = r.page.url;
      pv.page.actionsKey = pv.scripts ? null : actsKey;
      pv.report = r.page.actions || []; pv.reportFor = step;
    }, function (e) { if (pv.seq === seq) pv.error = e; })
      .then(function () { if (pv.seq !== seq) return; pv.loading = false; if (wz && wz.pv === pv) wzRender(); });
  }
  // Another kind of page to show: the next render loads it
  function wzResetPreview() { var pv = wz.pv; pv.seq = (pv.seq || 0) + 1; pv.page = null; pv.loading = false; pv.error = null; pv.info = null; pv.target = null; pv.tried = false; pv.srcDoc = null; }
  // The document the frame shows: the site's page (its images, styles, and scripts if asked) + the picker
  function wzBuildDoc(page) {
    var pv = wz.pv;
    var cfg = { wait: Number(pv.wait) || 0, mode: pv.mode, field: pv.target, spec: wzSpec(pv.target), selectors: wz.draft.selectors, reveal: Boolean(pv.reveal),
      clicks: pv.scripts ? wzActionsFor(wz.step).filter(function (a) { return a.kind !== 'scroll'; }).map(function (a) { return a.selector; }).filter(Boolean) : [] };
    var picker = '(' + wzPickerMain.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ');';
    var nonce = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(12)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    if (!pv.images && page.html) {
      // The copy that loads nothing from the site (its own policy blocks everything): the picker allowed in
      return page.html.replace("default-src 'none';", "default-src 'none'; script-src 'nonce-" + nonce + "';").replace(/<\/body>/i, '') + '<script nonce="' + nonce + '">' + picker.replace(/<\/script/gi, '<\\/script') + '</script>';
    }
    var doc = new DOMParser().parseFromString(page.source || '', 'text/html');
    Array.prototype.forEach.call(doc.querySelectorAll('base, meta[http-equiv]'), function (x) { x.remove(); });
    if (!pv.scripts) {
      Array.prototype.forEach.call(doc.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, portal, link[rel=import], link[rel=modulepreload], link[rel=preload][as=script]'), function (x) { x.remove(); });
      // What the page shows without scripts (<noscript>), and the images its lazy loader would have put in place
      Array.prototype.forEach.call(doc.querySelectorAll('noscript'), function (x) { while (x.firstChild) x.parentNode.insertBefore(x.firstChild, x); x.remove(); });
      Array.prototype.forEach.call(doc.querySelectorAll('*'), function (el) {
        Array.prototype.slice.call(el.attributes).forEach(function (a) { if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name); });
        if (el.tagName === 'IMG') {
          var lazy = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
          if (lazy && (!el.getAttribute('src') || /^data:|\.gif(\?|$)|blank|placeholder|lazy/i.test(el.getAttribute('src')))) el.setAttribute('src', lazy);
          var lazySet = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
          if (lazySet && !el.getAttribute('srcset')) el.setAttribute('srcset', lazySet);
        }
      });
    }
    var head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
    var base = doc.createElement('base'); base.setAttribute('href', page.url);
    head.insertBefore(base, head.firstChild);
    if (!pv.scripts) {
      // Without the site's scripts: only the picker runs (its nonce); the page can't send data anywhere
      var csp = doc.createElement('meta'); csp.setAttribute('http-equiv', 'Content-Security-Policy');
      csp.setAttribute('content', "script-src 'nonce-" + nonce + "'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; worker-src 'none'");
      head.insertBefore(csp, head.firstChild);
    }
    var s = doc.createElement('script');
    s.setAttribute('nonce', nonce);
    s.textContent = picker;
    (doc.body || doc.documentElement).appendChild(s);
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }
  function wzSendConfig() {
    var frame = $('#wz-frame'), pv = wz && wz.pv;
    if (!frame || !frame.contentWindow || !pv) return;
    frame.contentWindow.postMessage({ thoth: 'config', cfg: { mode: pv.mode, field: pv.target, spec: wzSpec(pv.target), selectors: wz.draft.selectors, reveal: Boolean(pv.reveal) } }, '*');
  }
  // Is what was picked in the page as the site sends it (what crawls read: they don't run the site's scripts)?
  function wzInSource(field, selector) {
    var pv = wz.pv;
    if (!pv.page || !pv.page.source) return true;
    if (!pv.srcDoc) pv.srcDoc = new DOMParser().parseFromString(pv.page.source, 'text/html');
    var spec = wzSpec(field), css = String(selector).split('@')[0];
    try {
      if (spec.kind === 'rel') {
        var rows = pv.srcDoc.querySelectorAll(String(wz.draft.selectors[spec.rel] || '').split('@')[0]);
        return !css ? rows.length > 0 : Array.prototype.some.call(rows, function (r) { return r.querySelector(css); });
      }
      return pv.srcDoc.querySelectorAll(css).length > 0;
    } catch (e) { return true; }
  }
  // Messages from the picker in the frame (data only: a selector, counts, samples, a link to follow)
  var WZ_PICK_ERRORS = { noRepeat: 'wz.noRepeat', pickParentFirst: 'wz.pickParentFirst', pickInside: 'wz.pickInside', pickNotFound: 'wz.pickNotFound', chooseField: 'wz.chooseField' };
  window.addEventListener('message', function (e) {
    var frame = $('#wz-frame');
    if (!wz || !frame || e.source !== frame.contentWindow) return;
    var m = e.data, pv = wz.pv;
    if (!m || m.thoth !== 'picker') return;
    if (m.type === 'waiting') { pv.ready = false; pv.clicking = 0; pv.waitLeft = Math.max(0, Math.min(60, Number(m.left) || 0)); return wzStatus(); }
    if (m.type === 'scrolled' && pv.scrollFor) {
      // What scrolling asked the site for: the same site's requests, the ones that look like a list first
      var sa = /^act:(\w+):(\d)$/.exec(pv.scrollFor), act = sa && wz.draft.actions[sa[1]][Number(sa[2])];
      pv.scrolling = false; pv.scrollFor = null;
      var host = function (u) { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch (e) { return ''; } };
      var asked = (Array.isArray(m.requests) ? m.requests : []).map(String).filter(function (u) { return /^https?:\/\//i.test(u) && host(u) === host(pv.url); });
      asked.sort(function (a, b) { return (/chapter|episode|list|page|cursor|offset/i.test(b) ? 1 : 0) - (/chapter|episode|list|page|cursor|offset/i.test(a) ? 1 : 0); });
      if (act && asked.length) { act.loads = asked.slice(0, 1); pv.info = t('wz.scrollFound', { url: asked[0], count: asked.length }); }
      else pv.info = t(m.found === false ? 'wz.scrollNoBox' : 'wz.scrollNothing');
      var form0 = $('#wz-form'); if (form0) { form0.innerHTML = wzStepBody(wz.step); if (window.renderIcons) window.renderIcons(form0); }
      return wzStatus();
    }
    if (m.type === 'interacted' && pv.mode === 'interact' && typeof m.selector === 'string' && m.selector.length <= 300) { pv.interacted = m.selector; return wzStatus(); }
    if (m.type === 'clicking') { pv.ready = false; pv.clicking = Math.max(1, Math.min(5, Number(m.n) || 1)); return wzStatus(); }
    if (m.type === 'clicked' && Array.isArray(m.report)) {
      pv.report = m.report.slice(0, 15).map(function (x) { return { result: x === true ? 'clicked' : 'missing' }; }); pv.reportFor = wz.step;
      var form = $('#wz-form'); if (form) { form.innerHTML = wzStepBody(wz.step); if (window.renderIcons) window.renderIcons(form); }
      return;
    }
    if (m.type === 'ready') { pv.ready = true; pv.waitLeft = 0; pv.clicking = 0; wzStatus(); return wzSendConfig(); }
    if (m.type === 'navigate') { var href = String(m.href || ''); if (/^https?:\/\//i.test(href) && (pv.mode === 'navigate' || pv.mode === 'interact')) wzLoadPreview(href); return; }
    if (m.type === 'error' && WZ_PICK_ERRORS[m.code]) {
      var rel = pv.target && WZ_SEL[pv.target] && WZ_SEL[pv.target].rel;
      pv.info = t(WZ_PICK_ERRORS[m.code], { field: rel ? t('cat.sel.' + rel) : '' });
      return wzStatus();
    }
    if (m.type === 'picked' && m.field === pv.target && wzSpec(m.field) && typeof m.selector === 'string' && m.selector.length <= 400) {
      var field = m.field, click = /^act:(\w+):(\d)$/.exec(field);
      if (click) {
        // A click picked: kept, and the page shown again with it made
        wz.draft.actions[click[1]][Number(click[2])].selector = m.selector;
        pv.target = null;
        pv.info = t('wz.clickPicked', { n: Number(click[2]) + 1, selector: m.selector });
        if (!pv.scripts && pv.base) wzLoadPreview(pv.base); else wzRender();
        return;
      }
      wz.draft.selectors[field] = m.selector;
      if ((field === 'link' || field === 'item') && /^https?:\/\//i.test(String(m.workUrl || ''))) wz.sampleWork = String(m.workUrl);
      var samples = (Array.isArray(m.samples) ? m.samples : []).slice(0, 3).map(function (x) { return String(x).slice(0, 80); });
      pv.info = t('wz.picked', { field: wzFieldLabel(field), selector: m.self ? t('wz.itself') : m.selector, count: Number(m.count) || 0 }) + (samples.length ? ' — ' + samples.join(' | ') : '') +
        (wzInSource(field, m.selector) ? '' : ' ⚠ ' + t('wz.onlyWithScripts'));
      var input = $('#wz-sel-' + field);
      if (input) input.value = m.selector;
      wzStatus();
    }
  });
  /* -------- the picker, inside the frame --------
   * Self-contained (it runs in the site's page): hover outline, click to pick or to follow a link, selectors the
   * crawler understands (tag, #id, .class, descendants). It waits for the page to load (+ cfg.wait seconds). */
  function wzPickerMain(cfg) {
    var ready = false, last = null;
    // Requests the page makes (its own scripts): recorded, to tell what scrolling a list asks the site for
    var requests = [];
    var record = function (u) { try { if (u) requests.push(new URL(String(u), document.baseURI).href); } catch (e) { /* not an address */ } };
    try {
      if (window.fetch) { var realFetch = window.fetch; window.fetch = function (input) { record(typeof input === 'string' ? input : input && input.url); return realFetch.apply(this, arguments); }; }
      var realOpen = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { record(u); return realOpen.apply(this, arguments); };
    } catch (e) { /* the page locked them */ }
    // "Show hidden content": what the page hides (collapsed text, other tabs) shown, to pick it
    var reveal = document.createElement('style');
    reveal.textContent = '[hidden],[aria-hidden=true],.hidden,.d-none,.collapse:not(.show),.tab-pane,[style*="display:none"],[style*="display: none"]{display:block!important}' +
      '[style*="visibility:hidden"],[style*="visibility: hidden"],.invisible{visibility:visible!important}.line-clamp,[class*="line-clamp"],[class*="truncate"],[style*="max-height"]{max-height:none!important;-webkit-line-clamp:unset!important;overflow:visible!important}';
    var showHidden = function () {
      if (cfg.reveal && !reveal.parentNode) { (document.head || document.documentElement).appendChild(reveal); Array.prototype.forEach.call(document.querySelectorAll('details'), function (d) { d.open = true; }); }
      if (!cfg.reveal && reveal.parentNode) reveal.remove();
    };
    // Scrolling a list (or the page) to its end a few times, as a reader would: what it asked the site for
    var scrollList = function (sel) {
      var box = null; try { box = sel ? document.querySelector(sel) : null; } catch (e) { box = null; }
      var el = box || document.scrollingElement || document.documentElement;
      var from = requests.length, rounds = 0, still = 0, lastH = -1, links = document.querySelectorAll('a[href]').length;
      var step = function () {
        el.scrollTop = el.scrollHeight;
        try { el.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')); } catch (e) { /* old browser */ }
        rounds++;
        setTimeout(function () {
          if (el.scrollHeight === lastH) still++; else still = 0;
          lastH = el.scrollHeight;
          if (rounds < 8 && still < 2) return step();
          var asked = requests.slice(from).filter(function (u) { return /^https?:/i.test(u) && !/\.(png|jpe?g|gif|webp|avif|svg|css|js|mjs|woff2?|ttf|ico)(\?|$)/i.test(u); });
          post({ type: 'scrolled', selector: sel || '', found: Boolean(box) || !sel, requests: asked.slice(0, 20), grew: document.querySelectorAll('a[href]').length - links });
        }, 1200);
      };
      step();
    };

    var post = function (m) { m.thoth = 'picker'; try { parent.postMessage(m, '*'); } catch (e) { /* the wizard closed */ } };
    var BLOCK = /^(li|div|article|section|tr|td|dl|dd|figure|header|ul|ol|table|tbody|main|aside|nav)$/;
    var goodClass = function (c) { return /^[a-zA-Z][\w-]{1,40}$/.test(c) && !/\d{4,}/.test(c) && !/^(active|current|selected|hover|focus|show|open|is-|has-|js-|thoth-)/.test(c); };
    var stepOf = function (el) {
      var tag = el.tagName.toLowerCase();
      if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)) return tag + '#' + el.id;
      return tag + Array.prototype.filter.call(el.classList, goodClass).slice(0, 2).map(function (c) { return '.' + c; }).join('');
    };
    var pathSelector = function (el, stopAt, ok) {
      var parts = [stepOf(el)], cur = el.parentElement;
      for (var i = 0; i < 6; i++) {
        var s = parts.join(' ');
        if (ok(s)) return s;
        if (!cur || cur === stopAt || cur.tagName === 'HTML') break;
        parts.unshift(stepOf(cur)); cur = cur.parentElement;
      }
      return parts.join(' ');
    };
    var all = function (root, s) { try { return root.querySelectorAll(s); } catch (e) { return []; } };
    var mark = function (list) {
      Array.prototype.forEach.call(document.querySelectorAll('.thoth-match'), function (x) { x.classList.remove('thoth-match'); });
      Array.prototype.forEach.call(list, function (x) { if (x && x.classList) x.classList.add('thoth-match'); });
    };
    var sampleOf = function (x, attr) {
      if (attr === 'src') return x.getAttribute('data-src') || x.getAttribute('data-lazy-src') || x.getAttribute('src') || '';
      if (attr === 'href') return x.getAttribute('href') || '';
      return (x.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    };
    function pick(el) {
      var field = cfg.field, spec = cfg.spec, sel = cfg.selectors || {};
      if (!field || !spec) return post({ type: 'error', code: 'chooseField' });
      var attr = spec.attr ? '@' + spec.attr : '', r = null;
      if (spec.kind === 'scrollbox') {
        // The list that scrolls: the nearest box around what was clicked that can scroll (else the page)
        var sb = el;
        while (sb && sb !== document.body && !(/(auto|scroll)/.test(getComputedStyle(sb).overflowY) && sb.scrollHeight > sb.clientHeight + 10)) sb = sb.parentElement;
        if (!sb || sb === document.body) return post({ type: 'picked', field: field, selector: '', count: 1, samples: ['(page)'] });
        var sone = function (x) { try { return document.querySelector(x) === sb; } catch (e) { return false; } };
        mark([sb]);
        return post({ type: 'picked', field: field, selector: pathSelector(sb, null, sone), count: 1, samples: [sb.querySelectorAll('a').length + ' links'] });
      }
      if (spec.kind === 'click') {
        // The element that takes the click: the link, button or tab around what was clicked
        var c = (el.closest && el.closest('a, button, summary, label, [role=tab], [role=button], [onclick], [data-url], [data-href], [data-load], [data-toggle], [data-bs-toggle], [data-target], [data-tab]')) || el;
        var only = function (x) { try { return document.querySelector(x) === c && all(document, x).length === 1; } catch (e) { return false; } };
        var cs = pathSelector(c, null, only);
        if (!only(cs)) cs = pathSelector(c, null, function (x) { try { return document.querySelector(x) === c; } catch (e) { return false; } });
        mark([c]);
        return post({ type: 'picked', field: field, selector: cs, count: 1, samples: [(c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)] });
      }
      if (spec.kind === 'repeat') {
        var cur = el;
        while (cur && cur.parentElement && !BLOCK.test(cur.tagName.toLowerCase())) cur = cur.parentElement;
        for (; cur && cur.tagName !== 'BODY'; cur = cur.parentElement) {
          var s = pathSelector(cur, null, function (x) { var n = all(document, x).length; return n >= 2 && n <= 2000; });
          if (all(document, s).length >= 2) { r = { selector: s, matches: all(document, s) }; break; }
        }
        if (!r) return post({ type: 'error', code: 'noRepeat' });
      } else if (spec.kind === 'rel') {
        var parentSel = String(sel[spec.rel] || '').split('@')[0];
        if (!parentSel) return post({ type: 'error', code: 'pickParentFirst' });
        var root = el.closest(parentSel);
        if (!root) return post({ type: 'error', code: 'pickInside' });
        var target = spec.attr === 'href' ? (el.closest('a[href]') || el.querySelector('a[href]')) : spec.attr === 'src' ? (el.tagName === 'IMG' ? el : el.querySelector('img') || (el.closest('a, div, figure') || el).querySelector('img')) : el;
        if (!target || !root.contains(target)) return post({ type: 'error', code: 'pickNotFound' });
        if (target === root) r = { selector: '', self: true, matches: [target] };
        else {
          var rs = pathSelector(target, root, function (x) { try { return root.querySelector(x) === target; } catch (e) { return false; } });
          r = { selector: rs + attr, matches: Array.prototype.map.call(all(document, parentSel), function (x) { return x.querySelector(rs); }).filter(Boolean) };
        }
      } else if (spec.kind === 'multi') {
        var box = el.parentElement;
        while (box && box.parentElement && box.querySelectorAll(stepOf(el)).length < 2 && !BLOCK.test(box.tagName.toLowerCase())) box = box.parentElement;
        var boxSel = pathSelector(box, null, function (x) { try { return document.querySelector(x) === box; } catch (e) { return false; } });
        var ms = boxSel + ' ' + stepOf(el);
        r = { selector: ms + attr, matches: all(document, ms) };
      } else {
        var tgt = spec.attr === 'src' ? (el.tagName === 'IMG' ? el : el.querySelector('img') || el) : el;
        var unique = function (x) { try { return document.querySelector(x) === tgt && all(document, x).length === 1; } catch (e) { return false; } };
        var ss = pathSelector(tgt, null, unique);
        if (!unique(ss)) ss = pathSelector(tgt, null, function (x) { try { return document.querySelector(x) === tgt; } catch (e) { return false; } });
        r = { selector: ss + attr, matches: [tgt] };
      }
      mark(r.matches);
      var first = r.matches[0], a = first && (first.closest ? first.closest('a[href]') : null) || (first && first.querySelector ? first.querySelector('a[href]') : null);
      post({ type: 'picked', field: field, selector: r.selector, self: Boolean(r.self), count: r.matches.length,
        samples: Array.prototype.slice.call(r.matches, 0, 3).map(function (x) { return sampleOf(x, spec.attr); }).filter(Boolean), workUrl: a ? a.href : null });
    }
    var style = document.createElement('style');
    style.textContent = '.thoth-hl{outline:2px solid #1a73e8!important;outline-offset:1px;background-color:rgba(26,115,232,.12)!important}.thoth-match{outline:2px dashed #188038!important;outline-offset:1px}';
    (document.head || document.documentElement).appendChild(style);
    var cursor = function () { document.documentElement.style.cursor = ready && cfg.mode === 'pick' ? 'crosshair' : ''; };
    window.addEventListener('message', function (e) {
      if (e.source !== parent || !e.data || e.data.thoth !== 'config') return;
      if (e.data.scroll) return scrollList(e.data.scroll.selector);
      cfg = e.data.cfg || cfg; cursor(); showHidden();
      if (cfg.mode !== 'pick' && last) { last.classList.remove('thoth-hl'); last = null; }
    });
    document.addEventListener('mouseover', function (e) {
      if (!ready || cfg.mode !== 'pick') return;
      if (last) last.classList.remove('thoth-hl');
      last = e.target; if (last.classList) last.classList.add('thoth-hl');
    }, true);
    document.addEventListener('mouseout', function () { if (last) last.classList.remove('thoth-hl'); last = null; }, true);
    document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
    document.addEventListener('click', function (e) {
      var el = e.target;
      // Interact: the page gets the click (tabs, "show more"…); a link to another page opens it in the preview
      if (ready && cfg.mode === 'interact') {
        var la = el.closest && el.closest('a[href]');
        if (la && /^https?:/i.test(la.href) && la.getAttribute('href').charAt(0) !== '#') { e.preventDefault(); e.stopPropagation(); return post({ type: 'navigate', href: la.href, interact: true }); }
        var tgt = (el.closest && el.closest('a, button, summary, label, [role=tab], [role=button], [onclick], [data-url], [data-href], [data-load], [data-toggle], [data-bs-toggle], [data-target], [data-tab]')) || el;
        var only = function (x) { try { return document.querySelector(x) === tgt; } catch (er) { return false; } };
        return post({ type: 'interacted', selector: pathSelector(tgt, null, only) });
      }
      e.preventDefault(); e.stopPropagation();
      if (!ready) return;
      if (cfg.mode === 'navigate') { var a = el.closest && el.closest('a[href]'); if (a && /^https?:/i.test(a.href)) post({ type: 'navigate', href: a.href }); return; }
      if (last) last.classList.remove('thoth-hl');
      pick(el);
    }, true);
    // Ready once the page has loaded and the wait asked for has passed
    var start = function () {
      var left = Math.max(0, Math.min(60, Number(cfg.wait) || 0));
      var tick = function () {
        if (left <= 0) { showHidden(); return clicks(); }
        post({ type: 'waiting', left: left }); left--; setTimeout(tick, 1000);
      };
      // With the site's scripts: the clicks asked for, made for real, one every 1.5 s (time to show what they load)
      var clicks = function () {
        var list = (cfg.clicks || []).slice(0, 15), report = [];
        var next = function (i) {
          if (i >= list.length) { if (list.length) post({ type: 'clicked', report: report }); ready = true; cursor(); post({ type: 'ready' }); return; }
          post({ type: 'clicking', n: i + 1 });
          var el = null; try { el = document.querySelector(list[i]); } catch (e) { /* not a selector */ }
          report.push(Boolean(el));
          if (el) { try { el.click(); } catch (e) { /* its own scripts failed */ } }
          setTimeout(function () { next(i + 1); }, el ? 1500 : 0);
        };
        next(0);
      };
      tick();
    };
    // (an image or script that never finishes loading doesn't hold the picker back for more than 20 s)
    var started = false;
    var go = function () { if (!started) { started = true; start(); } };
    if (document.readyState === 'complete') go(); else { window.addEventListener('load', go); setTimeout(go, 20000); }
  }
  /* -------- the wizard's own events -------- */
  function wzInput(e) {
    var el = e.target, key = el.dataset && el.dataset.wz;
    if (!wz) return;
    var pv = wz.pv;
    if (el.id === 'wz-pv-url') { pv.typed = el.value; return; }
    if (e.type === 'change' && el.id === 'wz-pv-images') {
      pv.images = el.checked; if (!pv.images) pv.scripts = false;
      // (the copy that loads nothing from the site comes from the server)
      if (!pv.images && pv.page && !pv.page.html) return wzLoadPreview(pv.url);
      return wzRender();
    }
    if (e.type === 'change' && el.id === 'wz-pv-scripts') { pv.scripts = el.checked; return wzRender(); }
    if (e.type === 'change' && el.id === 'wz-pv-reveal') { pv.reveal = el.checked; return wzSendConfig(); }
    if (e.type === 'change' && el.id === 'wz-pv-wait') { pv.wait = Math.max(0, Math.min(60, Math.round(Number(el.value) || 0))); return wzRender(); }
    if (!key) return;
    var v = el.type === 'checkbox' ? el.checked : el.value;
    var ak = /^act(mode|loads)?:(list|work|chapters):(\d)$/.exec(key);
    if (ak) {
      var a = wz.draft.actions[ak[2]][Number(ak[3])];
      if (a && ak[1] === 'loads') { a.loads = v.trim() ? [v.trim()] : []; if (e.type !== 'change') return; }
      else if (a && ak[1] === 'mode') { var was = a.kind; a.kind = v === 'scroll' ? 'scroll' : 'click'; if (a.kind === 'click') a.mode = v === 'open' ? 'open' : 'add'; if (was !== a.kind) { var f1 = $('#wz-form'); if (f1) { f1.innerHTML = wzStepBody(wz.step); if (window.renderIcons) window.renderIcons(f1); } } }
      else if (a) a.selector = v;
      // (the page shown again with the clicks as they are now)
      if (e.type === 'change' && wz.pv.base) wzLoadPreview(wz.pv.base);
      return;
    }
    if (key.indexOf('sel.') === 0) wz.draft.selectors[key.slice(4)] = v; else wz.draft[key] = v;
    // Settings that change which steps or fields apply: drawn again
    if (e.type === 'change' && ['autoDetect', 'type', 'listing', 'includeChapters'].indexOf(key) !== -1) wzRender();
    // A new list page address: the preview shows it
    if (e.type === 'change' && (key === 'sel.listUrl' || key === 'sel.firstPage')) { wzResetPreview(); wzRender(); }
    if (key === 'siteUrl' && !wz.draft.baseUrl) wz.draft.baseUrl = v;
  }
  function wzValidate(step) {
    var d = wz.draft;
    if (step === 'site') {
      if (!String(d.name).trim()) return { code: 'nameRequired' };
      if (!/^https?:\/\/\S+$/i.test(String(d.siteUrl).trim())) return { code: 'invalidUrl' };
    }
    if (step === 'kind' && !/^https?:\/\/\S+$/i.test(String(d.baseUrl || '').trim())) return { code: 'invalidUrl' };
    if (step === 'list' && d.listing === 'sitemap' && !String(d.workPattern).trim()) return { code: 'workPatternRequired' };
    if (step === 'list' && d.listing !== 'sitemap' && d.type === 'custom' && (!d.selectors.listUrl || !d.selectors.item)) return { code: 'wzListNeeded' };
    return null;
  }
  // The settings as the server takes them
  function wzBody() {
    var d = wz.draft;
    if (d.autoDetect) return { name: d.name.trim(), siteUrl: d.siteUrl.trim(), schedule: d.schedule, concurrency: Number(d.concurrency) || 0, autoDetect: true };
    var body = { name: d.name.trim(), type: d.type, baseUrl: (d.baseUrl || d.siteUrl).trim(), siteUrl: d.siteUrl.trim(), autoDetect: false, listPath: d.listPath, languages: d.languages, contentRating: d.contentRating,
      includeChapters: Boolean(d.includeChapters), listing: d.listing, sitemaps: String(d.sitemaps || '').split(/\s+/).filter(Boolean), workPattern: d.workPattern, chapterPattern: d.chapterPattern,
      iconUrl: d.iconUrl || undefined, maxWorks: Number(d.maxWorks) || 0, schedule: d.schedule, concurrency: Number(d.concurrency) || 0, selectors: {} };
    if (Number(d.gapMs)) body.gapMs = Number(d.gapMs);
    Object.keys(d.selectors).forEach(function (k) { if (d.selectors[k]) body.selectors[k] = d.selectors[k]; });
    body.actions = {};
    ['list', 'work', 'chapters'].forEach(function (g) { var l = d.actions[g].filter(function (a) { return a.selector.trim() || (a.kind === 'scroll' && a.loads.length); }); if (l.length) body.actions[g] = l; });
    return body;
  }
  function wzClick(e) {
    if (!wz) return;
    var b = e.target.closest('button');
    if (!b) return;
    var steps = wzSteps(), i = steps.indexOf(wz.step);
    if (b.dataset.wzPick) { wz.pv.target = wz.pv.target === b.dataset.wzPick ? null : b.dataset.wzPick; wz.pv.mode = 'pick'; wz.pv.info = null; return wzRender(); }
    if (b.dataset.wzMode) { wz.pv.mode = b.dataset.wzMode; wz.pv.info = null; return wzRender(); }
    if (b.dataset.wzGo) { wz.error = null; if (WZ_PAGE[b.dataset.wzGo] !== WZ_PAGE[wz.step]) wzResetPreview(); wz.pv.target = null; wz.step = b.dataset.wzGo; return wzRender(); }
    var act = b.dataset.wzAct;
    if (act === 'close') return $('#src-wizard').close();
    if (act === 'back') { wz.error = null; var prev = steps[Math.max(0, i - 1)]; if (WZ_PAGE[prev] !== WZ_PAGE[wz.step]) wzResetPreview(); wz.pv.target = null; wz.step = prev; return wzRender(); }
    if (act === 'next') {
      wz.error = wzValidate(wz.step);
      if (!wz.error) {
        var page = WZ_PAGE[wz.step], nextStep = steps[Math.min(steps.length - 1, i + 1)];
        if (WZ_PAGE[nextStep] !== page) wzResetPreview(); // (another kind of page to preview)
        wz.pv.target = null; wz.step = nextStep;
      }
      return wzRender();
    }
    if (act === 'load') { var u = $('#wz-pv-url').value.trim(); if (u) wzLoadPreview(u); return; }
    if (act === 'act-scroll') {
      var sk = 'act:' + b.dataset.group + ':' + b.dataset.i, sa2 = wz.draft.actions[b.dataset.group][Number(b.dataset.i)];
      var fr = $('#wz-frame');
      if (!sa2 || !fr || !wz.pv.ready) return;
      wz.pv.scrolling = true; wz.pv.scrollFor = sk; wz.pv.info = null; wzStatus();
      fr.contentWindow.postMessage({ thoth: 'config', scroll: { selector: sa2.selector } }, '*');
      return;
    }
    if (act === 'keep-click') {
      var kg = ({ list: 'list', work: 'work', chapters: 'chapters' })[wz.step];
      if (kg && wz.pv.interacted && wz.draft.actions[kg].length < 5) { wz.draft.actions[kg].push({ kind: 'click', selector: wz.pv.interacted, mode: 'add', loads: [] }); wz.pv.interacted = null; wz.pv.info = t('wz.keptClick'); }
      if (wz.pv.base && !wz.pv.scripts) return wzLoadPreview(wz.pv.base);
      return wzRender();
    }
    if (act === 'act-add') { var g = b.dataset.group, l = wz.draft.actions[g]; if (l && l.length < 5) { l.push({ kind: 'click', selector: '', mode: 'add', loads: [] }); wz.pv.target = 'act:' + g + ':' + (l.length - 1); wz.pv.mode = 'pick'; } return wzRender(); }
    if (act === 'act-del') { var dl = wz.draft.actions[b.dataset.group]; if (dl) dl.splice(Number(b.dataset.i), 1); wz.pv.target = null; if (wz.pv.base) return wzLoadPreview(wz.pv.base); return wzRender(); }
    if (act === 'reload') { wz.pv.reloads = (wz.pv.reloads || 0) + 1; wz.pv.info = null; return wzRender(); }
    if (act === 'detect') {
      var url = String(wz.draft.siteUrl || '').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) { wz.error = { code: 'invalidUrl' }; return wzRender(); }
      wz.detecting = true; wz.error = null; wzRender();
      return api('POST', '/api/catalog/sources/detect', { url: url }).then(function (r) {
        var det = r.detect || r;
        wz.detected = det;
        var s = det.settings || {};
        var d = wz.draft;
        if (!d.name && s.name) d.name = s.name;
        ['type', 'baseUrl', 'listing', 'workPattern', 'chapterPattern', 'listPath', 'iconUrl'].forEach(function (k) { if (s[k]) d[k] = s[k]; });
        if (s.sitemaps) d.sitemaps = s.sitemaps.join('\n');
        if (s.selectors) d.selectors = Object.assign({}, s.selectors, d.selectors);
        if (det.found && det.found.sampleWork && det.found.sampleWork.url) wz.sampleWork = det.found.sampleWork.url;
      }, function (err) { wz.error = err; }).then(function () { wz.detecting = false; wzRender(); });
    }
    if (act === 'test') {
      wz.test = { loading: true }; wzRender();
      return api('POST', '/api/catalog/sources/test', wzBody()).then(function (r) { wz.test = { test: r.test }; }, function (err) { wz.test = { error: err }; }).then(function () { if (wz) wzRender(); });
    }
    if (act === 'save') {
      wz.saving = true; wz.error = null; wzRender();
      var body = wzBody(), id = wz.editing;
      var req = id ? api('PATCH', '/api/catalog/sources/' + id, body)
        : body.autoDetect ? api('POST', '/api/catalog/sources', { name: body.name, baseUrl: body.siteUrl }).then(function (r) { return api('PATCH', '/api/catalog/sources/' + r.source.id, { schedule: body.schedule, concurrency: body.concurrency }); })
        : api('POST', '/api/catalog/sources', body);
      return req.then(function () {
        $('#src-wizard').close();
        A().toast(t('common.saved'));
        catFilesState().sources = null;
        loadCatSources();
      }, function (err) { if (wz) { wz.saving = false; wz.error = err; wzRender(); } });
    }
  }
  var WZ_PAGE = { list: 'list', work: 'work', chapters: 'work' };

  // What Detect found, in words (shown at the top of the settings form)
  function detectSummary(d) {
    if (!d) return '';
    var f = d.found || {}, n = d.notes || [];
    var lines = [];
    if (d.blocked) lines.push(t('cat.det.blocked'));
    if (n.indexOf('mangadex') !== -1 || n.indexOf('webtoons') !== -1) lines.push(t('cat.det.known'));
    if (f.robots) lines.push(t(f.robots === 'found' ? 'cat.det.robots' : 'cat.det.noRobots'));
    if (f.sitemaps && f.sitemaps.length) lines.push(t('cat.det.sitemaps', { count: f.sitemaps.length, files: f.sitemapFiles || f.sitemaps.length }));
    if (n.indexOf('noSitemap') !== -1) lines.push(t('cat.det.noSitemap'));
    if (d.settings && d.settings.workPattern) lines.push(t('cat.det.works', { pattern: d.settings.workPattern, count: f.works }));
    if (d.settings && d.settings.chapterPattern) lines.push(t('cat.det.chapters', { pattern: d.settings.chapterPattern }));
    if (f.theme) lines.push(t('cat.det.theme', { theme: f.theme === 'madara' ? 'Madara' : 'MangaReader' }));
    else if (d.settings && d.settings.type === 'custom') lines.push(t('cat.det.generic'));
    if (f.sampleWork) lines.push(t('cat.det.sample', { title: f.sampleWork.title || '—', chapters: f.sampleWork.chapterLinks }));
    if (n.indexOf('robotsWorks') !== -1) lines.push(t('cat.det.robotsWorks'));
    if (n.indexOf('needsSelectors') !== -1 || n.indexOf('noWorkPattern') !== -1) lines.push(t('cat.det.needsSelectors'));
    return lines.join(' ');
  }
  // Site files tab (admins): each source's robots.txt and sitemaps — the ones it uses, the ones detection found and
  // the ones its last crawl read (content hash, date, works listed) — each read on demand: its text and what it lists
  function catFilesState() {
    if (!cache.catFiles) cache.catFiles = { sources: null, source: '', data: null, error: null, view: null, file: null, q: '', raw: false };
    return cache.catFiles;
  }
  function loadCatFiles() {
    var st = catFilesState();
    var srcs = st.sources ? Promise.resolve(null) : api('GET', '/api/catalog/sources');
    return srcs.then(function (r) {
      if (r) { st.sources = r.sources; if (!st.source && r.sources.length) st.source = r.sources[0].id; }
      if (!st.source) return;
      return api('GET', '/api/catalog/sources/' + encodeURIComponent(st.source) + '/files').then(function (d) { st.data = d; st.error = null; });
    }).then(null, function (e) { st.error = e; }).then(function () {
      if (isCatalogRoute() && A().parseRoute().param === 'files') A().renderPage();
      if (st.data && !st.view) openSiteFile(st.data.robots);
    });
  }
  function openSiteFile(url) {
    var st = catFilesState();
    st.view = url; st.file = { loading: true }; st.q = '';
    if (isCatalogRoute()) A().renderPage();
    api('GET', '/api/catalog/sources/' + encodeURIComponent(st.source) + '/file?' + Store.qs({ url: url })).then(function (r) { if (st.view === url) st.file = r.file; }, function (e) { if (st.view === url) st.file = { error: e }; })
      .then(function () { if (isCatalogRoute() && A().parseRoute().param === 'files') A().renderPage(); });
  }
  function siteFileLink(loc, label) {
    var st = catFilesState();
    return '<button type="button" class="link-button' + (st.view === loc ? ' is-current' : '') + '" data-lib="cat-file-open" data-id="' + esc(loc) + '">' + esc(label || loc) + '</button>';
  }
  function siteFileView(st) {
    var f = st.file;
    if (!st.view) return '';
    var head = '<div class="sitefile__head"><h2 class="card__title">' + esc(st.view) + '</h2>' +
      '<a class="btn btn--text btn--small" href="' + esc(st.view) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') + esc(t('cat.openOnSite')) + '</a></div>';
    if (!f || f.loading) return '<section class="card card--wide sitefile">' + head + '<p class="muted small"><span class="spinner spinner--sm"></span> ' + esc(t('common.loading')) + '</p></section>';
    if (f.error) return '<section class="card card--wide sitefile">' + head + errorBanner(f.error) + '</section>';
    if (!f.found) return '<section class="card card--wide sitefile">' + head + '<p class="muted">' + esc(t('cat.files.noRobots')) + '</p></section>';
    var facts = [t('cat.files.size', { size: fmtSize(f.size) }), t('cat.files.hash', { hash: String(f.hash || '').slice(0, 12) })];
    if (f.kind === 'sitemap') facts.push(t('cat.files.lists', { urls: f.urlCount || 0, sitemaps: (f.sitemaps || []).length }));
    var q = st.q.toLowerCase();
    var urls = (f.urls || []).filter(function (u) { return !q || u.loc.toLowerCase().indexOf(q) !== -1; });
    var children = (f.sitemaps || []).length ? '<h3 class="proc-sub">' + esc(t('cat.files.childSitemaps')) + '</h3><ul class="sitefile__list">' +
      f.sitemaps.map(function (s) { return '<li>' + siteFileLink(s.loc) + (s.lastmod ? ' <span class="muted small">' + esc(s.lastmod) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '';
    var list = f.kind === 'sitemap' && (f.urls || []).length ? '<h3 class="proc-sub">' + esc(t('cat.files.urls', { count: f.urlCount })) + '</h3>' +
        '<label class="search-field">' + icon('search') + '<input type="search" id="sitefile-q" placeholder="' + esc(t('cat.files.find')) + '" value="' + esc(st.q) + '" /></label>' +
        '<div class="table-wrap sitefile__urls"><table class="table"><thead><tr><th>' + esc(t('cat.files.address')) + '</th><th>' + esc(t('cat.files.lastmod')) + '</th></tr></thead><tbody>' +
          urls.slice(0, 500).map(function (u) { return '<tr><td><a href="' + esc(u.loc) + '" target="_blank" rel="noopener noreferrer">' + esc(u.loc) + '</a></td><td class="small">' + esc(u.lastmod || '—') + '</td></tr>'; }).join('') +
        '</tbody></table></div>' + (urls.length > 500 || (f.urlCount || 0) > (f.urls || []).length ? '<p class="muted small">' + esc(t('cat.files.firstOnly', { count: Math.min(urls.length, 500) })) + '</p>' : '') : '';
    var raw = f.kind === 'robots' || st.raw
      ? '<pre class="task-console__text task-console__text--tall sitefile__raw">' + esc(f.text || '') + '</pre>' + (f.truncated ? '<p class="muted small">' + esc(t('cat.files.truncated')) + '</p>' : '')
      : '<button type="button" class="btn btn--text btn--small" data-lib="cat-file-raw">' + icon('description') + esc(t('cat.files.showText')) + '</button>';
    return '<section class="card card--wide sitefile">' + head + '<p class="muted small">' + esc(facts.join(' · ')) + '</p>' +
      (f.kind === 'robots' && (f.sitemaps || []).length ? '<h3 class="proc-sub">' + esc(t('cat.files.robotsSitemaps')) + '</h3><ul class="sitefile__list">' + f.sitemaps.map(function (s) { return '<li>' + siteFileLink(s.loc) + '</li>'; }).join('') + '</ul>' : '') +
      children + list + raw + '</section>';
  }
  var FILE_FROM = { settings: 'cat.files.fromSettings', detected: 'cat.files.fromDetect', crawl: 'cat.files.fromCrawl' };
  function catalogFiles() {
    var st = catFilesState();
    var head = catalogTabs('files') + '<p class="page-lead">' + esc(t('cat.files.intro')) + '</p>';
    if (st.error) return head + errorBanner(st.error);
    if (!st.sources) return head + spinner;
    if (!st.sources.length) return head + emptyState('dataset', t('cat.noSourcesTitle'), t('cat.files.noSources'));
    var d = st.data;
    var picker = '<div class="toolbar"><div class="toolbar__group"><select class="select select--compact" id="cat-files-source" aria-label="' + esc(t('cat.filterSource')) + '">' +
      st.sources.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === st.source ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div></div>';
    if (!d) return head + picker + spinner;
    var files = '<section class="card card--wide"><h2 class="card__title">' + esc(t('cat.files.title', { name: d.name })) + '</h2>' +
      '<ul class="sitefile__list"><li>' + siteFileLink(d.robots, 'robots.txt') + '</li>' +
      d.sitemaps.map(function (s) {
        return '<li>' + siteFileLink(s.loc) + ' <span class="muted small">' + esc(s.from.map(function (x) { return t(FILE_FROM[x]); }).join(', ') +
          (s.works != null ? ' · ' + t('cat.files.worksListed', { count: s.works }) : '') + (s.hash ? ' · ' + t('cat.files.hash', { hash: s.hash.slice(0, 12) }) : '') + (s.lastmod ? ' · ' + s.lastmod : '')) + '</span></li>';
      }).join('') + '</ul>' +
      (d.sitemaps.length ? '' : '<p class="muted small">' + esc(t('cat.files.noSitemaps')) + '</p>') +
      (d.crawledAt ? '<p class="muted small">' + esc(t('cat.files.crawledAt', { time: A().fmtDate(d.crawledAt) })) + '</p>' : '') + '</section>';
    return head + picker + '<div class="cards cards--stack">' + files + siteFileView(st) + '</div>';
  }
  function catalogFilesMount(el) {
    var st = catFilesState();
    var sel = $('#cat-files-source', el);
    if (sel) sel.addEventListener('change', function () { st.source = sel.value; st.data = null; st.view = null; st.file = null; loadCatFiles(); });
    var q = $('#sitefile-q', el);
    if (q) q.addEventListener('input', function () {
      st.q = q.value;
      var pos = q.selectionStart;
      A().renderPage();
      var again = $('#sitefile-q'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
  }

  var catalogPage = {
    title: function (route) {
      if (route.param === 'work') { var d = catWorkState(route.query.get('key') || ''); return d && d.work ? d.work.title : t('nav.catalog'); }
      return t('nav.catalog');
    },
    render: function (route) {
      if (route.param === 'work') return catalogWork(route);
      if (route.param === 'merge' && isAdmin()) return catalogMerge();
      if (route.param === 'sources' && isAdmin()) return catalogSources();
      if (route.param === 'files' && isAdmin()) return catalogFiles();
      return catalogBrowse();
    },
    mount: function (el, route) {
      if (!route.param) return catalogBrowseMount(el);
      if (route.param === 'files') return catalogFilesMount(el);
      if (route.param === 'merge') el.addEventListener('change', function (e) {
        var tg = e.target, st = catMergeState(), k;
        if ((k = tg.dataset.catPrimary)) { st.choice[k].primary = tg.value; st.choice[k].include[tg.value] = true; return A().renderPage(); }
        if ((k = tg.dataset.catInclude)) { st.choice[k].include[tg.value] = tg.checked; return A().renderPage(); }
        if (tg.dataset.libChange === 'cat-merge-source') { st.source = tg.value; return loadCatMerge(); }
      });
    },
    enter: function (route) {
      if (route.param === 'work') {
        var key = route.query.get('key') || '';
        cache.catWork = cache.catWork || {};
        return api('GET', '/api/catalog/work?' + Store.qs({ key: key })).then(function (r) { cache.catWork[key] = { work: r.work }; }, function (e) { cache.catWork[key] = { error: e }; })
          .then(function () { if (isCatalogRoute()) A().renderPage(); });
      }
      if (route.param === 'merge') { var ms = catMergeState(); if (!ms.data && !ms.loading) loadCatMerge(); return; }
      if (route.param === 'sources') return loadCatSources();
      if (route.param === 'files') return loadCatFiles();
      var st = catState();
      api('GET', '/api/catalog/facets').then(function (r) { st.facets = r; if (isCatalogRoute() && !A().parseRoute().param) { A().renderPage(); } }, function () {});
      if (!st.items) fetchCatalog();
    }
  };

  /* ================= METADATA SOURCES (admins) ================= */
  // Folder sources (JSON files the admin keeps) can be added, edited, checked and deleted; online sites are
  // listed with their key status, the libraries using them and a test search.
  function usedByLine(list) {
    return '<p class="muted small">' + esc(list && list.length ? t('msrc.usedBy', { libraries: list.map(function (l) { return l.name; }).join(', ') }) : t('msrc.usedByNone')) + '</p>';
  }
  function checkReport(r) {
    if (!r) return '';
    if (r.loading) return '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc(t('msrc.checking')) + '</p>';
    if (r.error) return errorBanner(r.error);
    var html = '<div class="msrc-report">';
    if (!r.folderOk) html += '<p class="notice notice--error">' + esc(t('msrc.folderMissing')) + '</p>';
    html += '<p class="small"><strong>' + esc(t('msrc.jsonFiles', { count: r.files })) + '</strong>' + (r.truncated ? ' ' + esc(t('msrc.truncated')) : '') + '</p>';
    html += '<ul class="msrc-libs">' + r.libraries.map(function (l) {
      return '<li><strong>' + esc(l.name) + '</strong>: ' + esc(t('msrc.matchedLine', { works: l.works, worksTotal: l.worksTotal, books: l.books, booksTotal: l.booksTotal })) +
        (l.enabled ? '' : ' <span class="badge">' + esc(t('msrc.offHere')) + '</span>') +
        (l.examples.length ? '<ul class="msrc-examples">' + l.examples.map(function (x) {
          return '<li><code>' + esc(x.file) + '</code> → <code>' + esc(x.what) + '</code></li>';
        }).join('') + '</ul>' : '') + '</li>';
    }).join('') + '</ul>';
    if (r.ambiguous.length) html += '<p class="notice">' + esc(t('msrc.ambiguous', { names: r.ambiguous.join(', ') })) + '</p>';
    if (r.errors.length) html += '<p class="notice notice--error">' + esc(t('msrc.unreadable')) + '</p><ul class="msrc-examples">' +
      r.errors.map(function (e) { return '<li><code>' + esc(e.file) + '</code> — ' + esc(e.error) + '</li>'; }).join('') + '</ul>';
    if (r.unusedCount) html += '<p class="muted small">' + esc(t('msrc.unused', { count: r.unusedCount })) + '</p><ul class="msrc-examples">' +
      r.unused.map(function (f) { return '<li><code>' + esc(f) + '</code></li>'; }).join('') + (r.unusedCount > r.unused.length ? '<li>…</li>' : '') + '</ul>';
    return html + '</div>';
  }
  function searchReport(r) {
    if (!r) return '';
    if (r.loading) return '<p class="muted small"><span class="spinner spinner--sm"></span> ' + esc(t('msrc.searching')) + '</p>';
    if (r.error) return '<p class="notice notice--error small">' + esc(A().errMsg(r.error)) + '</p>';
    if (!r.items.length) return '<p class="muted small">' + esc(t('meta.noResults')) + '</p>';
    return '<p class="muted small">' + esc(t('msrc.answeredIn', { ms: r.ms })) + '</p><ul class="msrc-results">' + r.items.map(function (x) {
      return '<li>' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a>' : esc(x.title)) +
        ' <span class="muted small">' + esc([x.type ? t('type.' + x.type) : '', x.year || '', Math.round((x.score || 0) * 100) + '%'].filter(Boolean).join(' · ')) + '</span></li>';
    }).join('') + '</ul>';
  }
  var metadataSources = {
    title: function () { return t('nav.metadataSources'); },
    render: function () {
      var d = cache.msrc;
      var head = '<div class="page-head"><h1 class="page-title">' + esc(t('nav.metadataSources')) + '</h1>' +
        '<button class="btn btn--primary" data-lib="msrc-add">' + icon('add') + esc(t('msrc.add')) + '</button></div>' +
        '<p class="page-lead">' + esc(t('msrc.intro')) + '</p>';
      if (!d) return head + spinner;
      if (d.error) return head + errorBanner(d.error);
      var checks = cache.msrcCheck || {}, searches = cache.msrcSearch || {};
      var folders = d.folder.length ? '<div class="lib-list msrc-grid">' + d.folder.map(function (s) {
        return '<section class="card lib-card msrc-card">' +
          '<div class="lib-card__head"><span class="lib-card__icon">' + icon('description') + '</span>' +
            '<div class="lib-card__text"><h3 class="card__title">' + esc(s.name) + '</h3>' +
            '<p class="muted small lib-card__path">' + icon('folder_open') + '<span>' + esc(s.folder) + '</span></p></div></div>' +
          '<p class="small">' + esc(t('msrc.match.' + s.match)) + '</p>' +
          usedByLine(s.usedBy) +
          '<div class="lib-card__actions">' +
            '<button class="btn btn--outline btn--pill" data-lib="msrc-check" data-id="' + s.id + '">' + icon('search') + esc(t('msrc.check')) + '</button>' +
            '<button class="btn btn--text" data-lib="msrc-apply" data-id="' + s.id + '" title="' + esc(t('msrc.applyHelp')) + '">' + icon('sync') + esc(t('msrc.apply')) + '</button>' +
            '<button class="btn btn--text" data-lib="msrc-edit" data-id="' + s.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' +
            '<button class="btn btn--text btn--danger" data-lib="msrc-delete" data-id="' + s.id + '">' + icon('delete') + esc(t('manage.delete')) + '</button>' +
          '</div>' + checkReport(checks[s.id]) +
        '</section>';
      }).join('') + '</div>' : emptyState('description', t('msrc.noneTitle'), t('msrc.none'), '<button class="btn btn--outline" data-lib="msrc-add">' + icon('add') + esc(t('msrc.add')) + '</button>');
      var how = '<details class="card card--wide msrc-how"><summary class="card__title">' + esc(t('msrc.howTitle')) + '</summary>' +
        '<p class="small">' + esc(t('msrc.howPath')) + '</p>' +
        '<pre class="msrc-pre">metadata/One Piece.json        → library/One Piece/      (work)\nmetadata/One Piece/11.json     → library/One Piece/11.cbz (chapter)\nmetadata/One Piece.jpg         → cover of One Piece</pre>' +
        '<p class="small">' + esc(t('msrc.howName')) + '</p>' +
        '<pre class="msrc-pre">metadata/11.json → every book named 11.cbz / 11.pdf</pre>' +
        '<p class="small">' + esc(t('msrc.howJson')) + '</p>' +
        '<pre class="msrc-pre">{\n  "title": "Romance Dawn",          ← books\n  "number": "1", "date": "1997-07-22",\n  "summary": "…", "genres": ["Adventure"], "tags": ["Pirates"],\n  "status": "ongoing", "type": "manga", "year": 1997, "rating": 9.1,\n  "writer": "Eiichiro Oda", "readingDirection": "rtl", "cover": "op.jpg"\n}</pre>' +
        '<p class="small muted">' + esc(t('msrc.howOrder')) + '</p></details>';
      var online = '<div class="lib-list msrc-grid">' + d.online.map(function (p) {
        var key = p.needsKey ? (p.keySet ? '<span class="badge badge--ok">' + esc(t('cfg.keySet')) + '</span>' : '<span class="badge badge--danger">' + esc(t('meta.needsKey')) + '</span>')
          : p.optionalKey ? (p.keySet ? '<span class="badge badge--ok">' + esc(t('cfg.keySet')) + '</span>' : '<span class="badge">' + esc(t('msrc.keyOptional')) + '</span>') : '';
        return '<section class="card lib-card msrc-card">' +
          '<div class="lib-card__head"><span class="lib-card__icon">' + icon('open_in_new') + '</span><div>' +
            '<h3 class="card__title"><a href="' + esc(p.homepage) + '" target="_blank" rel="noopener noreferrer">' + esc(p.name) + '</a></h3>' + key + '</div></div>' +
          '<p class="small">' + esc(p.types.map(function (ty) { return t('type.' + ty); }).join(', ')) + '</p>' +
          usedByLine(p.usedBy) +
          (p.needsKey || p.optionalKey ? '<p class="field__help"><a href="#server-settings">' + esc(t('msrc.keysIn')) + '</a></p>' : '') +
          '<div class="msrc-search"><input type="search" placeholder="' + esc(t('msrc.tryPlaceholder')) + '" data-msrc-q="' + p.id + '" aria-label="' + esc(t('msrc.try')) + ' ' + esc(p.name) + '" />' +
            '<button class="btn btn--outline btn--small" data-lib="msrc-search" data-id="' + p.id + '">' + esc(t('msrc.try')) + '</button></div>' +
          '<div data-msrc-results="' + p.id + '">' + searchReport(searches[p.id]) + '</div>' +
        '</section>';
      }).join('') + '</div>';
      return head +
        '<h2 class="section-title">' + esc(t('msrc.folderTitle')) + '</h2>' + folders + how +
        '<h2 class="section-title">' + esc(t('msrc.onlineTitle')) + '</h2><p class="muted small">' + esc(t('msrc.onlineIntro')) + '</p>' + online;
    },
    mount: function (el) {
      // Enter in a search box = Try
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || !e.target.dataset.msrcQ) return;
        e.preventDefault();
        var b = el.querySelector('[data-lib="msrc-search"][data-id="' + e.target.dataset.msrcQ + '"]');
        if (b) b.click();
      });
    },
    enter: function (route) {
      load(route.hash, function () {
        return api('GET', '/api/metadata/sources').then(function (r) { cache.msrc = r; }, function (e) {
          if (e && e.status === 404) e = { code: 'unknownEndpoint', status: 404 };
          cache.msrc = { error: e }; throw e;
        });
      }, function () { return cache.msrc; });
    }
  };
  function folderSourceForm(src) {
    var modes = (cache.msrc && cache.msrc.matchModes) || ['path', 'name'];
    openForm({
      title: t(src ? 'msrc.editTitle' : 'msrc.add'),
      submitLabel: src ? t('common.save') : t('common.add'),
      fields: [
        { name: 'name', label: t('manage.name'), value: src ? src.name : '', placeholder: t('msrc.namePlaceholder') },
        // named "root" so the dialog's folder browser fills it
        { name: 'root', label: t('msrc.folder'), type: 'folder', value: src ? src.folder : '', placeholder: '/srv/metadata', help: t('msrc.folderHelp') },
        { name: 'match', label: t('msrc.matchLabel'), type: 'select', value: src ? src.match : 'path', help: t('msrc.matchHelp'),
          options: modes.map(function (m) { return { value: m, label: t('msrc.match.' + m) }; }) }
      ],
      onSubmit: function (v) {
        if (!v.name) return Promise.reject({ code: 'nameRequired' });
        var body = { name: v.name, folder: v.root, match: v.match };
        return (src ? api('PATCH', '/api/metadata/sources/' + src.id, body) : api('POST', '/api/metadata/sources', body)).then(function (r) {
          A().toast(t(src ? 'msrc.saved' : 'msrc.created'));
          providersCache = null; invalidate(); markStale(cache.series); markStale(cache.book);
          if (!cache.msrcCheck) cache.msrcCheck = {};
          refreshCurrent();
          // Show right away what it matches
          runCheck(r.source.id);
        });
      }
    });
  }
  function runCheck(id) {
    cache.msrcCheck = cache.msrcCheck || {};
    cache.msrcCheck[id] = { loading: true };
    A().renderPage();
    api('GET', '/api/metadata/sources/' + id + '/check').then(function (r) { cache.msrcCheck[id] = r; }, function (e) { cache.msrcCheck[id] = { error: e }; })
      .then(function () { if (A().parseRoute().name === 'metadata-sources') A().renderPage(); });
  }

  /* ================= PROCESSES (admins) ================= */
  var procTimer = null;
  function fmtBytes(b) { return b ? fmtSize(b) : '—'; }
  function fmtDuration(fromIso) {
    if (!fromIso) return '—';
    var s = Math.max(0, Math.floor((Date.now() - Date.parse(fromIso)) / 1000));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's';
  }
  function fmtCpu(ms) { return ms == null ? '—' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
  /* A process card is described as data and drawn by procCard:
   *   { id, icon, title, badge: { text, cls }, wide, parts: [html, …] }  (null/empty parts are skipped)
   * The helpers below make the usual parts. To show a new process, write a function that takes the
   * /api/processes answer and returns such a card (or null to hide it), and add it to PROC_SECTIONS. */
  function facts(rows) {
    rows = rows.filter(Boolean);
    return rows.length ? '<dl class="pref-list proc-facts">' + rows.map(function (r) {
      return '<dt>' + esc(t(r[0])) + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>' : '';
  }
  function procCard(c) {
    return '<section class="card proc-card' + (c.wide ? ' proc-card--wide' : '') + '" data-proc="' + esc(c.id) + '">' +
      '<div class="proc-card__head"><span class="lib-card__icon">' + icon(c.icon) + '</span>' +
        '<div><h2 class="card__title">' + esc(c.title) + '</h2>' +
        (c.badge ? '<span class="badge ' + (c.badge.cls || '') + '">' + esc(c.badge.text) + '</span>' : '') + '</div></div>' +
      (c.parts || []).filter(Boolean).join('') +
    '</section>';
  }
  var proc = {
    // A busy/idle badge
    busy: function (isBusy) { return { text: t(isBusy ? 'proc.busy' : 'proc.idle'), cls: isBusy ? 'badge--primary' : 'badge--ok' }; },
    // kind: '' | 'info' | 'error'; spin: a spinner in front
    notice: function (text, kind, spin) { return '<p class="notice' + (kind ? ' notice--' + kind : '') + '">' + (spin ? '<span class="spinner spinner--sm"></span>' : '') + esc(text) + '</p>'; },
    help: function (text, link) { return '<p class="field__help">' + esc(text || '') + (link ? (text ? ' ' : '') + '<a href="' + link.href + '">' + esc(link.text) + '</a>' : '') + '</p>'; },
    muted: function (text) { return '<p class="muted small">' + esc(text) + '</p>'; },
    sub: function (text) { return '<h3 class="proc-sub">' + esc(text) + '</h3>'; },
    // heads: column titles; rows: arrays of cell HTML, or { cells, cls } ; under: a full-width line below a row
    table: function (heads, rows) {
      return '<div class="table-wrap"><table class="table proc-workers"><thead><tr>' + heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) {
          var cells = Array.isArray(r) ? r : r.cells;
          return '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>' +
            (r.under ? '<tr class="proc-sub-row"><td></td><td colspan="' + (cells.length - 1) + '" class="muted small">' + esc(r.under) + '</td></tr>' : '');
        }).join('') + '</tbody></table></div>';
    },
    // { lib: data-lib, op, label, icon, primary, disabled }
    actions: function (buttons) {
      return '<div class="lib-card__actions">' + buttons.filter(Boolean).map(function (b) {
        return '<button class="btn ' + (b.primary ? 'btn--primary' : 'btn--outline') + ' btn--pill" data-lib="' + b.lib + '"' + (b.op ? ' data-op="' + b.op + '"' : '') + (b.disabled ? ' disabled' : '') + '>' + icon(b.icon) + esc(b.label) + '</button>';
      }).join('') + '</div>';
    }
  };
  function settingsLink() { return { href: '#server-settings', text: t('proc.changeInSettings') }; }
  var STATE_BADGE = { running: 'badge--ok', starting: 'badge--primary', stopped: '', crashed: 'badge--danger' };

  // The web server itself
  function procServer(p) {
    var srv = p.server, restarting = cache.serverRestarting;
    return {
      id: 'server', icon: 'memory', title: t('proc.server'),
      badge: { text: t(restarting ? 'proc.state.starting' : 'proc.state.running'), cls: restarting ? 'badge--primary' : 'badge--ok' },
      parts: [
        srv.restartNeeded ? proc.notice(t('proc.restartNeeded'), 'info') : '',
        facts([
          ['proc.pid', esc(srv.pid)], ['proc.uptime', esc(fmtDuration(srv.startedAt))],
          ['proc.memory', esc(fmtBytes(srv.rss))], ['proc.cpu', esc(fmtCpu(srv.cpuMs))],
          ['proc.node', esc(srv.node)], ['proc.platform', esc(srv.platform)]
        ]),
        proc.actions([{ lib: 'proc-server-restart', label: t('proc.serverRestart'), icon: 'sync', disabled: !srv.supervised || restarting }]),
        restarting ? proc.notice(t('proc.serverRestarting'), 'info', true) : !srv.supervised ? proc.help(t('proc.notSupervised')) : ''
      ]
    };
  }

  // Library scans: a service with worker processes, the scan in progress and the ones waiting
  function procScan(p) {
    var sc = p.scanService, cur = sc.current;
    var running = sc.state === 'running' || sc.state === 'starting', stopped = sc.state === 'stopped' || sc.state === 'crashed';
    return {
      id: 'scan', icon: 'sync', title: t('proc.scanService'),
      badge: { text: t('proc.state.' + sc.state), cls: STATE_BADGE[sc.state] || '' },
      parts: [
        sc.mode === 'inline' ? proc.notice(t('proc.mode.inline')) : '',
        sc.lastError && sc.state !== 'running' ? proc.notice(t('proc.lastError') + ': ' + sc.lastError, 'error') : '',
        facts([
          ['proc.uptime', esc(sc.state === 'running' ? fmtDuration(sc.startedAt) : '—')],
          sc.mode === 'process' ? ['proc.processes', esc(sc.processes)] : null,
          ['proc.concurrency', esc(sc.concurrency)],
          sc.mode === 'process' ? ['proc.priority', esc(t('proc.priorityLow'))] : null,
          ['proc.restarts', esc(sc.restarts)],
          sc.lastError && sc.state === 'running' ? ['proc.lastError', esc(sc.lastError)] : null
        ]),
        proc.help('', settingsLink()),
        // One row per worker process
        sc.workers.length ? proc.table([t('proc.pid'), t('proc.memory'), t('proc.cpu'), t('proc.status')], sc.workers.map(function (w) {
          var s2 = w.stats || {};
          return [esc(w.pid), esc(fmtBytes(s2.rss)), esc(fmtCpu(s2.cpuMs)), '<span class="badge' + (w.busy ? ' badge--primary' : '') + '">' + esc(t(w.busy ? 'proc.busy' : 'proc.idle')) + '</span>'];
        })) : sc.idle ? proc.muted(t('proc.onDemand')) : '',
        proc.sub(t('proc.current')),
        cur && cur.progress ? '<p class="proc-current"><strong>' + esc(cur.name) + '</strong></p>' + scanProgressBar(cur.progress, cur)
          : cur ? '<p class="notice notice--info"><span class="spinner spinner--sm"></span><span><strong>' + esc(cur.name) + '</strong> · ' + esc(scanModeLabel(cur)) + ' · ' +
              esc(cur.toAnalyze ? t('proc.progress', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0, total: cur.toAnalyze }) : t('manage.scanningNow', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0 })) + '</span></p>'
          : proc.muted(t('proc.idle')),
        proc.sub(t('proc.queue')),
        sc.queue.length ? '<ol class="proc-queue">' + sc.queue.map(function (q) { return '<li>' + esc(q.name) + ' <span class="muted small">(' + esc(scanModeLabel(q)) + ')</span></li>'; }).join('') + '</ol>'
          : proc.muted(t('proc.queueEmpty')),
        proc.actions([
          { lib: 'proc-scan', op: 'start', label: t('proc.start'), icon: 'play', primary: true, disabled: running },
          { lib: 'proc-scan', op: 'stop', label: t('proc.stop'), icon: 'stop', disabled: stopped },
          { lib: 'proc-scan', op: 'restart', label: t('proc.restart'), icon: 'sync', disabled: sc.mode === 'inline' }
        ]),
        proc.help(t('proc.stopHelp'))
      ]
    };
  }

  // Online metadata lookups (inside the web server, a few works at a time)
  function procMetadata(p) {
    var md = p.metadata;
    if (!md) return null;
    // current: a list of works; an older server sent one object or null
    var current = Array.isArray(md.current) ? md.current : md.current ? [md.current] : [];
    return {
      id: 'metadata', icon: 'download', title: t('meta.service'), badge: proc.busy(current.length > 0 || md.queue > 0),
      parts: [
        facts([
          ['proc.queue', esc(md.queue)],
          md.concurrency ? ['meta.atOnce', esc(md.concurrency)] : null,
          ['meta.doneCount', esc(md.done)],
          md.covers != null ? ['meta.coversDownloaded', esc(md.covers)] : null,
          md.lastError ? ['proc.lastError', esc(md.lastError)] : null
        ]),
        md.progress ? progressBar(md.progress, t('meta.batch'), t('progress.works', { done: md.progress.done, total: md.progress.total })) : '',
        current.length ? '<ul class="proc-list">' + current.map(function (c) {
          var what = c.step === 'covers' ? t('meta.stepCovers') : c.step === 'cover' ? t('meta.stepCover', { provider: providerName(c.provider || '') })
            : c.provider ? t('meta.stepSearching', { provider: providerName(c.provider) }) : '';
          return '<li><span class="spinner spinner--sm"></span><span><strong>' + esc(c.title) + '</strong>' + (what ? ' <span class="muted small">' + esc(what) + '</span>' : '') + '</span></li>';
        }).join('') + '</ul>' : '',
        proc.help(t('meta.serviceHelp'), settingsLink())
      ]
    };
  }

  // File jobs (renaming, deleting, merging): their own process, started for a job and closed after it
  function procFiles(p) {
    var rn = p.rename;
    if (!rn) return null;
    var rr = rn.running;
    var job = rr && (rn.jobs || []).filter(function (j) { return j.id === rr.jobId; })[0];
    return {
      id: 'files', icon: 'edit', title: t('proc.rename'), badge: proc.busy(Boolean(rr)),
      parts: [
        facts([
          rr && rr.pid ? ['proc.pid', esc(rr.pid)] : null,
          rr ? ['proc.status', esc(t('proc.renameProgress', { done: rr.done, total: rr.total }))] : null,
          rn.queued ? ['proc.queue', esc(rn.queued)] : null,
          !rr && rn.last ? ['proc.renameLast', esc(t('proc.renameLastValue', { files: rn.last.files, when: fmtDuration(rn.last.at) }))] : null
        ]),
        job ? renamePhaseHtml(job) : '',
        proc.help(t('proc.renameHelp'), { href: '#files', text: t('nav.files') })
      ]
    };
  }

  // External catalog crawls: each an independent process; a few at once, the others waiting
  function procCatalog(p) {
    var c = p.catalog;
    if (!c || !c.sources) return null;
    var crawls = c.crawls || [];
    var running = crawls.filter(function (j) { return j.status === 'running'; });
    return {
      id: 'catalog', icon: 'travel_explore', title: t('proc.catalog'), badge: proc.busy(running.length > 0),
      parts: [
        facts([
          ['proc.catalog.sources', esc(c.sources)],
          ['proc.catalog.atOnce', esc(c.maxCrawls)],
          c.concurrency ? ['proc.catalog.worksAtOnce', esc(c.concurrency)] : null,
          c.queued ? ['proc.queue', esc(c.queued)] : null
        ]),
        running.length ? running.map(function (j) {
          return '<p class="proc-current"><strong>' + esc(j.name) + '</strong>' + (j.pid ? ' <span class="muted small">' + esc(t('proc.pid')) + ' ' + esc(j.pid) + '</span>' : '') + '</p>' + crawlLine({ job: j });
        }).join('') : proc.muted(t('proc.catalog.none')),
        proc.help(t('proc.catalog.help'), { href: '#catalog/sources', text: t('cat.tabSources') })
      ]
    };
  }

  // The caches, each its own process (started when needed, closed after a long idle time)
  var CACHE_ORDER = ['pages', 'covers', 'works', 'search'];
  function procCaches(p) {
    var caches = (p.caches || []).slice().sort(function (a, b) { return CACHE_ORDER.indexOf(a.kind) - CACHE_ORDER.indexOf(b.kind); });
    if (!caches.length) return null;
    var row = function (c) {
      var s = c.stats || {}, open = c.pid || c.mode === 'inline';
      var size = s.maxBytes && c.kind !== 'search' ? t('proc.cache.size', { size: s.bytes ? fmtBytes(s.bytes) : '0 MB', max: fmtBytes(s.maxBytes) }) : '';
      var under = c.kind === 'search' && s.docs != null ? t('proc.cache.searchDocs', { docs: s.docs, tags: (s.terms || {}).tag || 0, people: (s.terms || {}).person || 0 })
        : c.kind === 'covers' && s.warm && (s.warm.running || s.warm.finishedAt) ? (s.warm.running ? t('proc.media.warmRunning', { done: s.warm.done, total: s.warm.total }) : t('proc.media.warmDone', { total: s.warm.total, added: s.warm.added })) : '';
      return {
        cells: [
          '<strong>' + esc(t('proc.cache.' + c.kind)) + '</strong>',
          c.pid ? esc(c.pid) : '<span class="muted">' + esc(t(c.mode === 'inline' ? 'proc.cache.inline' : 'proc.cache.closed')) + '</span>',
          // (what it's doing besides answering — search index size, covers read ahead — in the same row)
          esc(open ? t('proc.cache.entries', { count: s.entries || 0 }) + (size ? ' · ' + size : '') : '—') + (under ? '<span class="proc-cell-note">' + esc(under) + '</span>' : ''),
          esc(open ? t('proc.cache.answers', { hits: s.hits || 0, misses: s.misses || 0 }) : t('proc.cache.requests', { count: c.requests })),
          esc(s.rss ? fmtBytes(s.rss) : '—')
        ]
      };
    };
    return {
      id: 'caches', icon: 'collections', title: t('proc.caches'),
      badge: { text: t('proc.cache.running', { count: caches.filter(function (c) { return c.pid; }).length, total: caches.length }), cls: 'badge--ok' },
      parts: [
        proc.table([t('proc.cache.name'), t('proc.pid'), t('proc.cache.content'), t('proc.cache.answered'), t('proc.memory')], caches.map(row)),
        caches.filter(function (c) { return c.lastError; }).map(function (c) { return '<p class="notice notice--error small">' + esc(c.lastError) + '</p>'; }).join(''),
        proc.help(t('proc.cache.help'))
      ]
    };
  }

  // The Processes page, in this order
  var PROC_SECTIONS = [procServer, procScan, procMetadata, procFiles, procCatalog, procCaches];

  var processes = {
    title: function () { return t('nav.processes'); },
    render: function (route) {
      var p = cache.processes;
      var running = p && p.tasks ? p.tasks.running : 0;
      if (route && route.param === 'tasks') {
        var td = tasksState().data;
        return '<h1 class="page-title">' + esc(t('nav.processes')) + '</h1>' + procTabs('tasks', td ? td.running.length : running) + tasksTab(p);
      }
      var head = '<h1 class="page-title">' + esc(t('nav.processes')) + '</h1>' + procTabs('overview', running) + '<p class="page-lead">' + esc(t('proc.intro')) + '</p>';
      if (!p) return head + spinner;
      if (p.error) return head + errorBanner(p.error);
      return head + '<div class="cards proc-cards">' + PROC_SECTIONS.map(function (section) {
        var card;
        // One card failing to draw (an older server's answer, say) doesn't take the page with it
        try { card = section(p); } catch (e) { console.error('[processes]', e); return ''; }
        return card ? procCard(card) : '';
      }).join('') + '</div>';
    },
    mount: function (el, route) {
      if (!route || route.param !== 'tasks') return;
      scrollTaskOutputs();
      el.addEventListener('change', function (e) { if (e.target.hasAttribute('data-task-follow')) { tasksState().follow = e.target.checked; scrollTaskOutputs(); } });
    },
    enter: function (route) {
      clearTimeout(procTimer);
      if (route.param === 'tasks') {
        // Live: every 2 seconds while the tab is open
        return loadTasks().then(function () {
          if (location.hash !== route.hash) return;
          A().renderPage();
          procTimer = setTimeout(function () { if (location.hash === route.hash) processes.enter(route); }, 2000);
        });
      }
      load(route.hash, function () {
        return api('GET', '/api/processes').then(function (r) {
          cache.processes = r;
          A().setRestartNeeded(r.server.restartNeeded);
        }, function (e) {
          // An older server answers "not found" for this page's API: it needs a restart to load the new code
          if (e && e.status === 404) e = { code: 'unknownEndpoint', status: 404 };
          cache.processes = { error: e };
          throw e;
        });
      }).then(function () {
        // Live view: refresh every 2 seconds while the page is open
        procTimer = setTimeout(function () { if (location.hash === route.hash) processes.enter(route); }, 2000);
      });
    }
  };

  /* ================= TASKS (Processes → Tasks) and LOGS (admins) ================= */
  // Everything long-running as one list: running tasks with their progress and live output (the end of their
  // log file), and the ones that ended lately. Each task's log is on the Logs page.
  function procTabs(active, running) {
    var tab = function (id, href, ic, label) {
      return '<a class="tab' + (active === id ? ' is-active' : '') + '" href="' + href + '"' + (active === id ? ' aria-current="page"' : '') + '>' + icon(ic) + esc(label) + '</a>';
    };
    return '<nav class="tabs files-tabs" aria-label="' + esc(t('nav.processes')) + '">' +
      tab('overview', '#processes', 'memory', t('proc.tabOverview')) +
      tab('tasks', '#processes/tasks', 'list', running ? t('proc.tabTasksN', { count: running }) : t('proc.tabTasks')) +
      tab('logs', '#logs', 'description', t('nav.logs')) + '</nav>';
  }
  var TASK_ICON = { scan: 'sync', metadata: 'download', files: 'folder_open', crawl: 'travel_explore', covers: 'collections', other: 'memory' };
  var TASK_BADGE = { running: 'badge--primary', done: 'badge--ok', failed: 'badge--danger', stopped: '' };
  function tasksState() { if (!cache.tasks) cache.tasks = { data: null, error: null, open: {}, output: {}, follow: true }; return cache.tasks; }
  function fmtSpan(ms) { return ms == null ? '—' : fmtTime(Math.max(0, ms)); }
  function taskProgressHtml(tk) {
    var p = tk.progress || {};
    var bar = { percent: p.percent != null ? p.percent : null, etaMs: p.etaMs != null ? p.etaMs : null, elapsedMs: Date.now() - Date.parse(tk.startedAt) };
    var detail = p.total ? t('proc.task.doneOf', { done: p.done || 0, total: p.total }) : p.done ? t('proc.task.done', { count: p.done }) : '';
    if (p.detail) detail += (detail ? ' · ' : '') + p.detail;
    if (p.errors) detail += (detail ? ' · ' : '') + t('proc.task.errors', { count: p.errors });
    var phase = p.phase ? (t('proc.task.phase.' + p.phase) !== 'proc.task.phase.' + p.phase ? t('proc.task.phase.' + p.phase) : p.phase) : t('proc.task.working');
    return progressBar(bar, phase, detail) + requestsLine(p.requestsNow);
  }
  function taskOutputHtml(tk, st) {
    var out = st.output[tk.id];
    if (!st.open[tk.id]) return '';
    return '<div class="task-console">' +
      '<div class="task-console__bar"><span class="small muted">' + esc(t('proc.task.output', { name: tk.log })) + '</span>' +
        '<label class="checkbox small"><input type="checkbox" data-task-follow' + (st.follow ? ' checked' : '') + ' /><span>' + esc(t('proc.task.follow')) + '</span></label></div>' +
      '<pre class="task-console__text" id="task-out-' + esc(tk.id) + '" tabindex="0">' + esc(out ? out.join('\n') : t('common.loading')) + '</pre></div>';
  }
  function tasksTab(p) {
    var st = tasksState(), d = st.data;
    if (st.error) return errorBanner(st.error);
    if (!d) return spinner;
    var running = d.running.length ? d.running.map(function (tk) {
      return '<section class="card card--wide task-card" data-task="' + esc(tk.id) + '">' +
        '<div class="proc-card__head"><span class="lib-card__icon">' + icon(TASK_ICON[tk.kind] || 'memory') + '</span>' +
          '<div><h2 class="card__title">' + esc(tk.title) + '</h2><span class="badge ' + TASK_BADGE.running + '">' + esc(t('proc.task.kind.' + tk.kind)) + '</span></div></div>' +
        taskProgressHtml(tk) +
        '<div class="lib-card__actions">' +
          '<button class="btn btn--outline btn--pill" data-lib="task-output" data-id="' + esc(tk.id) + '" aria-expanded="' + (st.open[tk.id] ? 'true' : 'false') + '">' + icon('terminal') + esc(t(st.open[tk.id] ? 'proc.task.hideOutput' : 'proc.task.showOutput')) + '</button>' +
          (tk.canStop ? '<button class="btn btn--outline btn--pill" data-lib="task-stop" data-id="' + esc(tk.id) + '">' + icon('stop') + esc(t('proc.stop')) + '</button>' : '') +
          '<a class="btn btn--text" href="#logs?name=' + encodeURIComponent(tk.log) + '">' + esc(t('proc.task.openLog')) + '</a>' +
        '</div>' + taskOutputHtml(tk, st) +
      '</section>';
    }).join('') : '<p class="muted">' + esc(t('proc.task.none')) + '</p>';
    var recent = d.recent.length ? '<div class="table-wrap"><table class="table task-table"><thead><tr><th>' + esc(t('proc.status')) + '</th><th>' + esc(t('proc.task.what')) + '</th><th>' + esc(t('proc.task.started')) + '</th><th>' + esc(t('proc.task.took')) + '</th><th></th></tr></thead><tbody>' +
      d.recent.map(function (tk) {
        return '<tr><td><span class="badge ' + (TASK_BADGE[tk.status] || '') + '">' + esc(t('proc.task.status.' + tk.status)) + '</span></td>' +
          '<td><strong>' + esc(tk.title) + '</strong>' + (tk.summary ? '<div class="muted small">' + esc(tk.summary) + '</div>' : '') + '</td>' +
          '<td class="small">' + esc(A().fmtDate(tk.startedAt)) + '</td><td class="small">' + esc(fmtSpan(Date.parse(tk.finishedAt) - Date.parse(tk.startedAt))) + '</td>' +
          '<td><a class="btn btn--text btn--small" href="#logs?name=' + encodeURIComponent(tk.log) + '">' + esc(t('proc.task.openLog')) + '</a></td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted small">' + esc(t('proc.task.noneRecent')) + '</p>';
    return '<h2 class="section-title">' + esc(t('proc.task.running', { count: d.running.length })) + '</h2>' + running +
      '<h2 class="section-title">' + esc(t('proc.task.recent')) + '</h2>' + recent +
      '<p class="field__help">' + esc(t('proc.task.help', { days: d.retentionDays })) + ' <a href="#server-settings">' + esc(t('proc.changeInSettings')) + '</a></p>';
  }
  function loadTasks() {
    var st = tasksState();
    return api('GET', '/api/tasks').then(function (r) {
      st.data = r; st.error = null;
      // The output of the tasks whose output is shown
      var ids = r.running.map(function (x) { return x.id; }).filter(function (id) { return st.open[id]; });
      return Promise.all(ids.map(function (id) {
        return api('GET', '/api/tasks/' + encodeURIComponent(id) + '?lines=300').then(function (x) { st.output[id] = x.task.lines; }, function () {});
      }));
    }, function (e) { st.error = e; });
  }
  // Follows a background task until it ends (checked every 2 seconds), then done(task)
  function followTask(id, done) {
    var check = function () {
      api('GET', '/api/tasks/' + encodeURIComponent(id) + '?lines=10').then(function (r) {
        if (r.task.status === 'running') setTimeout(check, 2000); else done(r.task);
      }, function () { /* gone (server restarted): nothing to follow */ });
    };
    setTimeout(check, 1500);
  }
  // After drawing: the shown outputs scrolled to their end (while following)
  function scrollTaskOutputs() {
    if (!tasksState().follow) return;
    Array.prototype.forEach.call(document.querySelectorAll('.task-console__text'), function (pre) { pre.scrollTop = pre.scrollHeight; });
  }

  // Logs page: every task's log file (kept Server settings → logRetentionDays days), shown or downloaded
  function logsState() { if (!cache.logs) cache.logs = { data: null, error: null, kind: '', q: '', view: null }; return cache.logs; }
  function fmtLogSize(n) { return n < 1024 ? n + ' B' : fmtSize(n); }
  function logsList(st) {
    var d = st.data;
    var head = '<div class="toolbar"><label class="search-field">' + icon('search') + '<input type="search" id="logs-q" placeholder="' + esc(t('logs.search')) + '" value="' + esc(st.q) + '" aria-label="' + esc(t('logs.search')) + '" /></label><div class="toolbar__group">' +
      '<select class="select select--compact" id="logs-kind" aria-label="' + esc(t('logs.kind')) + '"><option value="">' + esc(t('logs.allKinds')) + '</option>' +
        ((d && d.kinds) || []).map(function (k) { return '<option value="' + k + '"' + (k === st.kind ? ' selected' : '') + '>' + esc(t('proc.task.kind.' + k)) + '</option>'; }).join('') + '</select>' +
      '</div></div>';
    if (st.error) return head + errorBanner(st.error);
    if (!d) return head + spinner;
    if (!d.logs.length) return head + emptyState('description', t('logs.noneTitle'), t('logs.none'));
    return head + '<div class="table-wrap"><table class="table logs-table"><thead><tr><th>' + esc(t('logs.when')) + '</th><th>' + esc(t('logs.kind')) + '</th><th>' + esc(t('proc.task.what')) + '</th><th>' + esc(t('logs.size')) + '</th><th></th></tr></thead><tbody>' +
      d.logs.map(function (l) {
        return '<tr><td class="small">' + esc(A().fmtDate(l.at)) + '</td><td><span class="badge">' + esc(t('proc.task.kind.' + l.kind)) + '</span>' + (l.running ? ' <span class="badge badge--primary">' + esc(t('proc.task.status.running')) + '</span>' : '') + '</td>' +
          '<td><a href="#logs?name=' + encodeURIComponent(l.name) + '">' + esc(l.title || l.name) + '</a></td><td class="small">' + esc(fmtLogSize(l.size)) + '</td>' +
          '<td class="logs-actions"><a class="btn btn--text btn--small" href="/api/logs/' + encodeURIComponent(l.name) + '?download=1" download="' + esc(l.name) + '">' + icon('download') + esc(t('logs.download')) + '</a>' +
            (l.running ? '' : '<button class="btn btn--text btn--small btn--danger" data-lib="log-delete" data-id="' + esc(l.name) + '">' + esc(t('common.delete')) + '</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function logView(st, name) {
    var v = st.view && st.view.name === name ? st.view : null;
    var item = st.data && st.data.logs.filter(function (l) { return l.name === name; })[0];
    return '<p><a href="#logs">' + icon('arrow_back') + esc(t('logs.back')) + '</a></p>' +
      '<section class="card card--wide"><div class="proc-card__head"><span class="lib-card__icon">' + icon('description') + '</span><div><h2 class="card__title">' + esc((item && item.title) || name) + '</h2>' +
        '<span class="muted small">' + esc(name) + (v ? ' · ' + fmtLogSize(v.size) : '') + '</span></div></div>' +
        '<div class="lib-card__actions"><a class="btn btn--primary btn--pill" href="/api/logs/' + encodeURIComponent(name) + '?download=1" download="' + esc(name) + '">' + icon('download') + esc(t('logs.download')) + '</a></div>' +
        (v && v.error ? errorBanner(v.error) : '<pre class="task-console__text task-console__text--tall" tabindex="0">' + esc(v ? v.lines.join('\n') : t('common.loading')) + '</pre>') +
        (v && v.lines.length >= 2000 ? '<p class="muted small">' + esc(t('logs.lastLines', { count: 2000 })) + '</p>' : '') +
      '</section>';
  }
  var logsPage = {
    title: function () { return t('nav.logs'); },
    render: function (route) {
      var st = logsState(), name = route.query.get('name');
      var head = '<h1 class="page-title">' + esc(t('nav.processes')) + '</h1>' + procTabs('logs', 0) +
        '<p class="page-lead">' + esc(t('logs.intro', { days: (st.data && st.data.retentionDays) || 30 })) + ' <a href="#server-settings">' + esc(t('proc.changeInSettings')) + '</a></p>';
      return head + (name ? logView(st, name) : logsList(st));
    },
    mount: function (el) {
      var st = logsState();
      var q = $('#logs-q', el), kind = $('#logs-kind', el), timer;
      if (q) q.addEventListener('input', function () { st.q = q.value; st.focusQ = true; clearTimeout(timer); timer = setTimeout(function () { logsPage.enter(A().parseRoute()); }, 250); });
      if (q && st.focusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); st.focusQ = false; } // (typing goes on after the list is redrawn)
      if (kind) kind.addEventListener('change', function () { st.kind = kind.value; logsPage.enter(A().parseRoute()); });
      var pre = $('.task-console__text--tall', el);
      if (pre && st.view && st.view.follow !== false) pre.scrollTop = pre.scrollHeight;
    },
    enter: function (route) {
      var st = logsState(), name = route.query.get('name');
      clearTimeout(st.timer);
      var list = api('GET', '/api/logs?' + Store.qs({ kind: st.kind || undefined, q: st.q || undefined })).then(function (r) { st.data = r; st.error = null; }, function (e) { st.error = e; });
      var view = name ? api('GET', '/api/logs/' + encodeURIComponent(name) + '?lines=2000').then(function (r) { st.view = { name: name, lines: r.lines, size: r.size }; }, function (e) { st.view = { name: name, lines: [], error: e }; }) : null;
      return Promise.all([list, view]).then(function () {
        if (A().parseRoute().name !== 'logs') return;
        A().renderPage();
        // A log still being written: shown live
        var item = name && st.data && st.data.logs.filter(function (l) { return l.name === name; })[0];
        if (item && item.running) st.timer = setTimeout(function () { if (location.hash === route.hash) logsPage.enter(route); }, 2000);
      });
    }
  };

  /* ================= SERVER SETTINGS (admins) ================= */
  var SETTINGS_FIELDS = [
    { key: 'scanWorkers', label: 'cfg.scanWorkers', help: 'cfg.scanWorkersHelp' },
    { key: 'scanConcurrency', label: 'cfg.scanConcurrency', help: 'cfg.scanConcurrencyHelp' },
    { key: 'metadataConcurrency', label: 'cfg.metadataConcurrency', help: 'cfg.metadataConcurrencyHelp', section: 'cfg.metadata' },
    { key: 'catalogCrawls', label: 'cfg.catalogCrawls', help: 'cfg.catalogCrawlsHelp', section: 'cfg.catalog' },
    { key: 'catalogConcurrency', label: 'cfg.catalogConcurrency', help: 'cfg.catalogConcurrencyHelp' },
    { key: 'logRetentionDays', label: 'cfg.logRetentionDays', help: 'cfg.logRetentionDaysHelp', section: 'cfg.logs' }
  ];
  var KEY_FIELDS = [
    { key: 'comicVineApiKey', label: 'Comic Vine', help: 'cfg.comicVineHelp', url: 'https://comicvine.gamespot.com/api/' },
    { key: 'googleBooksApiKey', label: 'Google Books', help: 'cfg.googleBooksHelp', url: 'https://developers.google.com/books/docs/v1/using#APIKey' }
  ];
  var serverSettings = {
    title: function () { return t('nav.serverSettings'); },
    render: function () {
      var c = cache.config;
      var head = '<h1 class="page-title">' + esc(t('nav.serverSettings')) + '</h1><p class="page-lead">' + esc(t('cfg.intro')) + '</p>';
      if (!c) return head + spinner;
      if (c.error) return head + errorBanner(c.error);
      return head +
        '<section class="card card--wide"><form class="form" id="config-form" novalidate>' +
          '<h2 class="card__title">' + esc(t('cfg.scanning')) + '</h2>' +
          '<p class="muted small">' + esc(t('cfg.cpus', { count: c.cpus })) + '</p>' +
          SETTINGS_FIELDS.filter(function (f) { return c.schema[f.key]; }).map(function (f) {
            var s = c.schema[f.key];
            return (f.section ? '<h2 class="card__title cfg-section">' + esc(t(f.section)) + '</h2>' : '') + '<div class="field">' +
              '<label for="cfg-' + f.key + '">' + esc(t(f.label)) + '</label>' +
              '<input id="cfg-' + f.key + '" name="' + f.key + '" type="number" inputmode="numeric" min="' + s.min + '" max="' + s.max + '" step="1" value="' + esc(c.values[f.key]) + '" class="input--short" />' +
              '<small class="field__help">' + esc(t(f.help)) + ' ' + esc(t('cfg.range', { min: s.min, max: s.max, def: s.default })) + '</small>' +
            '</div>';
          }).join('') +
          // API keys for metadata providers: never shown again once saved, only whether one is set
          (c.secretsSet ? '<h2 class="card__title cfg-section">' + esc(t('cfg.metadataKeys')) + '</h2>' +
            '<p class="muted small">' + esc(t('cfg.metadataKeysIntro')) + '</p>' +
            KEY_FIELDS.filter(function (f) { return f.key in c.secretsSet; }).map(function (f) {
              var set = c.secretsSet[f.key];
              return '<div class="field">' +
                '<label for="cfg-' + f.key + '">' + esc(f.label) + ' ' + (set ? '<span class="badge badge--ok">' + esc(t('cfg.keySet')) + '</span>' : '<span class="badge">' + esc(t('cfg.keyNotSet')) + '</span>') + '</label>' +
                '<div class="folder-input"><input id="cfg-' + f.key + '" name="' + f.key + '" type="password" autocomplete="off" spellcheck="false" placeholder="' + esc(t(set ? 'cfg.keyKeep' : 'cfg.keyPaste')) + '" />' +
                (set ? '<button type="button" class="btn btn--text btn--danger" data-lib="config-clear-key" data-key="' + f.key + '">' + esc(t('cfg.keyRemove')) + '</button>' : '') + '</div>' +
                '<small class="field__help">' + esc(t(f.help)) + ' <a href="' + f.url + '" target="_blank" rel="noopener noreferrer">' + esc(f.url.replace(/^https:\/\//, '')) + '</a></small>' +
              '</div>';
            }).join('') : '') +
          '<p class="form__error" id="config-error" role="alert" hidden></p>' +
          '<div class="form__actions">' +
            '<button type="button" class="btn btn--text" data-lib="config-defaults">' + esc(t('cfg.defaults')) + '</button>' +
            '<button type="submit" class="btn btn--primary">' + esc(t('common.save')) + '</button>' +
          '</div>' +
        '</form></section>';
    },
    mount: function (el) {
      var form = $('#config-form', el);
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var patch = {};
        SETTINGS_FIELDS.forEach(function (f) { if (form.elements[f.key]) patch[f.key] = Number(form.elements[f.key].value); });
        // Empty key field = keep the saved key
        KEY_FIELDS.forEach(function (f) { var el = form.elements[f.key]; if (el && el.value.trim()) patch[f.key] = el.value.trim(); });
        api('PATCH', '/api/config', patch).then(function (r) {
          cache.config = r;
          providersCache = null; // which providers have keys may have changed
          A().toast(t('cfg.saved'));
          A().renderPage();
        }, function (err) {
          var box = $('#config-error');
          box.textContent = err.code === 'invalid' && err.message ? err.message : A().errMsg(err);
          box.hidden = false;
        });
      });
    },
    enter: function (route) {
      load(route.hash, function () {
        return api('GET', '/api/config').then(function (r) { cache.config = r; }, function (e) {
          if (e && e.status === 404) e = { code: 'unknownEndpoint', status: 404 }; // older server
          cache.config = { error: e };
          throw e;
        });
      }, function () { return cache.config; });
    }
  };

  // After "Restart server": wait for it to go away and come back, then reload the page
  function waitForServerRestart() {
    cache.serverRestarting = true;
    A().renderPage();
    // The built-in supervisor brings the server back in about a second, often between two checks, so a
    // new server process ID also counts as "restarted"
    var oldPid = cache.processes && cache.processes.server ? cache.processes.server.pid : null;
    var sawDown = false, tries = 0;
    (function poll() {
      tries++;
      fetch('/api/processes', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) return { ok: r.status < 500 };
        return r.json().then(function (d) { return { ok: true, pid: d.server && d.server.pid }; });
      }).then(function (x) {
        if (x.ok && (sawDown || (x.pid && oldPid && x.pid !== oldPid) || tries > 20)) return location.reload();
        setTimeout(poll, 500);
      }, function () { sawDown = true; setTimeout(poll, 500); });
    })();
  }

  /* ================= FORM DIALOG ================= */
  var formState = null;
  function openForm(opts) {
    formState = opts;
    $('#form-dialog-title').textContent = opts.title;
    $('#form-dialog-submit').textContent = opts.submitLabel || t('common.save');
    $('#form-dialog-error').hidden = true;
    $('#form-dialog-fields').innerHTML = opts.fields.map(function (f) {
      var id = 'fd-' + f.name;
      var input;
      if (f.type === 'textarea') input = '<textarea id="' + id + '" name="' + f.name + '" rows="' + (f.rows || 4) + '">' + esc(f.value || '') + '</textarea>';
      else if (f.type === 'select') input = '<select class="select" id="' + id + '" name="' + f.name + '">' + f.options.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value || '') ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
      else if (f.type === 'folder') input = '<div class="folder-input"><input id="' + id + '" name="' + f.name + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '" spellcheck="false" />' +
        '<button type="button" class="btn btn--outline" data-fd="browse">' + icon('folder_open') + esc(t('manage.browse')) + '</button></div>' +
        '<div class="folder-browser" id="folder-browser" hidden></div>';
      else if (f.type === 'covers') {
        // Cover picker: thumbnails of every available image (filled in by loadCoverPicker) + upload
        return '<div class="field" data-field="' + f.name + '"><span class="field__label">' + esc(f.label) + '</span>' +
          '<div class="cover-picker" id="cover-picker" role="radiogroup" aria-label="' + esc(f.label) + '">' + spinner + '</div>' +
          '<input type="hidden" name="' + f.name + '" value="" />' +
          '<div class="cover-picker__actions"><label class="btn btn--outline btn--small cover-picker__upload">' + icon('add') + esc(t('cover.upload')) +
            '<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="cover-upload" hidden /></label></div>' +
          (f.help ? '<small class="field__help">' + esc(f.help) + '</small>' : '') + '</div>';
      }
      else if (f.type === 'providers') {
        // Ordered list: checkbox = use it; arrows = priority (the first match fills each field)
        return '<div class="field" data-field="' + f.name + '"><span class="field__label">' + esc(f.label) + '</span>' +
          '<ol class="prov-list" data-providers="' + f.name + '">' + f.value.map(providerRow).join('') + '</ol>' +
          (f.help ? '<small class="field__help">' + esc(f.help) + '</small>' : '') + '</div>';
      }
      else if (f.type === 'checkbox') {
        return '<div class="field" data-field="' + f.name + '"' + (f.showWhen ? ' data-show-when="' + esc(JSON.stringify(f.showWhen)) + '"' : '') + '><label class="checkbox"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (f.value ? ' checked' : '') + ' />' +
          '<span>' + esc(f.label) + '</span></label>' + (f.help ? '<small class="field__help">' + esc(f.help) + '</small>' : '') + '</div>';
      }
      else input = '<input id="' + id + '" name="' + f.name + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '"' + (f.type === 'date' ? ' type="text" inputmode="numeric"' : '') + ' />';
      return '<div class="field" data-field="' + f.name + '"' + (f.showWhen ? ' data-show-when="' + esc(JSON.stringify(f.showWhen)) + '"' : '') + '>' +
        '<label for="' + id + '">' + esc(f.label) + '</label>' + input + (f.help ? '<small class="field__help">' + esc(f.help) + '</small>' : '') + '</div>';
    }).join('') + (opts.note ? '<p class="field__help">' + esc(opts.note) + '</p>' : '');
    renderIcons($('#form-dialog-fields'));
    syncShowWhen();
    $('#form-dialog').showModal();
    var first = $('#form-dialog-fields input, #form-dialog-fields select, #form-dialog-fields textarea');
    if (first) first.focus();
  }
  function formValues() {
    var v = {};
    $$('#form-dialog-fields [name]').forEach(function (el) { v[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    $$('#form-dialog-fields [data-providers]').forEach(function (list) {
      v[list.dataset.providers] = $$('.prov-item', list).map(function (li) { return { id: li.dataset.id, enabled: $('input', li).checked }; });
    });
    return v;
  }
  function syncShowWhen() {
    var v = formValues();
    $$('#form-dialog-fields [data-show-when]').forEach(function (el) {
      // One condition { field, value (or list of values) }, or a list of them that must all hold
      var conds = [].concat(JSON.parse(el.dataset.showWhen));
      el.hidden = !conds.every(function (w) { return Array.isArray(w.value) ? w.value.indexOf(v[w.field]) !== -1 : v[w.field] === w.value; });
    });
  }
  function formError(err) {
    $('#form-dialog-error').textContent = typeof err === 'string' ? err : A().errMsg(err);
    $('#form-dialog-error').hidden = false;
  }

  // Server folder browser inside the dialog (headless servers have no file picker)
  function browseFolders(p) {
    var box = $('#folder-browser');
    box.hidden = false;
    box.innerHTML = spinner;
    api('GET', '/api/fs?path=' + encodeURIComponent(p || '')).then(function (r) {
      box.innerHTML =
        '<div class="folder-browser__head">' +
          (r.parent !== null ? '<button type="button" class="icon-btn icon-btn--sm" data-fd="up" data-path="' + esc(r.parent) + '" data-icon="arrow_upward" title="' + esc(t('manage.up')) + '" aria-label="' + esc(t('manage.up')) + '"></button>' : '') +
          '<code class="folder-browser__path">' + esc(r.path || t('manage.drives')) + '</code>' +
          (r.path ? '<button type="button" class="btn btn--primary btn--small" data-fd="use" data-path="' + esc(r.path) + '">' + esc(t('manage.useFolder')) + '</button>' : '') +
        '</div>' +
        (r.books ? '<p class="small folder-browser__hint">' + esc(t('manage.booksHere', { count: r.books })) + '</p>' : '') +
        '<ul class="folder-browser__list">' + (r.dirs.length ? r.dirs.map(function (d) {
          return '<li><button type="button" class="folder-browser__item" data-fd="open" data-path="' + esc(d.path) + '">' + icon('folder') + '<span>' + esc(d.name) + '</span></button></li>';
        }).join('') : '<li class="muted small folder-browser__empty">' + esc(t('manage.noFolders')) + '</li>') + '</ul>';
      renderIcons(box);
    }, function (e) { box.innerHTML = '<p class="notice notice--error">' + esc(A().errMsg(e)) + '</p>'; });
  }

  /* ================= ACTIONS ================= */
  function invalidate() {
    markStale(cache.home); markStale(cache.search); markStale(cache.collections); markStale(cache.readlists);
    markStale(cache.collection); markStale(cache.readlist); markStale(cache.msrc); markStale(cache.facets);
    // Library pages keep their search, sort, filters and loaded works (for going back); they reload on entry
    Object.keys(cache.libs).forEach(function (k) { cache.libs[k].stale = true; });
  }
  function refreshCurrent() {
    var route = A().parseRoute();
    if (LibraryPages[route.name] && LibraryPages[route.name].enter) LibraryPages[route.name].enter(route);
  }
  function fail(e) { A().toast(A().errMsg(e)); }

  // Delete a work: hide it (can be restored) or delete its files from disk (typed title to confirm)
  function deleteWork(id) {
    var d = cache.series[id];
    if (!d || !d.series) return;
    var s = d.series, title = s.title, versions = (d.editions || []).length;
    var fields = [
      { name: 'mode', label: t('del.how'), type: 'select', value: 'hide',
        options: [{ value: 'hide', label: t('del.modeHide') }, { value: 'files', label: t('del.modeFiles') }] }
    ];
    if (versions > 1) fields.push({ name: 'scope', label: t('del.scope'), type: 'select', value: 'version',
      options: [{ value: 'version', label: t('del.scopeVersion', { version: editionLabel(s.edition) }) }, { value: 'work', label: t('del.scopeWork', { count: versions }) }] });
    fields.push({ name: 'confirm', label: t('del.confirmLabel', { title: title }), placeholder: title, help: t('del.filesWarning'), showWhen: { field: 'mode', value: 'files' } });
    openForm({
      title: t('del.title', { title: title }),
      submitLabel: t('del.button'),
      note: t('del.hideNote'),
      fields: fields,
      onSubmit: function (v) {
        if (v.mode === 'files' && v.confirm.trim().toLowerCase() !== title.trim().toLowerCase()) return Promise.reject({ code: 'confirmMismatch' });
        return api('POST', '/api/series/' + id + '/delete', { mode: v.mode, scope: v.scope || 'version', confirm: v.confirm }).then(function (r) {
          if (r.failed && r.failed.length) {
            A().toast(t('del.someFailed', { count: r.failed.length, error: r.failed[0].error }));
          } else A().toast(t(v.mode === 'files' ? 'del.filesDone' : 'del.hidden', { title: title }));
          invalidate(); markStale(cache.series); A().refreshLibraries();
          if (r.failed && r.failed.length && r.deletedWorks === 0) return refreshCurrent();
          location.hash = '#library/' + s.libraryId;
        });
      }
    });
  }

  // The library's default chapter layout (known to admins from the libraries list)
  function libraryDefaultsOf(s) {
    var l = (cache.manage && cache.manage.libraries || []).concat(A().state.libraries || []).filter(function (x) { return x.id === s.libraryId && x.defaults; })[0];
    return (l && l.defaults) || {};
  }
  function libraryLayoutOf(s) { return libraryDefaultsOf(s).bookLayout || 'tiles'; }
  // "From AniList", "From the files (ComicInfo.xml)", "Your edit", … for a field of the work's Edit dialog
  function sourceHint(s, k) {
    var f = s.fieldSources && s.fieldSources[k];
    if (!f) return '';
    return f.kind === 'edit' ? t('src.edit') : f.kind === 'folder' ? t('src.folder', { name: f.name }) : f.kind === 'files' ? t('src.files')
      : f.kind === 'online' ? t('src.online', { name: String(f.name || '').split(',').map(providerName).join(', ') }) : f.kind === 'books' ? t('src.books') : '';
  }
  function editSeries(id) {
    var s = cache.series[id].series, o = s.overrides || {};
    var dir = function (v) { return { value: v, label: t('series.direction.' + v) }; };
    // The form opens with the values the work has now (its own edits, the folder sources, ComicInfo.xml or
    // the matched online metadata); only fields that are changed are saved, so the rest keep following
    // their source. Clearing a field goes back to the automatic value.
    var names = [];
    (s.authors || []).forEach(function (a) { if (names.indexOf(a.name) === -1) names.push(a.name); });
    var current = {
      title: s.title || '', sortTitle: s.sortTitle && s.sortTitle !== s.title ? s.sortTitle : '', summary: s.summary || '', publisher: s.publisher || '',
      year: s.year ? String(s.year) : '', genres: (s.genres || []).join(', '), tags: (s.tags || []).join(', '),
      altTitles: (s.altTitles || []).join('\n'), authors: names.join(', '), links: (s.links || []).map(function (l) { return l.url; }).join('\n')
    };
    var withHint = function (k, help) { var h = sourceHint(s, k); return [h, help].filter(Boolean).join(' · '); };
    var autoLabel = function (shown) { return t('edit.auto') + (shown ? ' (' + shown + ')' : ''); };
    openForm({
      title: t('edit.seriesTitle'),
      note: t('edit.prefilledNote'),
      fields: [
        { name: 'title', label: t('edit.title'), value: current.title, help: withHint('title') },
        { name: 'sortTitle', label: t('edit.sortTitle'), value: current.sortTitle, placeholder: s.title },
        { name: 'altTitles', label: t('edit.altTitles'), type: 'textarea', rows: 2, value: current.altTitles, help: withHint('altTitles', t('edit.onePerLine')) },
        { name: 'summary', label: t('edit.summary'), type: 'textarea', rows: 5, value: current.summary, help: withHint('summary') },
        { name: 'authors', label: t('edit.authors'), value: current.authors, help: withHint('authors', t('edit.commas')) },
        { name: 'year', label: t('edit.year'), value: current.year, help: withHint('year') },
        { name: 'status', label: t('edit.status'), type: 'select', value: o.status || '', help: withHint('status'),
          options: [{ value: '', label: autoLabel(s.status && s.status !== 'unknown' ? t('series.status.' + s.status) : '') }].concat(['ongoing', 'ended', 'hiatus', 'abandoned'].map(function (v) { return { value: v, label: t('series.status.' + v) }; })) },
        { name: 'publisher', label: t('edit.publisher'), value: current.publisher, help: withHint('publisher') },
        { name: 'type', label: t('meta.type'), type: 'select', value: o.type || '', help: withHint('type'),
          options: [{ value: '', label: autoLabel(!o.type && s.type ? t('type.' + s.type) : '') }].concat(WORK_TYPES.map(function (ty) { return { value: ty, label: t('type.' + ty) }; })) },
        { name: 'genres', label: t('edit.genres'), value: current.genres, help: withHint('genres', t('edit.commas')) },
        { name: 'tags', label: t('edit.tags'), value: current.tags, help: withHint('tags', t('edit.tagsHelp')) },
        { name: 'links', label: t('edit.links'), type: 'textarea', rows: 3, value: current.links, help: withHint('links', t('edit.linksHelp')) },
        { name: 'coverChoice', label: t('edit.cover'), type: 'covers', help: t('cover.help') },
        // Reading mode: blank = the library's default (a fixed mode) or, if it has none, what was detected
        { name: 'readingDirection', label: t('edit.direction'), type: 'select', value: o.readingDirection || '', help: t('edit.directionHelp'),
          options: [{ value: '', label: s.libraryDirection
            ? t('edit.libraryDefault', { value: t('series.direction.' + s.libraryDirection) })
            : t('edit.autoDetected', { value: t('series.direction.' + (s.detectedDirection || 'ltr')) }) }, dir('ltr'), dir('rtl'), dir('vertical')] },
        { name: 'bookLayout', label: t('layout.label'), type: 'select', value: o.bookLayout || '',
          options: [{ value: '', label: t('edit.libraryDefault', { value: t('layout.' + (o.bookLayout ? libraryLayoutOf(s) : s.bookLayout)) }) },
            { value: 'tiles', label: t('layout.tiles') }, { value: 'list', label: t('layout.list') }] },
        { name: 'bookOrder', label: t('order.label'), type: 'select', value: o.bookOrder || '',
          options: [{ value: '', label: t('edit.libraryDefault', { value: t('order.' + (libraryDefaultsOf(s).bookOrder || 'asc')) }) },
            { value: 'asc', label: t('order.asc') }, { value: 'desc', label: t('order.desc') }] },
        { name: 'edition', label: t('edit.edition'), type: 'select', value: o.edition || '', help: t('edit.editionHelp'),
          options: [{ value: '', label: t('edit.auto') + (o.edition ? '' : ' (' + editionLabel(s.edition) + ')') }].concat(['base', 'colored', 'raw', 'uncensored', 'animated'].map(function (e) { return { value: e, label: editionLabel(e) }; })) }
      ],
      onSubmit: function (v) {
        // Only what changed: text fields against the values the form opened with, selects against their start
        var patch = {};
        Object.keys(current).forEach(function (k) { if (k in v && v[k] !== current[k].trim()) patch[k] = v[k]; });
        ['status', 'type', 'readingDirection', 'bookLayout', 'bookOrder', 'edition'].forEach(function (k) { if (k in v && v[k] !== (o[k] || '')) patch[k] = v[k]; });
        var coverPick = v.coverChoice && v.coverChoice !== coverStart.current ? v.coverChoice : '';
        var steps = Object.keys(patch).length ? api('PATCH', '/api/series/' + id, patch) : Promise.resolve();
        return steps.then(function () {
          if (!coverPick) return;
          return api('POST', '/api/series/' + id + '/cover', coverPick === 'upload' ? { upload: pendingUpload } : { choice: coverPick });
        }).then(function () { pendingUpload = null; invalidate(); markStale(cache.series); A().toast(t('edit.saved')); refreshCurrent(); });
      }
    });
    loadCoverPicker(s);
  }

  /* Cover picker (work Edit dialog) */
  var coverStart = { current: 'auto' }, pendingUpload = null;
  function coverPreview(s, c) {
    if (c.kind === 'auto') return '';
    if (c.kind === 'file') return '/api/books/' + c.bookId + '/thumbnail';
    if (c.kind === 'upload') return pendingUpload;
    return '/api/series/' + s.id + '/cover-candidate?id=' + encodeURIComponent(c.id) + '&v=' + (s.coverV || 0);
  }
  function coverCaption(c) {
    return c.kind === 'auto' ? t('cover.auto') : c.kind === 'file' ? t('cover.firstPage')
      : c.kind === 'downloaded' ? (c.provider ? t('cover.downloaded', { name: providerName(c.provider) }) : t('cover.downloadedPlain'))
      : c.kind === 'online' ? (/^web:/.test(c.provider) ? c.provider.slice(4) : providerName(c.provider))
      : c.kind === 'local' ? c.sourceName + ' · ' + c.rel : c.kind === 'custom' ? t('cover.custom') : t('cover.uploaded');
  }
  function renderCoverPicker(s, list, selected) {
    var box = $('#cover-picker');
    if (!box) return;
    box.innerHTML = list.map(function (c) {
      var src = coverPreview(s, c);
      return '<button type="button" class="cover-pick' + (c.id === selected ? ' is-selected' : '') + '" role="radio" aria-checked="' + (c.id === selected) + '" data-pick="' + esc(c.id) + '" title="' + esc(coverCaption(c)) + '">' +
        // Each preview shows a spinner until it's there, or "not available" if the site doesn't send it
        '<span class="cover-pick__img' + (src ? ' is-loading' : '') + '">' + (src ? '<img alt="" loading="lazy" referrerpolicy="no-referrer" src="' + esc(src) + '" onload="this.parentNode.classList.remove(\'is-loading\')" onerror="this.parentNode.classList.remove(\'is-loading\');this.parentNode.classList.add(\'is-failed\');this.remove()" />' : icon('sync')) +
          (src ? '<span class="cover-pick__state">' + esc(t('cover.unavailable')) + '</span>' : '') + '</span>' +
        '<span class="cover-pick__label">' + esc(coverCaption(c)) + '</span></button>';
    }).join('');
    renderIcons(box);
    var input = $('#form-dialog-fields input[name="coverChoice"]');
    if (input) input.value = selected;
  }
  // The candidates at once; then, when it's due (once a week per work, or when asked), a short search of the
  // online sites for more, shown with a line under the picker that can also start it again
  function searchMoreCoversUi(s, force) {
    var box = $('#cover-picker');
    if (!box) return;
    var line = $('#cover-more') || (function () { var p = document.createElement('p'); p.id = 'cover-more'; p.className = 'muted small cover-picker__more'; box.after(p); return p; })();
    line.innerHTML = '<span class="spinner spinner--sm"></span> ' + esc(t('cover.searching'));
    return api('GET', '/api/series/' + s.id + '/covers?search=1' + (force ? '&force=1' : '')).then(function (r2) {
      if (coverStart.series !== s || !$('#cover-picker')) return;
      var input = $('#form-dialog-fields input[name="coverChoice"]');
      var before = coverStart.list.length;
      coverStart.list = r2.candidates;
      pickCover(input && input.value ? input.value : r2.current);
      searchedLine(s, r2.searchedAt, force ? r2.candidates.length - before : null);
    }, function () { searchedLine(s, null, null); });
  }
  function searchedLine(s, at, added) {
    var line = $('#cover-more');
    if (!line) return;
    line.innerHTML = esc(added != null ? t('cover.searchedNow', { count: Math.max(0, added) }) : at ? t('cover.searchedAt', { time: A().fmtDate(at) }) : t('cover.searchFailed')) +
      ' <button type="button" class="btn btn--text btn--small" data-fd="cover-search">' + esc(t('cover.searchAgain')) + '</button>';
    var b = $('[data-fd="cover-search"]', line);
    if (b) b.addEventListener('click', function () { searchMoreCoversUi(s, true); });
  }
  function loadCoverPicker(s) {
    pendingUpload = null;
    api('GET', '/api/series/' + s.id + '/covers').then(function (r) {
      coverStart = { current: r.current, list: r.candidates, series: s };
      renderCoverPicker(s, r.candidates, r.current);
      var due = !r.searchedAt || Date.now() - Date.parse(r.searchedAt) > 7 * 86400000;
      if (due) return searchMoreCoversUi(s, false);
      var box = $('#cover-picker'), p = document.createElement('p');
      p.id = 'cover-more'; p.className = 'muted small cover-picker__more';
      if (box) box.after(p);
      searchedLine(s, r.searchedAt, null);
    }, function (e) { var box = $('#cover-picker'); if (box) box.innerHTML = '<p class="notice notice--error small">' + esc(A().errMsg(e)) + '</p>'; });
  }
  function pickCover(id) {
    if (!coverStart.list) return;
    var list = coverStart.list.concat(pendingUpload ? [{ id: 'upload', kind: 'upload' }] : []);
    renderCoverPicker(coverStart.series, list, id);
  }
  // An uploaded image is scaled down in the browser (longest side 1600 px) and sent with Save
  function readCoverFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        pendingUpload = file.type === 'image/png' && file.size < 2 * 1024 * 1024 && scale === 1 ? reader.result : canvas.toDataURL('image/jpeg', 0.9);
        pickCover('upload');
      };
      img.onerror = function () { formError(t('err.notAnImage')); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function editBook(id) {
    var b = cache.book[id].book, o = b.overrides || {};
    openForm({
      title: t('edit.bookTitle'),
      note: t('edit.blankKeeps'),
      fields: [
        { name: 'title', label: t('edit.title'), value: o.title || '', placeholder: b.title },
        { name: 'number', label: t('edit.number'), value: o.number || '', placeholder: b.number },
        { name: 'releaseDate', label: t('edit.releaseDate'), type: 'date', value: o.releaseDate || '', placeholder: b.releaseDate || '2024-03-15' },
        { name: 'summary', label: t('edit.summary'), type: 'textarea', value: o.summary || '', placeholder: b.summary }
      ],
      onSubmit: function (v) {
        return api('PATCH', '/api/books/' + id, v).then(function () { invalidate(); markStale(cache.series); A().toast(t('edit.saved')); refreshCurrent(); });
      }
    });
  }

  // Add a series to a collection / a book to a read list (existing one, or create a new one)
  function addTo(kind, itemId) {
    var isColl = kind === 'collection';
    var listUrl = isColl ? '/api/collections' : '/api/readlists';
    api('GET', listUrl).then(function (r) {
      var lists = isColl ? r.collections : r.readlists;
      var NEW = '__new';
      openForm({
        title: t(isColl ? 'series.addToCollection' : 'book.addToReadlist'),
        submitLabel: t('common.add'),
        fields: [
          { name: 'target', label: t(isColl ? 'coll.choose' : 'rl.choose'), type: 'select', value: lists.length ? lists[0].id : NEW,
            options: lists.map(function (l) { return { value: l.id, label: l.name }; }).concat([{ value: NEW, label: t(isColl ? 'coll.createNew' : 'rl.createNew') }]) },
          { name: 'name', label: t(isColl ? 'coll.newName' : 'rl.newName'), showWhen: { field: 'target', value: NEW } }
        ],
        onSubmit: function (v) {
          var add = {}; add[isColl ? 'addSeriesIds' : 'addBookIds'] = [itemId];
          var req;
          if (v.target === NEW) {
            if (!v.name) return Promise.reject({ code: 'nameRequired' });
            var body = { name: v.name }; body[isColl ? 'seriesIds' : 'bookIds'] = [itemId];
            req = api('POST', listUrl, body);
          } else {
            req = api('PATCH', listUrl + '/' + v.target, add);
          }
          return req.then(function (res) {
            var name = (res.collection || res.readlist).name;
            invalidate(); markStale(cache.series); markStale(cache.book);
            A().toast(t(isColl ? 'coll.added' : 'rl.added', { name: name }));
            refreshCurrent();
          });
        }
      });
    }, fail);
  }

  /* ================= IDENTIFY DIALOG ================= */
  var identifyFor = null, identifyPicks = {};
  function openIdentify(id) {
    var d = cache.series[id];
    if (!d || !d.series) return;
    identifyFor = id;
    // Start from the matches picked by hand before, so another site can be added to them
    identifyPicks = {};
    ((d.series.metadata && d.series.metadata.locked) || []).forEach(function (l) { identifyPicks[l.provider] = { provider: l.provider, id: l.id, title: '' }; });
    var lib = (A().state.libraries || []).filter(function (l) { return l.id === d.series.libraryId; })[0];
    loadProviders().then(function (all) {
      var order = libraryProviders(lib, all).filter(function (p) { return p.kind !== 'folder'; }); // Identify searches online sites
      $('#identify-provider').innerHTML = '<option value="">' + esc(t('meta.allEnabled')) + '</option>' +
        order.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.needsKey && !p.keySet ? ' disabled' : '') + '>' + esc(p.name) + '</option>'; }).join('');
      $('#identify-q').value = d.workTitle || d.series.title;
      $('#identify-error').hidden = true;
      $('#identify-results').innerHTML = '';
      $('#identify-dialog').showModal();
      updateIdentifyPicks();
      searchIdentify();
    });
  }
  function searchIdentify() {
    var box = $('#identify-results');
    var id = identifyFor;
    box.innerHTML = spinner;
    $('#identify-error').hidden = true;
    api('GET', '/api/series/' + id + '/metadata/search?' + Store.qs({ q: $('#identify-q').value.trim(), provider: $('#identify-provider').value })).then(function (r) {
      if (identifyFor !== id) return;
      box.innerHTML = (r.errors.length ? '<p class="notice small">' + esc(r.errors.join('; ')) + '</p>' : '') +
        (r.results.length ? '<ul class="identify__list">' + r.results.map(function (x) {
          return '<li class="identify__item">' +
            '<div class="identify__cover">' + (x.cover ? '<img alt="" loading="lazy" referrerpolicy="no-referrer" src="' + esc(x.cover) + '" />' : '') + '</div>' +
            '<div class="identify__text"><strong>' + esc(x.title) + '</strong>' +
              '<span class="muted small">' + esc([x.providerName, x.type ? t('type.' + x.type) : '', x.year || ''].filter(Boolean).join(' · ')) + '</span>' +
              (x.altTitles && x.altTitles.length ? '<span class="muted small identify__alt">' + esc(x.altTitles.slice(0, 3).join(' · ')) + '</span>' : '') +
              (x.url ? '<a class="small" href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t('meta.openSite')) + '</a>' : '') +
            '</div>' +
            '<button type="button" class="btn btn--outline btn--small identify__pick" data-identify="' + esc(x.provider) + '" data-mid="' + esc(x.id) + '" data-title="' + esc(x.title) + '" aria-pressed="false">' + esc(t('meta.select')) + '</button>' +
          '</li>';
        }).join('') + '</ul>' : '<p class="muted">' + esc(t('meta.noResults')) + '</p>');
      updateIdentifyPicks();
    }, function (e) { box.innerHTML = ''; $('#identify-error').textContent = A().errMsg(e); $('#identify-error').hidden = false; });
  }

  // Show which results are picked (one per site) and how many will be applied
  function updateIdentifyPicks() {
    $$('#identify-results [data-identify]').forEach(function (b) {
      var on = identifyPicks[b.dataset.identify] && identifyPicks[b.dataset.identify].id === b.dataset.mid;
      b.classList.toggle('is-selected', Boolean(on));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = t(on ? 'meta.selected' : 'meta.select');
      b.closest('.identify__item').classList.toggle('is-selected', Boolean(on));
    });
    var n = Object.keys(identifyPicks).length;
    var btn = $('#identify-apply');
    btn.disabled = !n;
    btn.textContent = t('meta.useSelected', { count: n });
    $('#identify-picked').textContent = n ? t('meta.picked', { names: Object.keys(identifyPicks).map(providerName).join(', ') }) : '';
  }

  // One-shot settings of a library; a server that doesn't send them uses the default (on, library folder)
  function oneshotsOf(l) {
    var o = (l && l.oneshots) || {};
    return { folder: o.enabled === false ? '' : (o.folder || '') };
  }

  // The metadata providers (fetched once): names, kinds of works, API key needs
  var providersCache = null;
  function loadProviders() {
    if (providersCache) return Promise.resolve(providersCache);
    return api('GET', '/api/metadata/providers').then(function (r) { providersCache = r.providers; return providersCache; }, function () { return []; });
  }
  // A library's order and on/off for every provider (defaults for a new library or an older server)
  function libraryProviders(lib, all) {
    var saved = (lib && lib.metadata && lib.metadata.providers) || [];
    var seen = {};
    var list = saved.filter(function (p) { return all.some(function (x) { return x.id === p.id; }); }).map(function (p) { seen[p.id] = true; return { id: p.id, enabled: p.enabled !== false }; });
    all.forEach(function (p) { if (!seen[p.id]) list.push({ id: p.id, enabled: p.defaultOn }); });
    return list.map(function (p) { return Object.assign({}, all.filter(function (x) { return x.id === p.id; })[0], p); });
  }
  function providerRow(p) {
    var keyNote = p.needsKey && !p.keySet ? t('meta.needsKey') : p.optionalKey && !p.keySet ? t('meta.optionalKey') : '';
    var folder = p.kind === 'folder';
    return '<li class="prov-item' + (folder ? ' prov-item--folder' : '') + '" data-id="' + esc(p.id) + '">' +
      '<label class="checkbox prov-item__check"><input type="checkbox"' + (p.enabled ? ' checked' : '') + ' aria-label="' + esc(p.name) + '" />' +
        '<span><strong>' + (folder ? icon('description') + ' ' : '') + esc(p.name) + '</strong>' +
        '<span class="prov-item__types">' + (folder ? esc(t('msrc.folderSourceNote', { folder: p.folder })) : p.types.map(function (ty) { return esc(t('type.' + ty)); }).join(', ')) + '</span>' +
        (keyNote ? '<span class="prov-item__note">' + esc(keyNote) + '</span>' : '') + '</span></label>' +
      '<span class="prov-item__move">' +
        '<button type="button" class="icon-btn icon-btn--sm" data-fd="prov-up" data-icon="arrow_upward" title="' + esc(t('meta.moveUp')) + '" aria-label="' + esc(t('meta.moveUp')) + '"></button>' +
        '<button type="button" class="icon-btn icon-btn--sm" data-fd="prov-down" data-icon="arrow_downward" title="' + esc(t('meta.moveDown')) + '" aria-label="' + esc(t('meta.moveDown')) + '"></button>' +
      '</span></li>';
  }

  function libraryForm(lib) {
    loadProviders().then(function (all) { libraryFormWith(lib, all); });
  }
  function libraryFormWith(lib, all) {
    var md = (lib && lib.metadata) || {};
    var metaFields = all.length ? [
      { name: 'metaProviders', label: t('meta.providers'), type: 'providers', value: libraryProviders(lib, all), help: t('meta.providersHelp') },
      { name: 'metaAutoFetch', label: t('meta.autoFetch'), type: 'checkbox', value: md.autoFetch !== false, help: t('meta.autoFetchHelp') },
      { name: 'metaCover', label: t('meta.cover'), type: 'select', value: md.cover || 'missing', help: t('meta.coverHelp'),
        options: ['missing', 'always', 'never'].map(function (v) { return { value: v, label: t('meta.cover.' + v) }; }) }
    ] : [];
    // Defaults for the library's works (each work can override them in its Edit dialog)
    var d = (lib && lib.defaults) || {};
    var dir = function (v) { return { value: v, label: t('series.direction.' + v) }; };
    var defaultFields = [
      { name: 'defSort', label: t('manage.defaultSort'), type: 'select', value: d.sort || 'title', help: t('manage.defaultSortHelp'),
        options: [{ value: 'title', label: t('lib.sortTitle') }, { value: 'added', label: t('lib.sortAdded') }, { value: 'updated', label: t('lib.sortUpdated') }, { value: 'rating', label: t('lib.sortRating') }] },
      { name: 'defBookOrder', label: t('order.libraryLabel'), type: 'select', value: d.bookOrder || 'asc', help: t('order.help'),
        options: [{ value: 'asc', label: t('order.asc') }, { value: 'desc', label: t('order.desc') }] },
      { name: 'defLayout', label: t('layout.libraryLabel'), type: 'select', value: d.bookLayout || 'tiles', help: t('layout.help'),
        options: [{ value: 'tiles', label: t('layout.tiles') }, { value: 'list', label: t('layout.list') }] },
      { name: 'defDirection', label: t('manage.defaultDirection'), type: 'select', value: d.readingDirection || '', help: t('manage.defaultDirectionHelp'),
        options: [{ value: '', label: t('manage.directionAuto') }, dir('ltr'), dir('rtl'), dir('vertical')] }
    ];
    openForm({
      title: t(lib ? 'manage.edit' : 'manage.add'),
      submitLabel: lib ? t('common.save') : t('manage.add'),
      fields: [
        { name: 'name', label: t('manage.name'), value: lib ? lib.name : '', placeholder: 'Comics' },
        { name: 'root', label: t('manage.folder'), type: 'folder', value: lib ? lib.root : '', placeholder: '/media/comics' },
        // One-shots: on by default, using the library folder itself
        // Files directly in the library folder are always individual works; optionally one more folder
        { name: 'oneshotsFolder', label: t('manage.oneshotsFolderExtra'), value: lib ? oneshotsOf(lib).folder : '',
          placeholder: t('manage.oneshotsNone'), help: t('manage.oneshotsHelpExtra') }
      ].concat(defaultFields, metaFields),
      onSubmit: function (v) {
        var body = { name: v.name, root: v.root, oneshotsFolder: v.oneshotsFolder, defaults: { sort: v.defSort, bookOrder: v.defBookOrder, bookLayout: v.defLayout, readingDirection: v.defDirection } };
        if (v.metaProviders) body.metadata = { providers: v.metaProviders, autoFetch: v.metaAutoFetch, cover: v.metaCover };
        var req = lib ? api('PATCH', '/api/libraries/' + lib.id, body) : api('POST', '/api/libraries', body);
        return req.then(function () {
          A().toast(t(lib ? 'manage.saved' : 'manage.created'));
          invalidate(); markStale(cache.series);
          cache.libs = {}; // the library's default order may have changed
          A().refreshLibraries();
          refreshCurrent();
        });
      }
    });
  }

  // The work's cover full size over the page; closes with a click anywhere, Esc or the close button, and
  // gives the focus back to the cover
  function openCoverZoom(src, from) {
    if (!src || document.querySelector('.lightbox')) return;
    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', t('series.coverZoom'));
    box.innerHTML = '<img class="lightbox__img" alt="" src="' + esc(src) + '" />' +
      '<button type="button" class="icon-btn lightbox__close" data-icon="close" aria-label="' + esc(t('common.close')) + '" title="' + esc(t('common.close')) + '"></button>';
    document.body.appendChild(box);
    renderIcons(box);
    var close = function () {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', close);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (from && from.focus) from.focus();
    };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
    $('.lightbox__close', box).focus();
  }

  function nameForm(titleKey, current, onSubmit) {
    openForm({ title: t(titleKey), fields: [{ name: 'name', label: t('manage.name'), value: current || '' }], onSubmit: function (v) {
      if (!v.name) return Promise.reject({ code: 'nameRequired' });
      return onSubmit(v.name);
    } });
  }

  function handleAction(btn) {
    var action = btn.dataset.lib, id = btn.dataset.id;
    var route = A().parseRoute();
    switch (action) {
      case 'more-series':
        btn.disabled = true;
        return fetchSeries(route, true);
      case 'scan-library':
        btn.disabled = true;
        return api('POST', '/api/libraries/' + id + '/scan', { full: btn.dataset.full === '1' }).then(function (r) {
          A().toast(t(!r.serviceRunning ? 'lib.scanQueuedStopped' : btn.dataset.full === '1' ? 'lib.fullScanStarted' : 'lib.scanStarted'));
          if (route.name === 'manage-libraries') manage.enter(route);
          else pollLibraryScan(id, route);
        }, fail);
      case 'proc-scan':
        btn.disabled = true;
        return api('POST', '/api/processes/scan-service/' + btn.dataset.op).then(function (r) {
          cache.processes.scanService = r.scanService;
          A().toast(t({ start: 'proc.started', stop: 'proc.stopped', restart: 'proc.restarted' }[btn.dataset.op]));
          A().renderPage();
        }, function (e) { btn.disabled = false; fail(e); });
      case 'config-defaults': {
        var c = cache.config;
        if (!c || !c.schema) return;
        Object.keys(c.schema).forEach(function (k) { var input = document.getElementById('cfg-' + k); if (input) input.value = c.schema[k].default; });
        return;
      }
      case 'config-clear-key': {
        if (!confirm(t('cfg.keyRemoveConfirm'))) return;
        var patch = {}; patch[btn.dataset.key] = null;
        return api('PATCH', '/api/config', patch).then(function (r) { cache.config = r; providersCache = null; A().toast(t('cfg.saved')); A().renderPage(); }, fail);
      }
      case 'series-delete': return deleteWork(id);
      case 'series-restore':
        return api('POST', '/api/series/' + id + '/restore', {}).then(function () {
          A().toast(t('del.restored')); invalidate(); markStale(cache.series); A().refreshLibraries(); refreshCurrent();
        }, fail);
      case 'cover-zoom': return openCoverZoom(btn.dataset.src, btn);
      case 'book-order': {
        var sv = cache.series[id] && cache.series[id].series;
        if (!sv) return;
        var nextOrder = bookOrderFor(sv) === 'desc' ? 'asc' : 'desc';
        try {
          if (nextOrder === (sv.bookOrder || 'asc')) localStorage.removeItem('thoth.order.' + id); // back to the default
          else localStorage.setItem('thoth.order.' + id, nextOrder);
        } catch (e) { /* no storage: just this view */ }
        return A().renderPage();
      }
      // ---- External catalog ----
      case 'cat-more': btn.disabled = true; return fetchCatalog(true);
      case 'cat-all-chapters': {
        var cw = catWorkState(btn.dataset.work);
        if (cw) { cw.showAll = cw.showAll || {}; cw.showAll[btn.dataset.key] = true; A().renderPage(); }
        return;
      }
      case 'cat-unmerge':
        if (!confirm(t('cat.unmerge') + '?')) return;
        return api('DELETE', '/api/catalog/merge/' + encodeURIComponent(id)).then(function () {
          cache.catalog = null; cache.catMerge = null; location.hash = '#catalog';
        }, fail);
      case 'task-output': {
        var ts = tasksState();
        ts.open[id] = !ts.open[id];
        if (!ts.open[id]) return A().renderPage();
        return loadTasks().then(function () { A().renderPage(); });
      }
      case 'task-stop':
        btn.disabled = true;
        return api('POST', '/api/tasks/' + encodeURIComponent(id) + '/stop').then(function () { A().toast(t('proc.task.stopping')); }, function (e) { btn.disabled = false; fail(e); });
      case 'log-delete':
        if (!confirm(t('logs.deleteConfirm'))) return;
        return api('DELETE', '/api/logs/' + encodeURIComponent(id)).then(function () { logsPage.enter(A().parseRoute()); }, fail);
      case 'cat-ch-tab': { var cw = catWorkState(btn.dataset.work); if (cw) { cw.tab = id; A().renderPage(); } return; }
      case 'cat-file-open': catFilesState().raw = false; return openSiteFile(id);
      case 'cat-file-raw': catFilesState().raw = true; return A().renderPage();
      case 'cat-merge-check': return loadCatMerge();
      case 'cat-merge-auto':
        btn.disabled = true;
        return api('POST', '/api/catalog/merge/auto').then(function (r) {
          A().toast(t('cat.autoMerged', { count: r.merged })); cache.catalog = null; loadCatMerge();
        }, function (e) { btn.disabled = false; fail(e); });
      case 'cat-split':
        return api('POST', '/api/catalog/merge/' + encodeURIComponent(id) + '/split', { key: btn.dataset.key }).then(function (r) {
          A().toast(t('cat.splitDone')); cache.catalog = null; cache.catWork = null;
          if (A().parseRoute().param === 'merge') return loadCatMerge();
          // On the work's page: what's left of it (the group, or the one work left)
          var next = '#catalog/work?key=' + encodeURIComponent(r.groupId ? 'g:' + r.groupId : r.keys[0]);
          if (location.hash === next) refreshCurrent(); else location.hash = next;
        }, fail);
      case 'cat-unmerge-group':
        if (!confirm(t('cat.unmerge') + '?')) return;
        return api('DELETE', '/api/catalog/merge/' + encodeURIComponent(id)).then(function () { cache.catalog = null; loadCatMerge(); }, fail);
      case 'cat-merge-go': {
        var cm = catMergeState(), gk = btn.dataset.key, ch = cm.choice[gk];
        var keys = Object.keys(ch.include).filter(function (k) { return ch.include[k]; });
        if (keys.indexOf(ch.primary) === -1) keys.push(ch.primary);
        btn.disabled = true;
        return api('POST', '/api/catalog/merge', { keys: keys, primary: ch.primary }).then(function () {
          A().toast(t('common.saved'));
          cm.data.groups = cm.data.groups.filter(function (g) { return g.key !== gk; }); cm.data.total--;
          cache.catalog = null;
          A().renderPage();
        }, function (e) { btn.disabled = false; fail(e); });
      }
      case 'cat-merge-dismiss': {
        var cd = catMergeState(), dk = btn.dataset.key;
        return api('POST', '/api/catalog/merge-suggestions/dismiss', { key: dk }).then(function () {
          cd.data.groups = cd.data.groups.filter(function (g) { return g.key !== dk; }); cd.data.total--; A().renderPage();
        }, fail);
      }
      case 'cat-src-add': return openSourceWizard(null);
      case 'cat-src-edit': return openSourceWizard(catSourcesState().data.sources.filter(function (s) { return s.id === id; })[0]);
      case 'cat-src-delete':
        if (!confirm(t('cat.deleteConfirm'))) return;
        return api('DELETE', '/api/catalog/sources/' + id).then(function () { cache.catalog = null; loadCatSources(); }, fail);
      case 'cat-src-crawl':
        btn.disabled = true;
        return api('POST', '/api/catalog/sources/' + id + '/crawl', { mode: btn.dataset.mode }).then(function () { loadCatSources(); }, function (e) { btn.disabled = false; fail(e); });
      case 'cat-src-stop':
        btn.disabled = true;
        return api('POST', '/api/catalog/sources/' + id + '/stop', {}).then(function () { setTimeout(loadCatSources, 800); }, fail);
      case 'cat-src-test': {
        var ss = catSourcesState(), src = ss.data.sources.filter(function (s) { return s.id === id; })[0];
        ss.tests[id] = { loading: true }; A().renderPage();
        return api('POST', '/api/catalog/sources/test', src).then(function (r) { ss.tests[id] = { test: r.test }; }, function (e) { ss.tests[id] = { error: e }; })
          .then(function () { if (isCatalogRoute()) A().renderPage(); });
      }
      case 'ren-check': renameState().result = null; return runRenamePreview();
      // File management: delete one of two files competing for a name, or all of them at once
      case 'files-del':
      case 'files-replace':
      case 'files-del-all': {
        var fs2 = renameState(), bodyDel, question;
        if (action === 'files-del-all') {
          bodyDel = { allExists: true, library: fs2.library, keep: btn.dataset.keep };
          question = t(btn.dataset.keep === 'renamed' ? 'files.confirmAllExisting' : 'files.confirmAllRenamed', { count: fs2.data.exists });
        } else {
          bodyDel = { items: [{ bookId: id, replace: action === 'files-replace' }] };
          question = t('files.confirmDelete', { name: btn.dataset.name });
        }
        if (!confirm(question)) return;
        btn.disabled = true;
        return api('POST', '/api/files/delete', bodyDel).then(function (r) {
          fs2.job = r.job; fs2.result = null;
          A().renderPage();
          pollRenameJob();
        }, function (e) { btn.disabled = false; fail(e); });
      }
      case 'merge-check': mergeState().result = null; return loadMergeSuggestions();
      case 'merge-go': return startMerge(btn.dataset.key);
      case 'merge-dismiss': {
        var ms = mergeState(), key = btn.dataset.key;
        return api('POST', '/api/files/merge-suggestions/dismiss', { key: key }).then(function () {
          ms.data.groups = ms.data.groups.filter(function (g) { return g.key !== key; });
          ms.data.total--;
          A().renderPage();
        }, fail);
      }
      case 'merge-add': {
        var ma = mergeState();
        var w = (ma.found || []).filter(function (x) { return x.id === id; })[0];
        if (w && !ma.manual.some(function (x) { return x.id === id; })) ma.manual.push(w);
        if (!ma.manualTarget || !ma.manual.some(function (x) { return x.id === ma.manualTarget; })) {
          var firstFolder = ma.manual.filter(function (x) { return !x.oneshot; })[0];
          ma.manualTarget = firstFolder ? firstFolder.id : null;
        }
        return A().renderPage();
      }
      case 'merge-clear': { var mc = mergeState(); mc.manual = []; mc.manualTarget = null; return A().renderPage(); }
      case 'ren-apply': {
        var rs = renameState();
        var nPick = renameSelectedCount(rs);
        if (!nPick || !confirm(t('ren.confirm', { count: nPick }))) return;
        // Everything (but the unticked ones): the server takes its own list; otherwise the ticked ones
        var body = rs.mode === 'all'
          ? { all: true, library: rs.library, exclude: Object.keys(rs.excluded), include: Object.keys(rs.guessPicked), renameJson: rs.renameJson }
          : { items: rs.data.items.filter(function (x) { return (x.status === 'ok' && rs.selected[x.bookId]) || (x.status === 'guess' && rs.guessPicked[x.bookId]); }).map(function (x) { return { bookId: x.bookId, toName: x.toName, from: x.from }; }), renameJson: rs.renameJson };
        btn.disabled = true;
        return api('POST', '/api/rename/apply', body).then(function (r) {
          rs.job = r.job; rs.result = null;
          A().toast(t('ren.queued'));
          A().renderPage();
          pollRenameJob();
        }, function (e) { btn.disabled = false; fail(e); });
      }
      case 'msrc-add': return folderSourceForm(null);
      case 'msrc-edit': return folderSourceForm(cache.msrc.folder.filter(function (s) { return s.id === id; })[0]);
      case 'msrc-check': return runCheck(id);
      case 'msrc-apply':
        btn.disabled = true;
        return api('POST', '/api/metadata/sources/' + id + '/apply').then(function () {
          A().toast(t('msrc.applied')); invalidate(); markStale(cache.series); markStale(cache.book); btn.disabled = false;
        }, function (e) { btn.disabled = false; fail(e); });
      case 'msrc-delete': {
        var src = cache.msrc.folder.filter(function (s) { return s.id === id; })[0];
        if (!confirm(t('msrc.confirmDelete', { name: src.name }))) return;
        return api('DELETE', '/api/metadata/sources/' + id).then(function () {
          A().toast(t('msrc.deleted')); providersCache = null; invalidate(); markStale(cache.series); markStale(cache.book); refreshCurrent();
        }, fail);
      }
      case 'msrc-search': {
        var input = document.querySelector('[data-msrc-q="' + id + '"]');
        var q = input ? input.value.trim() : '';
        if (!q) { if (input) input.focus(); return; }
        cache.msrcSearch = cache.msrcSearch || {};
        var box = document.querySelector('[data-msrc-results="' + id + '"]');
        cache.msrcSearch[id] = { loading: true };
        if (box) box.innerHTML = searchReport(cache.msrcSearch[id]);
        return api('GET', '/api/metadata/sources/' + id + '/search?q=' + encodeURIComponent(q)).then(function (r) { cache.msrcSearch[id] = r.results; }, function (e) { cache.msrcSearch[id] = { error: e }; })
          .then(function () { var b2 = document.querySelector('[data-msrc-results="' + id + '"]'); if (b2) b2.innerHTML = searchReport(cache.msrcSearch[id]); });
      }
      case 'library-metadata':
        btn.disabled = true;
        return api('POST', '/api/libraries/' + id + '/metadata', { mode: btn.dataset.mode || 'stale' }).then(function (r) {
          A().toast(r.queued ? t('meta.queued', { count: r.queued }) : t('meta.nothingToDo'));
          btn.disabled = false;
        }, function (e) { btn.disabled = false; fail(e); });
      case 'meta-refresh':
        btn.disabled = true;
        A().toast(t('meta.refreshing'));
        return api('POST', '/api/series/' + id + '/metadata/refresh').then(function (r) {
          A().toast(r.series.metadata && r.series.metadata.matched ? t('meta.refreshed') : t('meta.noMatchToast'));
          invalidate(); markStale(cache.series); refreshCurrent();
        }, function (e) { btn.disabled = false; fail(e); });
      case 'meta-identify': return openIdentify(id);
      case 'meta-clear':
        if (!confirm(t('meta.clearConfirm'))) return;
        return api('DELETE', '/api/series/' + id + '/metadata').then(function () {
          A().toast(t('meta.cleared')); invalidate(); markStale(cache.series); refreshCurrent();
        }, fail);
      case 'proc-server-restart':
        if (!confirm(t('proc.serverRestartConfirm'))) return;
        btn.disabled = true;
        return api('POST', '/api/processes/server/restart').then(waitForServerRestart, function (e) { btn.disabled = false; fail(e); });
      case 'series-toggle-read':
        return api('POST', '/api/series/' + id + '/progress', { completed: !btn.dataset.done }).then(function () {
          A().toast(t(btn.dataset.done ? 'series.markedUnread' : 'series.markedRead'));
          invalidate(); refreshCurrent();
        }, fail);
      case 'book-toggle-read':
        return (btn.dataset.done ? api('DELETE', '/api/books/' + id + '/progress') : Store.setProgress(id, Number(btn.dataset.pages) || 1, true)).then(function () {
          A().toast(t(btn.dataset.done ? 'series.markedUnread' : 'series.markedRead'));
          invalidate(); markStale(cache.series); refreshCurrent();
        }, fail);
      case 'series-edit': return editSeries(id);
      case 'book-edit': return editBook(id);
      case 'series-add-collection': return addTo('collection', id);
      case 'book-add-readlist': return addTo('readlist', id);
      case 'collection-new':
        return nameForm('coll.new', '', function (name) {
          return api('POST', '/api/collections', { name: name }).then(function (r) { A().toast(t('coll.created')); invalidate(); location.hash = '#collection/' + r.collection.id; });
        });
      case 'readlist-new':
        return nameForm('rl.new', '', function (name) {
          return api('POST', '/api/readlists', { name: name }).then(function (r) { A().toast(t('rl.created')); invalidate(); location.hash = '#readlist/' + r.readlist.id; });
        });
      case 'collection-rename':
        return nameForm('coll.rename', cache.collection[id].name, function (name) {
          return api('PATCH', '/api/collections/' + id, { name: name }).then(function () { invalidate(); refreshCurrent(); });
        });
      case 'readlist-rename':
        return nameForm('coll.rename', cache.readlist[id].name, function (name) {
          return api('PATCH', '/api/readlists/' + id, { name: name }).then(function () { invalidate(); refreshCurrent(); });
        });
      case 'collection-delete':
        if (!confirm(t('coll.confirmDelete', { name: cache.collection[id].name }))) return;
        return api('DELETE', '/api/collections/' + id).then(function () { A().toast(t('coll.deleted')); invalidate(); location.hash = '#collections'; }, fail);
      case 'readlist-delete':
        if (!confirm(t('rl.confirmDelete', { name: cache.readlist[id].name }))) return;
        return api('DELETE', '/api/readlists/' + id).then(function () { A().toast(t('rl.deleted')); invalidate(); location.hash = '#readlists'; }, fail);
      case 'collection-remove-series':
        return api('PATCH', '/api/collections/' + route.param, { removeSeriesIds: [id] }).then(function () { A().toast(t('coll.removed')); invalidate(); refreshCurrent(); }, fail);
      case 'readlist-remove-book':
        return api('PATCH', '/api/readlists/' + route.param, { removeBookIds: [id] }).then(function () { A().toast(t('rl.removed')); invalidate(); refreshCurrent(); }, fail);
      case 'readlist-move': {
        var ids = cache.readlist[route.param].books.map(function (b) { return b.id; });
        var i = ids.indexOf(id), j = i + Number(btn.dataset.dir);
        if (i < 0 || j < 0 || j >= ids.length) return;
        ids.splice(j, 0, ids.splice(i, 1)[0]);
        return api('PATCH', '/api/readlists/' + route.param, { bookIds: ids }).then(function () { refreshCurrent(); }, fail);
      }
      case 'library-add': return libraryForm(null);
      case 'library-edit': return libraryForm(cache.manage.libraries.filter(function (l) { return l.id === id; })[0]);
      case 'library-delete': {
        var lib = cache.manage.libraries.filter(function (l) { return l.id === id; })[0];
        if (!confirm(t('manage.confirmDelete', { name: lib.name }))) return;
        return api('DELETE', '/api/libraries/' + id).then(function () {
          A().toast(t('manage.deleted')); invalidate(); A().refreshLibraries(); refreshCurrent();
        }, fail);
      }
    }
  }

  // After "Scan library" on a library page: refresh the grid when the scan ends
  function pollLibraryScan(id, route) {
    setTimeout(function () {
      if (location.hash !== route.hash) return; // left the page
      Store.libraries().then(function (r) {
        A().state.libraries = r.libraries;
        var l = r.libraries.filter(function (x) { return x.id === id; })[0];
        if (l && l.scanning) return pollLibraryScan(id, route);
        invalidate();
        A().refreshLibraries();
        if (location.hash === route.hash) { A().renderPage(); library.enter(route); }
      });
    }, 1200);
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-lib]');
      if (btn && !btn.disabled && $('#content').contains(btn)) { e.preventDefault(); handleAction(btn); }
    });
    // Broken cover image → show the placeholder underneath
    document.addEventListener('error', function (e) {
      if (e.target.classList && e.target.classList.contains('cover__img')) e.target.classList.add('is-broken');
    }, true);

    $('#form-dialog-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!formState) return;
      var btn = $('#form-dialog-submit');
      btn.disabled = true;
      $('#form-dialog-error').hidden = true;
      Promise.resolve().then(function () { return formState.onSubmit(formValues()); }).then(function () {
        $('#form-dialog').close();
      }, formError).then(function () { btn.disabled = false; });
    });
    $('#form-dialog-cancel').addEventListener('click', function () { $('#form-dialog').close(); });

    $('#identify-form').addEventListener('submit', function (e) { e.preventDefault(); searchIdentify(); });
    $('#identify-close').addEventListener('click', function () { $('#identify-dialog').close(); });
    // Picking matches: one per site, several sites at once; "Use selected" applies them together
    $('#identify-results').addEventListener('click', function (e) {
      var b = e.target.closest('[data-identify]');
      if (!b) return;
      var site = b.dataset.identify, id = b.dataset.mid;
      if (identifyPicks[site] && identifyPicks[site].id === id) delete identifyPicks[site];
      else identifyPicks[site] = { provider: site, id: id, title: b.dataset.title || '' };
      updateIdentifyPicks();
    });
    $('#identify-apply').addEventListener('click', function () {
      var picks = Object.keys(identifyPicks).map(function (k) { return { provider: identifyPicks[k].provider, id: identifyPicks[k].id }; });
      if (!picks.length) return;
      var btn = $('#identify-apply');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner--sm"></span>';
      api('POST', '/api/series/' + identifyFor + '/metadata/identify', { matches: picks }).then(function (r) {
        $('#identify-dialog').close();
        if (r && r.task) {
          // Several sites: it runs in the background as a task; the work's page is refreshed when it ends
          A().toast(t('meta.identifyBackground'));
          followTask(r.task, function (tk) {
            A().toast(t(tk.status === 'done' ? 'meta.identified' : 'meta.identifyFailed'));
            invalidate(); markStale(cache.series); refreshCurrent();
          });
          return;
        }
        A().toast(t('meta.identified'));
        invalidate(); markStale(cache.series); refreshCurrent();
      }, function (err) {
        updateIdentifyPicks();
        $('#identify-error').textContent = A().errMsg(err); $('#identify-error').hidden = false;
      });
    });
    $('#form-dialog-fields').addEventListener('change', function (e) {
      if (e.target.id === 'cover-upload') { readCoverFile(e.target.files && e.target.files[0]); e.target.value = ''; return; }
      syncShowWhen();
    });
    $('#form-dialog-fields').addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      if (pick) return pickCover(pick.dataset.pick);
      var b = e.target.closest('[data-fd]');
      if (!b) return;
      if (b.dataset.fd === 'prov-up' || b.dataset.fd === 'prov-down') {
        var li = b.closest('.prov-item');
        var other = b.dataset.fd === 'prov-up' ? li.previousElementSibling : li.nextElementSibling;
        // Folder sources stay above online sites (the server keeps that order anyway)
        var isFolder = function (x) { return x && x.classList.contains('prov-item--folder'); };
        if (other && isFolder(li) !== isFolder(other)) { A().toast(t('msrc.foldersFirst')); return; }
        if (other) { if (b.dataset.fd === 'prov-up') li.parentNode.insertBefore(li, other); else li.parentNode.insertBefore(other, li); }
        b.focus();
        return;
      }
      var input = $('#form-dialog-fields input[name="root"]');
      if (b.dataset.fd === 'browse') browseFolders(input.value);
      if (b.dataset.fd === 'open' || b.dataset.fd === 'up') browseFolders(b.dataset.path);
      if (b.dataset.fd === 'use') { input.value = b.dataset.path; $('#folder-browser').hidden = true; input.focus(); }
    });
  }

  window.LibraryPages = {
    home: home, library: library, series: series, book: book, search: search,
    collections: collections, collection: collection, readlists: readlists, readlist: readlist,
    'manage-libraries': manage,
    'metadata-sources': metadataSources,
    files: renamePage,
    catalog: catalogPage,
    rename: renamePage,
    processes: processes,
    logs: logsPage,
    'server-settings': serverSettings,
    read: { render: function () { return ''; }, title: function () { return t('reader.title'); } },
    reset: reset,
    invalidate: function () { invalidate(); markStale(cache.series); markStale(cache.book); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
