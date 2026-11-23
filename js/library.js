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
          // Narrow the chips of one section (client side)
          var term = t2.value.trim().toLowerCase();
          $$('[data-adv="' + t2.dataset.advSearch + '"]', box).forEach(function (c) { c.hidden = term && c.dataset.value.toLowerCase().indexOf(term) === -1; });
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
  // The "Search & filters" button, the active criteria and (when open) the panel with every value
  function filtersHtml(route) {
    var st = libState(route), fc = cache.facets[libId(route)] || null, n = activeFilters(st);
    var stateOf = function (f, v) { return st.inc[f].indexOf(v) !== -1 ? 'inc' : st.exc[f].indexOf(v) !== -1 ? 'exc' : ''; };
    var chip = function (f, v, label, count) {
      var s = stateOf(f, v);
      return '<button type="button" class="chip chip--adv' + (s ? ' is-' + s : '') + '" data-adv="' + f + '" data-value="' + esc(v) + '" aria-pressed="' + (s ? 'true' : 'false') + '"' +
        ' title="' + esc(t(s === 'inc' ? 'adv.stateInc' : s === 'exc' ? 'adv.stateExc' : 'adv.stateNone')) + '">' +
        (s === 'inc' ? '+ ' : s === 'exc' ? '− ' : '') + esc(label) + (count ? ' <span class="chip__count">' + count + '</span>' : '') + '</button>';
    };
    var section = function (f, values, searchable) {
      var chosen = st.inc[f].concat(st.exc[f]);
      // Keep chosen values visible even if the counts don't list them
      chosen.forEach(function (v) { if (!values.some(function (x) { return x.value === v; })) values.unshift({ value: v, label: v, count: 0 }); });
      if (!values.length) return '';
      return '<div class="adv-section"><div class="adv-section__head"><span class="adv-section__title">' + esc(t('filter.' + f)) + '</span>' +
          (searchable && values.length > 12 ? '<input type="search" class="adv-section__find" data-adv-search="' + f + '" placeholder="' + esc(t('adv.find')) + '" aria-label="' + esc(t('adv.find')) + ' ' + esc(t('filter.' + f)) + '" />' : '') +
        '</div><div class="adv-chips">' + values.map(function (x) { return chip(f, x.value, x.label, x.count); }).join('') + '</div></div>';
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
      var next = nextToRead(books);
      var allRead = s.booksCount && s.booksRead === s.booksCount;
      var meta = [
        '<a href="#library/' + s.libraryId + '">' + esc(s.libraryName) + '</a>',
        esc(count(s.booksCount, 'lib.bookCount1', 'lib.booksCount')),
        s.type ? '<span class="badge badge--primary">' + esc(t('type.' + s.type)) + '</span>' : '',
        s.year ? esc(s.year) : '',
        s.status !== 'unknown' ? '<span class="badge">' + esc(t('series.status.' + s.status)) + '</span>' : '',
        s.rating != null ? '<span title="' + esc(t('meta.rating')) + '">★ ' + esc((s.rating / 10).toFixed(1)) + '</span>' : '',
        s.publisher ? esc(s.publisher) : '',
        s.readingDirection !== 'ltr' ? esc(t('series.direction.' + s.readingDirection)) : ''
      ].filter(Boolean);
      var progressLine = s.booksRead || s.booksInProgress
        ? '<p class="muted small">' + esc(t('series.readOf', { read: s.booksRead, total: s.booksCount })) + '</p>' : '';
      // Versions of this work (Base, Colored, Raw, Uncensored, Animated) as tabs; each tab is its own page
      var editions = d.editions || [];
      var tabs = editions.length > 1
        ? '<nav class="tabs" aria-label="' + esc(t('series.versions')) + '">' + editions.map(function (e) {
            var active = e.id === s.id;
            var done = e.booksCount && e.booksRead === e.booksCount;
            var otherLib = e.libraryId !== s.libraryId ? ' <span class="tab__lib">' + esc(e.libraryName) + '</span>' : '';
            return '<a class="tab' + (active ? ' is-active' : '') + '" href="#series/' + e.id + '"' + (active ? ' aria-current="page"' : '') + '>' +
              esc(editionLabel(e.edition)) + otherLib + '<span class="tab__count">' + (done ? icon('check') : e.booksCount) + '</span></a>';
          }).join('') + '</nav>'
        : '';
      // A hidden (logically deleted) work: only administrators get here; offer to restore it
      var hiddenBanner = s.hidden ? '<div class="banner banner--info"><span>' + esc(t('del.hiddenBanner', { time: A().fmtDate(s.hidden.at), by: s.hidden.by || '' })) + '</span>' +
        '<button class="btn btn--primary" data-lib="series-restore" data-id="' + s.id + '">' + esc(t('del.restore')) + '</button></div>' : '';
      return backLink('#library/' + s.libraryId, s.libraryName) + hiddenBanner + tabs +
        '<div class="detail">' +
          // The cover opens full size (click/Enter); a placeholder (no image) doesn't
          (s.coverSource ? '<button type="button" class="detail__cover cover cover--large cover--zoom" data-lib="cover-zoom" data-src="/api/series/' + s.id + '/thumbnail?v=' + s.coverV + '" aria-label="' + esc(t('series.coverZoom')) + '" title="' + esc(t('series.coverZoom')) + '">' + seriesCoverHtml(s) + '</button>'
            : '<div class="detail__cover cover cover--large">' + seriesCoverHtml(s) + '</div>') +
          '<div class="detail__body">' +
            (editions.length > 1 || s.edition !== 'base' ? '<p class="detail__eyebrow">' + esc(editionLabel(s.edition)) + '</p>' : '') +
            '<h1 class="detail__title">' + esc(d.workTitle || s.title) + '</h1>' +
            '<div class="detail__meta">' + meta.join('<span class="dot">·</span>') + '</div>' +
            authorsLine(s.authors, s) +
            (s.altTitles && s.altTitles.length ? '<p class="muted small detail__alt">' + esc(s.altTitles.slice(0, 4).join(' · ')) + '</p>' : '') +
            progressLine +
            filterChips(s, 'genre', s.genres || [], 'chip--genre') +
            filterChips(s, 'tag', s.tags, '') +
            '<div class="detail__actions">' +
              (next ? '<a class="btn btn--primary" href="#read/' + next.book.id + (next.fromStart ? '?page=1' : '') + '">' + icon('play') + esc(t(next.key)) + '</a>' : '') +
              '<button class="btn btn--outline" data-lib="series-toggle-read" data-id="' + s.id + '" data-done="' + (allRead ? '1' : '') + '">' + icon(allRead ? 'remove_done' : 'done_all') + esc(t(allRead ? 'series.markUnread' : 'series.markRead')) + '</button>' +
              (isAdmin() ? '<button class="btn btn--text" data-lib="series-add-collection" data-id="' + s.id + '">' + icon('collections') + esc(t('series.addToCollection')) + '</button>' +
                '<button class="btn btn--text" data-lib="series-edit" data-id="' + s.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' +
                (s.hidden ? '' : '<button class="btn btn--text btn--danger" data-lib="series-delete" data-id="' + s.id + '">' + icon('delete') + esc(t('del.button')) + '</button>') : '') +
            '</div>' +
            (s.summary ? '<p class="detail__summary">' + esc(s.summary) + '</p>' : '') +
            metadataBlock(s) +
            (d.collections.length ? '<div class="detail__in"><span class="muted small">' + esc(t('series.inCollections')) + '</span>' +
              chips(d.collections.map(function (c) { return '<a href="#collection/' + c.id + '">' + esc(c.name) + '</a>'; }), 'chip--link') + '</div>' : '') +
            (isAdmin() && s.path != null ? '<p class="muted small detail__path">' + icon('folder_open') + esc(s.path || '/') + '</p>' : '') +
          '</div>' +
        '</div>' +
        booksSection(s, books);
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
  var RENAME_ERRORS = { changed: 'ren.err.changed', exists: 'ren.status.exists', conflict: 'ren.status.conflict', 'read-only': 'ren.err.readOnly', 'no permission': 'ren.err.noPermission', notEmpty: 'files.err.notEmpty', notDeletable: 'files.err.notDeletable', otherDisk: 'files.err.otherDisk' };
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
      '<p class="muted small">' + esc(t('ren.jobHelp')) + '</p></div>';
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
          '<p class="media-card__meta cat-card__meta">' + it.sources.map(function (s) { return sourceIconHtml(s.sourceId, 'src-icon--xs'); }).join('') + '<span>' + esc([it.sources.map(function (s) { return s.name; }).join(', '), it.chapters ? t('cat.chapters', { count: it.chapters }) : ''].filter(Boolean).join(' · ')) + '</span></p></div>' +
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
        miss.chapters.slice(0, 500).map(function (c) { return '<li><span class="cat-ch__n">' + esc(c.n) + '</span><span class="cat-ch__t">' + esc(c.t || '') + '</span><span class="muted small">' + esc(c.source) + '</span>' +
          (c.u ? '<a class="small" href="' + esc(c.u) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') + '</a>' : '') + '</li>'; }).join('') + '</ul></details>' : '';
    var sources = w.sources.map(function (s, i) {
      var all = d.showAll && d.showAll[s.key];
      var rows = all ? s.chapterList : s.chapterList.slice(0, 50);
      return '<section class="card card--wide cat-source">' +
        '<div class="cat-source__head"><h2 class="card__title cat-source__title">' + sourceIconHtml(s.sourceId, 'src-icon--sm') + esc(s.name) + '</h2>' +
          (s.url ? '<a class="btn btn--text btn--small" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') + esc(t('cat.openOnSite')) + '</a>' : '') + '</div>' +
        (s.title && s.title !== w.title ? '<p class="small"><strong>' + esc(s.title) + '</strong></p>' : '') +
        (s.error ? '<p class="notice notice--error small">' + esc(s.error) + '</p>' : '') +
        (s.partial ? '<p class="notice notice--info small">' + esc(t('cat.partial')) + '</p>' : '') +
        '<p class="muted small">' + esc(t('cat.chapters', { count: s.chapterList.length }) + (s.detailAt ? ' · ' + t('cat.readAt', { time: A().fmtDate(s.detailAt) }) : '')) + '</p>' +
        (rows.length ? '<ul class="cat-chapters">' + rows.map(function (c) {
          return '<li><span class="cat-ch__n">' + esc(c.n != null ? c.n : '—') + '</span><span class="cat-ch__t">' + esc(c.t || '') + '</span><span class="muted small">' + esc([c.d, c.l].filter(Boolean).join(' · ')) + '</span>' +
            (c.u ? '<a class="small" href="' + esc(c.u) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(t('cat.openOnSite')) + '">' + icon('open_in_new') + '</a>' : '') + '</li>';
        }).join('') + '</ul>' : '') +
        (!all && s.chapterList.length > 50 ? '<button class="btn btn--text btn--small" data-lib="cat-all-chapters" data-key="' + esc(s.key) + '" data-work="' + esc(key) + '">' + esc(t('cat.showAll', { count: s.chapterList.length })) + '</button>' : '') +
      '</section>';
    }).join('');
    return back + lib +
      '<div class="detail">' +
        '<div class="detail__cover cover cover--large">' + (w.cover ? '<img class="cover__img" alt="" src="' + catCover(w.coverKey) + '" />' : '') + placeholder('cbz') + '</div>' +
        '<div class="detail__body">' +
          '<h1 class="detail__title">' + esc(w.title) + '</h1>' +
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
      '</div>' + missingList + sources;
  }

  // Merge suggestions (admins): the same work on several sites
  function catMergeState() {
    if (!cache.catMerge) cache.catMerge = { data: null, loading: false, error: null, choice: {} };
    return cache.catMerge;
  }
  function loadCatMerge() {
    var st = catMergeState();
    st.loading = true; st.error = null;
    if (isCatalogRoute()) A().renderPage();
    return api('GET', '/api/catalog/merge-suggestions').then(function (r) {
      st.data = r; st.choice = {};
      r.groups.forEach(function (g) { var inc = {}; g.works.forEach(function (w) { inc[w.key] = true; }); st.choice[g.key] = { primary: g.primary, include: inc }; });
    }, function (e) { st.error = e; }).then(function () { st.loading = false; if (isCatalogRoute()) A().renderPage(); });
  }
  function catalogMerge() {
    var st = catMergeState();
    var head = catalogTabs('merge') + '<p class="page-lead">' + esc(t('cat.mergeIntro')) + '</p>' +
      '<div class="toolbar"><div class="toolbar__group"><button class="btn btn--primary btn--pill" data-lib="cat-merge-check"' + (st.loading ? ' disabled' : '') + '>' + icon('search') + esc(t('files.findDuplicates')) + '</button></div></div>';
    if (st.error) return head + errorBanner(st.error);
    if (st.loading || !st.data) return head + spinner;
    if (!st.data.groups.length) return head + emptyState('check', t('files.noSuggestionsTitle'), t('cat.noSuggestions'));
    return head + '<h2 class="section-title">' + esc(t('files.suggestions', { count: st.data.total })) + '</h2>' + st.data.groups.map(function (g) {
      var ch = st.choice[g.key];
      var n = g.works.filter(function (w) { return ch.include[w.key]; }).length;
      var why = g.reason === 'link' ? t('cat.reason.link') : t('files.reason.title', { title: (g.detail || {}).title || '' });
      return '<section class="card card--wide merge-group">' +
        '<p class="merge-group__why">' + icon('dataset') + '<span>' + esc(why) + '</span>' +
          (g.inLibrary ? ' <a class="badge badge--ok" href="#series/' + g.inLibrary.seriesId + '">' + esc(t('cat.inLibrary')) + '</a>' : '') + '</p>' +
        '<ul class="merge-list">' + g.works.map(function (w) {
          var main = w.key === ch.primary;
          return '<li class="merge-row' + (main ? ' is-target' : '') + '">' +
            '<label class="merge-row__keep" title="' + esc(t('cat.primaryTitle')) + '"><input type="radio" name="p-' + esc(g.key) + '" value="' + esc(w.key) + '" data-cat-primary="' + esc(g.key) + '"' + (main ? ' checked' : '') + ' /><span class="small">' + esc(t('cat.primary')) + '</span></label>' +
            '<label class="checkbox"><input type="checkbox" data-cat-include="' + esc(g.key) + '" value="' + esc(w.key) + '"' + (ch.include[w.key] || main ? ' checked' : '') + (main ? ' disabled' : '') + ' />' +
              '<span class="merge-row__what"><a href="#catalog/work?key=' + encodeURIComponent(w.key) + '">' + esc(w.title) + '</a> <span class="muted small">' + esc([w.source, t('cat.chapters', { count: w.chapters })].join(' · ')) + '</span>' +
              (w.merged ? ' <span class="badge">' + esc(t('cat.alreadyMerged')) + '</span>' : '') + '</span></label></li>';
        }).join('') + '</ul>' +
        '<div class="merge-actions"><button class="btn btn--primary" data-lib="cat-merge-go" data-key="' + esc(g.key) + '"' + (n < 2 ? ' disabled' : '') + '>' + icon('collections') + esc(t('cat.mergeN', { count: n })) + '</button>' +
          '<button class="btn btn--text" data-lib="cat-merge-dismiss" data-key="' + esc(g.key) + '">' + esc(t('files.notSame')) + '</button></div>' +
      '</section>';
    }).join('');
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
    var bar = { percent: listing || !p.total ? null : Math.min(100, Math.floor((p.done || 0) / p.total * 100)), etaMs: null, elapsedMs: j.startedAt ? Date.now() - Date.parse(j.startedAt) : 0 };
    return progressBar(bar, t(j.status === 'queued' ? 'cat.crawlQueued' : listing ? 'cat.crawlListing' : 'cat.crawlReading'),
      listing ? t('cat.crawlListed', { count: p.listed || 0 }) : t('cat.crawlProgress', { done: p.done || 0, total: p.total || 0, errors: p.errors || 0 }));
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
  // The settings form; the fields shown depend on the kind of site
  // Adding a source: the site's address first; its robots.txt, sitemaps and pages fill the settings
  function catalogDetectForm() {
    openForm({
      title: t('cat.addSource'), submitLabel: t('cat.detect'), note: t('cat.detectNote'),
      fields: [{ name: 'url', label: t('cat.srcUrl'), placeholder: 'https://example.com', help: t('cat.detectHelp') },
        { name: 'manual', label: t('cat.detectManual'), type: 'checkbox', value: false }],
      onSubmit: function (v) {
        if (v.manual) { setTimeout(function () { catalogSourceForm(null, null, v.url); }, 0); return Promise.resolve(); }
        if (!v.url) return Promise.reject({ code: 'invalidUrl' });
        return api('POST', '/api/catalog/sources/detect', { url: v.url }).then(function (r) {
          setTimeout(function () { catalogSourceForm(null, r.detect, v.url); }, 0);
        });
      }
    });
  }
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
  function catalogSourceForm(s, detected, url) {
    var st = catSourcesState();
    var types = st.types || [];
    var cur = s || Object.assign({ type: 'custom', includeChapters: true, schedule: 'manual', languages: '', baseUrl: url || '' }, detected && detected.settings ? detected.settings : {});
    var sel = cur.selectors || {};
    var ty = function (list) { return { field: 'type', value: list }; };
    var fields = [
      { name: 'name', label: t('manage.name'), value: cur.name || '' },
      { name: 'type', label: t('cat.srcType'), type: 'select', value: cur.type, options: types.map(function (x) { return { value: x.type, label: x.label }; }), help: t('cat.srcTypeHelp') },
      { name: 'baseUrl', label: t('cat.srcUrl'), value: cur.baseUrl || '', placeholder: 'https://example.com', help: t('cat.srcUrlHelp') },
      { name: 'listing', label: t('cat.srcListing'), type: 'select', value: cur.listing || 'pages', options: [{ value: 'sitemap', label: t('cat.listing.sitemap') }, { value: 'pages', label: t('cat.listing.pages') }], showWhen: ty(['madara', 'mangareader', 'custom']), help: t('cat.srcListingHelp') },
      { name: 'sitemaps', label: t('cat.srcSitemaps'), type: 'textarea', rows: 2, value: (cur.sitemaps || []).join('\n'), showWhen: { field: 'listing', value: 'sitemap' }, help: t('cat.srcSitemapsHelp') },
      { name: 'workPattern', label: t('cat.srcWorkPattern'), value: cur.workPattern || '', placeholder: '/manga/*/', showWhen: { field: 'listing', value: 'sitemap' }, help: t('cat.srcPatternHelp') },
      { name: 'chapterPattern', label: t('cat.srcChapterPattern'), value: cur.chapterPattern || '', placeholder: '/manga/*/*/', showWhen: ty(['custom']), help: t('cat.srcChapterPatternHelp') },
      { name: 'listPath', label: t('cat.srcListPath'), value: cur.listPath || '', placeholder: 'manga', showWhen: ty(['madara', 'mangareader']), help: t('cat.srcListPathHelp') },
      { name: 'languages', label: t('cat.srcLanguages'), value: cur.languages || '', placeholder: 'en, es', help: t('cat.srcLanguagesHelp') },
      { name: 'contentRating', label: t('cat.srcRating'), value: cur.contentRating || 'safe,suggestive,erotica', showWhen: ty(['mangadex']), help: t('cat.srcRatingHelp') },
      { name: 'includeChapters', label: t('cat.srcChapters'), type: 'checkbox', value: cur.includeChapters !== false, help: t('cat.srcChaptersHelp') },
      { name: 'maxWorks', label: t('cat.srcMax'), value: cur.maxWorks || '', placeholder: '0', help: t('cat.srcMaxHelp') },
      { name: 'schedule', label: t('cat.srcSchedule'), type: 'select', value: cur.schedule || 'manual', options: ['manual', 'daily', 'weekly'].map(function (x) { return { value: x, label: t('cat.schedule.' + x) }; }) },
      { name: 'gapMs', label: t('cat.srcGap'), value: cur.gapMs || '', placeholder: '1500', help: t('cat.srcGapHelp') }
    ];
    var selField = function (k, ph) { return { name: 'sel_' + k, label: t('cat.sel.' + k), value: sel[k] || '', placeholder: ph, showWhen: ty(['custom']) }; };
    fields = fields.concat([
      selField('listUrl', 'https://site.com/manga/page/{page}/'), selField('item', '.manga-list .item'), selField('link', 'a@href'), selField('title', 'h3'), selField('cover', 'img@src'),
      selField('workTitle', 'h1'), selField('workCover', '.cover img@src'), selField('summary', '.description'), selField('genres', '.genres a'), selField('authors', '.author a'),
      selField('altTitles', '.alt-names'), selField('status', '.status'), selField('chapter', '.chapter-list li'), selField('chapterLink', 'a@href'), selField('chapterTitle', 'a'), selField('chapterDate', '.date')
    ]);
    openForm({
      title: t(s ? 'cat.editSource' : 'cat.addSource'), fields: fields, note: (detected ? detectSummary(detected) + ' ' : '') + t('cat.srcNote'),
      onSubmit: function (v) {
        var body = { name: v.name, type: v.type, baseUrl: v.baseUrl, listPath: v.listPath, languages: v.languages, contentRating: v.contentRating, includeChapters: v.includeChapters,
          listing: v.listing, sitemaps: (v.sitemaps || '').split(/\s+/).filter(Boolean), workPattern: v.workPattern, chapterPattern: v.chapterPattern,
          iconUrl: cur.iconUrl || undefined,
          maxWorks: Number(v.maxWorks) || 0, schedule: v.schedule, gapMs: Number(v.gapMs) || undefined, selectors: {} };
        if (!body.gapMs) delete body.gapMs;
        Object.keys(v).forEach(function (k) { if (k.indexOf('sel_') === 0 && v[k]) body.selectors[k.slice(4)] = v[k]; });
        return api(s ? 'PATCH' : 'POST', '/api/catalog/sources' + (s ? '/' + s.id : ''), body).then(function () { A().toast(t('common.saved')); loadCatSources(); });
      }
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
      return catalogBrowse();
    },
    mount: function (el, route) {
      if (!route.param) return catalogBrowseMount(el);
      if (route.param === 'merge') el.addEventListener('change', function (e) {
        var tg = e.target, st = catMergeState(), k;
        if ((k = tg.dataset.catPrimary)) { st.choice[k].primary = tg.value; st.choice[k].include[tg.value] = true; return A().renderPage(); }
        if ((k = tg.dataset.catInclude)) { st.choice[k].include[tg.value] = tg.checked; return A().renderPage(); }
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
  function facts(rows) {
    return '<dl class="pref-list proc-facts">' + rows.filter(Boolean).map(function (r) {
      return '<dt>' + esc(t(r[0])) + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>';
  }
  var STATE_BADGE = { running: 'badge--ok', starting: 'badge--primary', stopped: '', crashed: 'badge--danger' };

  var processes = {
    title: function () { return t('nav.processes'); },
    render: function () {
      var p = cache.processes;
      var head = '<h1 class="page-title">' + esc(t('nav.processes')) + '</h1><p class="page-lead">' + esc(t('proc.intro')) + '</p>';
      if (!p) return head + spinner;
      if (p.error) return head + errorBanner(p.error);
      var srv = p.server, sc = p.scanService;
      var restarting = cache.serverRestarting;

      var serverCard =
        '<section class="card proc-card">' +
          '<div class="proc-card__head"><span class="lib-card__icon">' + icon('memory') + '</span>' +
            '<div><h2 class="card__title">' + esc(t('proc.server')) + '</h2>' +
            '<span class="badge ' + (restarting ? 'badge--primary' : 'badge--ok') + '">' + esc(t(restarting ? 'proc.state.starting' : 'proc.state.running')) + '</span></div></div>' +
          (srv.restartNeeded ? '<p class="notice notice--info">' + esc(t('proc.restartNeeded')) + '</p>' : '') +
          facts([
            ['proc.pid', esc(srv.pid)], ['proc.uptime', esc(fmtDuration(srv.startedAt))],
            ['proc.memory', esc(fmtBytes(srv.rss))], ['proc.cpu', esc(fmtCpu(srv.cpuMs))],
            ['proc.node', esc(srv.node)], ['proc.platform', esc(srv.platform)]
          ]) +
          '<div class="lib-card__actions">' +
            '<button class="btn btn--outline btn--pill" data-lib="proc-server-restart"' + (srv.supervised && !restarting ? '' : ' disabled') + '>' + icon('sync') + esc(t('proc.serverRestart')) + '</button>' +
          '</div>' +
          (restarting ? '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc(t('proc.serverRestarting')) + '</p>'
            : !srv.supervised ? '<p class="field__help">' + esc(t('proc.notSupervised')) + '</p>' : '') +
        '</section>';

      var cur = sc.current;
      var scanCard =
        '<section class="card proc-card">' +
          '<div class="proc-card__head"><span class="lib-card__icon">' + icon('sync') + '</span>' +
            '<div><h2 class="card__title">' + esc(t('proc.scanService')) + '</h2>' +
            '<span class="badge ' + (STATE_BADGE[sc.state] || '') + '">' + esc(t('proc.state.' + sc.state)) + '</span></div></div>' +
          (sc.mode === 'inline' ? '<p class="notice">' + esc(t('proc.mode.inline')) + '</p>' : '') +
          (sc.lastError && sc.state !== 'running' ? '<p class="notice notice--error">' + esc(t('proc.lastError')) + ': ' + esc(sc.lastError) + '</p>' : '') +
          facts([
            ['proc.uptime', esc(sc.state === 'running' ? fmtDuration(sc.startedAt) : '—')],
            sc.mode === 'process' ? ['proc.processes', esc(sc.processes)] : null,
            ['proc.concurrency', esc(sc.concurrency)],
            sc.mode === 'process' ? ['proc.priority', esc(t('proc.priorityLow'))] : null,
            ['proc.restarts', esc(sc.restarts)],
            sc.lastError && sc.state === 'running' ? ['proc.lastError', esc(sc.lastError)] : null
          ]) +
          '<p class="field__help"><a href="#server-settings">' + esc(t('proc.changeInSettings')) + '</a></p>' +
          // One row per worker process
          (sc.workers.length
            ? '<div class="table-wrap"><table class="table proc-workers"><thead><tr>' +
                '<th>' + esc(t('proc.pid')) + '</th><th>' + esc(t('proc.memory')) + '</th><th>' + esc(t('proc.cpu')) + '</th><th>' + esc(t('proc.status')) + '</th>' +
              '</tr></thead><tbody>' + sc.workers.map(function (w) {
                var s2 = w.stats || {};
                return '<tr><td>' + esc(w.pid) + '</td><td>' + esc(fmtBytes(s2.rss)) + '</td><td>' + esc(fmtCpu(s2.cpuMs)) + '</td>' +
                  '<td><span class="badge' + (w.busy ? ' badge--primary' : '') + '">' + esc(t(w.busy ? 'proc.busy' : 'proc.idle')) + '</span></td></tr>';
              }).join('') + '</tbody></table></div>'
            : sc.idle ? '<p class="muted small">' + esc(t('proc.onDemand')) + '</p>' : '') +
          '<h3 class="proc-sub">' + esc(t('proc.current')) + '</h3>' +
          (cur && cur.progress
            ? '<p class="proc-current"><strong>' + esc(cur.name) + '</strong></p>' + scanProgressBar(cur.progress, cur)
            : cur
            ? '<p class="notice notice--info"><span class="spinner spinner--sm"></span><span><strong>' + esc(cur.name) + '</strong> · ' +
                esc(scanModeLabel(cur)) + ' · ' +
                esc(cur.toAnalyze ? t('proc.progress', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0, total: cur.toAnalyze }) : t('manage.scanningNow', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0 })) + '</span></p>'
            : '<p class="muted small">' + esc(t('proc.idle')) + '</p>') +
          '<h3 class="proc-sub">' + esc(t('proc.queue')) + '</h3>' +
          (sc.queue.length
            ? '<ol class="proc-queue">' + sc.queue.map(function (q) { return '<li>' + esc(q.name) + ' <span class="muted small">(' + esc(scanModeLabel(q)) + ')</span></li>'; }).join('') + '</ol>'
            : '<p class="muted small">' + esc(t('proc.queueEmpty')) + '</p>') +
          '<div class="lib-card__actions">' +
            '<button class="btn btn--primary btn--pill" data-lib="proc-scan" data-op="start"' + (sc.state === 'running' || sc.state === 'starting' ? ' disabled' : '') + '>' + icon('play') + esc(t('proc.start')) + '</button>' +
            '<button class="btn btn--outline btn--pill" data-lib="proc-scan" data-op="stop"' + (sc.state === 'stopped' || sc.state === 'crashed' ? ' disabled' : '') + '>' + icon('stop') + esc(t('proc.stop')) + '</button>' +
            '<button class="btn btn--outline btn--pill" data-lib="proc-scan" data-op="restart"' + (sc.mode === 'inline' ? ' disabled' : '') + '>' + icon('sync') + esc(t('proc.restart')) + '</button>' +
          '</div>' +
          '<p class="field__help">' + esc(t('proc.stopHelp')) + '</p>' +
        '</section>';

      // Online metadata lookups (run inside the web server, one work at a time)
      var md = p.metadata;
      // current: a list of works (several at once); an older server sent one object or null
      var mdCurrent = md ? (Array.isArray(md.current) ? md.current : md.current ? [md.current] : []) : [];
      var mdBusy = mdCurrent.length > 0 || (md && md.queue > 0);
      var metaCard = md ? '<section class="card proc-card">' +
          '<div class="proc-card__head"><span class="lib-card__icon">' + icon('download') + '</span>' +
            '<div><h2 class="card__title">' + esc(t('meta.service')) + '</h2>' +
            '<span class="badge ' + (mdBusy ? 'badge--primary' : 'badge--ok') + '">' + esc(t(mdBusy ? 'proc.busy' : 'proc.idle')) + '</span></div></div>' +
          facts([
            ['proc.queue', esc(md.queue)],
            md.concurrency ? ['meta.atOnce', esc(md.concurrency)] : null,
            ['meta.doneCount', esc(md.done)],
            md.covers != null ? ['meta.coversDownloaded', esc(md.covers)] : null,
            md.lastError ? ['proc.lastError', esc(md.lastError)] : null
          ]) +
          (md.progress ? progressBar(md.progress, t('meta.batch'), t('progress.works', { done: md.progress.done, total: md.progress.total })) : '') +
          (mdCurrent.length ? '<ul class="proc-list">' + mdCurrent.map(function (c) {
            var what = c.step === 'cover' ? t('meta.stepCover', { provider: providerName(c.provider || '') })
              : c.provider ? t('meta.stepSearching', { provider: providerName(c.provider) }) : '';
            return '<li><span class="spinner spinner--sm"></span><span><strong>' + esc(c.title) + '</strong>' + (what ? ' <span class="muted small">' + esc(what) + '</span>' : '') + '</span></li>';
          }).join('') + '</ul>' : '') +
          '<p class="field__help">' + esc(t('meta.serviceHelp')) + ' <a href="#server-settings">' + esc(t('proc.changeInSettings')) + '</a></p>' +
        '</section>' : '';
      // File renaming: its own process, started for one batch and closed right after
      var rn = p.rename, rr = rn && rn.running;
      var renameCard = rn ? '<section class="card proc-card">' +
          '<div class="proc-card__head"><span class="lib-card__icon">' + icon('edit') + '</span>' +
            '<div><h2 class="card__title">' + esc(t('proc.rename')) + '</h2>' +
            '<span class="badge ' + (rr ? 'badge--primary' : 'badge--ok') + '">' + esc(t(rr ? 'proc.busy' : 'proc.idle')) + '</span></div></div>' +
          facts([
            rr && rr.pid ? ['proc.pid', esc(rr.pid)] : null,
            rr ? ['proc.status', esc(t('proc.renameProgress', { done: rr.done, total: rr.total }))] : null,
            rn.queued ? ['proc.queue', esc(rn.queued)] : null,
            !rr && rn.last ? ['proc.renameLast', esc(t('proc.renameLastValue', { files: rn.last.files, when: fmtDuration(rn.last.at) }))] : null
          ]) +
          '<p class="field__help">' + esc(t('proc.renameHelp')) + ' <a href="#files">' + esc(t('nav.files')) + '</a></p>' +
        '</section>' : '';
      // Pages and covers: key-value cache in front of the media process (started when needed)
      var mi = p.media;
      var mediaCard = mi ? '<section class="card proc-card">' +
          '<div class="proc-card__head"><span class="lib-card__icon">' + icon('collections') + '</span>' +
            '<div><h2 class="card__title">' + esc(t('proc.media')) + '</h2>' +
            '<span class="badge ' + (mi.busy ? 'badge--primary' : 'badge--ok') + '">' + esc(t(mi.busy ? 'proc.busy' : 'proc.idle')) + '</span></div></div>' +
          (mi.mode === 'inline' ? '<p class="notice">' + esc(t('proc.media.inline')) + '</p>' : '') +
          facts([
            mi.pid ? ['proc.pid', esc(mi.pid)] : ['proc.processes', esc(t('proc.media.none'))],
            ['proc.media.cache', esc(t('proc.media.cacheValue', { entries: mi.cache.entries, size: mi.cache.bytes ? fmtBytes(mi.cache.bytes) : '0 MB', max: fmtBytes(mi.cache.maxBytes) }))],
            ['proc.media.hits', esc(t('proc.media.hitsValue', { hits: mi.stats.hits + mi.stats.diskHits, misses: mi.stats.misses, prefetched: mi.stats.prefetched }))],
            mi.responses ? ['proc.media.works', esc(t('proc.media.worksValue', { entries: mi.responses.entries, hits: mi.responses.hits, misses: mi.responses.misses }))] : null,
            mi.warm && (mi.warm.running || mi.warm.finishedAt) ? ['proc.media.warm', esc(mi.warm.running
              ? t('proc.media.warmRunning', { done: mi.warm.done, total: mi.warm.total })
              : t('proc.media.warmDone', { total: mi.warm.total, added: mi.warm.added }))] : null,
            mi.lastError ? ['proc.lastError', esc(mi.lastError)] : null
          ]) +
          '<p class="field__help">' + esc(t('proc.media.help')) + '</p>' +
        '</section>' : '';
      return head + '<div class="cards">' + serverCard + scanCard + metaCard + renameCard + mediaCard + '</div>';
    },
    enter: function (route) {
      clearTimeout(procTimer);
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

  /* ================= SERVER SETTINGS (admins) ================= */
  var SETTINGS_FIELDS = [
    { key: 'scanWorkers', label: 'cfg.scanWorkers', help: 'cfg.scanWorkersHelp' },
    { key: 'scanConcurrency', label: 'cfg.scanConcurrency', help: 'cfg.scanConcurrencyHelp' },
    { key: 'metadataConcurrency', label: 'cfg.metadataConcurrency', help: 'cfg.metadataConcurrencyHelp', section: 'cfg.metadata' }
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
        return '<div class="field" data-field="' + f.name + '"><label class="checkbox"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (f.value ? ' checked' : '') + ' />' +
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
      var w = JSON.parse(el.dataset.showWhen);
      el.hidden = Array.isArray(w.value) ? w.value.indexOf(v[w.field]) === -1 : v[w.field] !== w.value;
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
      case 'cat-merge-check': return loadCatMerge();
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
      case 'cat-src-add': return catalogDetectForm();
      case 'cat-src-edit': return catalogSourceForm(catSourcesState().data.sources.filter(function (s) { return s.id === id; })[0]);
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
      api('POST', '/api/series/' + identifyFor + '/metadata/identify', { matches: picks }).then(function () {
        $('#identify-dialog').close();
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
    'server-settings': serverSettings,
    read: { render: function () { return ''; }, title: function () { return t('reader.title'); } },
    reset: reset,
    invalidate: function () { invalidate(); markStale(cache.series); markStale(cache.book); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
