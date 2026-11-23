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

  function load(hash, fn) {
    return fn().then(function () { A().rerenderIf(hash); }, function (err) {
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
      });
    }
  };

  /* ================= LIBRARY (series grid) ================= */
  function libKey(route) { return route.param || 'all'; }
  // Filters besides the text search; a link like #library/<id>?genre=Action sets them (and clears the others)
  var FILTERS = ['type', 'status', 'genre', 'tag', 'metadata'];
  function libState(route) {
    var key = libKey(route);
    if (!cache.libs[key]) {
      cache.libs[key] = { items: null, total: 0, q: '', sort: route.query.get('sort') || 'title', read: route.query.get('read') || '', error: null, loading: false };
      FILTERS.forEach(function (f) { cache.libs[key][f] = ''; });
    }
    return cache.libs[key];
  }
  // Arriving at a library URL with filters in it (a genre/tag chip, a bookmark): use them
  function applyRouteFilters(route) {
    var st = libState(route);
    if (st.lastHash === route.hash) return;
    st.lastHash = route.hash;
    if (FILTERS.some(function (f) { return route.query.has(f); })) {
      FILTERS.forEach(function (f) { st[f] = route.query.get(f) || ''; });
      st.q = '';
    }
  }
  // Keep the address in step with the filters (shareable, survives reload) without re-entering the page
  function syncFilterUrl(route) {
    var st = libState(route);
    var q = {};
    FILTERS.forEach(function (f) { q[f] = st[f]; });
    var qs = Store.qs(q);
    var hash = route.hash.split('?')[0] + (qs ? '?' + qs : '');
    st.lastHash = hash;
    history.replaceState(null, '', hash);
  }
  function activeFilters(st) { return FILTERS.filter(function (f) { return st[f]; }).length; }
  function libraryName(id) {
    if (id === 'all') return t('nav.allLibraries');
    var l = A().state.libraries.filter(function (x) { return x.id === id; })[0];
    return l ? l.name : '';
  }
  function fetchSeries(route, append) {
    var st = libState(route);
    var key = libKey(route);
    st.loading = true;
    var params = { library: key === 'all' ? '' : key, q: st.q, sort: st.sort, read: st.read, offset: append ? st.items.length : 0, limit: PAGE_SIZE };
    FILTERS.forEach(function (f) { params[f] = st[f]; });
    var qs = Store.qs(params);
    return api('GET', '/api/series?' + qs).then(function (r) {
      st.items = append ? st.items.concat(r.items) : r.items;
      st.total = r.total;
      st.error = null;
    }, function (e) { st.error = e; }).then(function () { st.loading = false; renderLibGrid(route); });
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
    renderIcons(el);
  }
  var filterTimer;
  var library = {
    title: function (route) { return libraryName(libKey(route)); },
    render: function (route) {
      var key = libKey(route);
      applyRouteFilters(route);
      var st = libState(route);
      var lib = A().state.libraries.filter(function (x) { return x.id === key; })[0];
      if (key !== 'all' && !lib && A().state.libraries.length) return emptyState('library', t('lib.notFound'), '');
      var opt = function (v, k, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(t(k)) + '</option>'; };
      return '<div class="page-head"><h1 class="page-title">' + esc(libraryName(key)) + '</h1>' +
          (isAdmin() && lib ? '<button class="btn btn--outline btn--pill" data-lib="scan-library" data-id="' + key + '"' + (lib.scanning ? ' disabled' : '') + '>' + icon('sync') + esc(t(lib.scanning ? 'lib.scanning' : 'lib.scan')) + '</button>' : '') +
        '</div>' +
        '<div class="toolbar">' +
          '<label class="search-field">' + icon('search') +
            '<input type="search" id="lib-filter" placeholder="' + esc(t('lib.filterPlaceholder')) + '" value="' + esc(st.q) + '" /></label>' +
          '<div class="toolbar__group">' +
            '<select class="select select--compact" id="lib-sort" aria-label="' + esc(t('lib.sort')) + '">' +
              opt('title', 'lib.sortTitle', st.sort) + opt('added', 'lib.sortAdded', st.sort) + opt('updated', 'lib.sortUpdated', st.sort) + '</select>' +
            '<select class="select select--compact" id="lib-read" aria-label="' + esc(t('lib.read')) + '">' +
              opt('', 'lib.readAll', st.read) + opt('unread', 'lib.readUnread', st.read) + opt('inProgress', 'lib.readInProgress', st.read) + opt('read', 'lib.readRead', st.read) + '</select>' +
          '</div>' +
        '</div>' +
        '<div class="toolbar toolbar--filters" id="lib-filters">' + filtersHtml(route) + '</div>' +
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
      $('#lib-filters', el).addEventListener('change', function (e) {
        var f = e.target.dataset.filter;
        if (!f) return;
        st[f] = e.target.value;
        syncFilterUrl(route);
        refreshFilters(route);
        fetchSeries(route);
      });
      $('#lib-filters', el).addEventListener('click', function (e) {
        if (!e.target.closest('[data-filter-clear]')) return;
        FILTERS.forEach(function (f) { st[f] = ''; });
        syncFilterUrl(route);
        refreshFilters(route);
        fetchSeries(route);
      });
    },
    enter: function (route) {
      fetchSeries(route);
      // What the filters can offer (genres, tags, … with counts) for this library
      var key = libKey(route);
      api('GET', '/api/series/facets?' + Store.qs({ library: key === 'all' ? '' : key })).then(function (r) {
        cache.facets[key] = r;
        refreshFilters(route);
      }, function () { /* filters keep their fixed options */ });
    }
  };
  function refreshFilters(route) {
    var el = $('#lib-filters');
    if (!el || location.hash.split('?')[0] !== route.hash.split('?')[0]) return;
    el.innerHTML = filtersHtml(route);
    renderIcons(el);
  }
  // Type, status, genre, tag, metadata; options show how many works have each (when known)
  function filtersHtml(route) {
    var st = libState(route), fc = cache.facets[libKey(route)] || null;
    var n = function (map, k) { return fc && map && map[k] ? ' (' + map[k] + ')' : ''; };
    var option = function (value, label, cur, extra) {
      return '<option value="' + esc(value) + '"' + (value === cur ? ' selected' : '') + '>' + esc(label + (extra || '')) + '</option>';
    };
    var sel = function (f, allKey, options) {
      return '<select class="select select--compact' + (st[f] ? ' is-active' : '') + '" data-filter="' + f + '" aria-label="' + esc(t('filter.' + f)) + '">' +
        option('', t(allKey), st[f]) + options + '</select>';
    };
    var types = WORK_TYPES.concat(['unknown']).filter(function (ty) { return !fc || fc.types[ty] || st.type === ty; });
    var statuses = ['ongoing', 'ended', 'hiatus', 'abandoned', 'unknown'].filter(function (v) { return !fc || fc.statuses[v] || st.status === v; });
    var named = function (list, cur) {
      var opts = (list || []).map(function (x) { return option(x.name, x.name, cur, ' (' + x.count + ')'); });
      if (cur && !(list || []).some(function (x) { return x.name.toLowerCase() === cur.toLowerCase(); })) opts.unshift(option(cur, cur, cur));
      return opts.join('');
    };
    return '<span class="toolbar__label muted small">' + icon('tune') + esc(t('filter.title')) + '</span>' +
      sel('type', 'meta.typeAll', types.map(function (ty) { return option(ty, t('type.' + ty), st.type, n(fc && fc.types, ty)); }).join('')) +
      sel('status', 'filter.statusAll', statuses.map(function (v) { return option(v, t('series.status.' + v), st.status, n(fc && fc.statuses, v)); }).join('')) +
      sel('genre', 'filter.genreAll', named(fc && fc.genres, st.genre)) +
      sel('tag', 'filter.tagAll', named(fc && fc.tags, st.tag)) +
      sel('metadata', 'filter.metadataAll', ['matched', 'unmatched', 'none'].map(function (v) { return option(v, t('filter.metadata.' + v), st.metadata, n(fc && fc.metadata, v)); }).join('')) +
      (activeFilters(st) ? '<button type="button" class="btn btn--text btn--small" data-filter-clear>' + icon('close') + esc(t('filter.clear')) + '</button>' : '');
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
    return '<h2 class="section-title">' + esc(t('series.books')) + '</h2>' +
      (list ? bookList(books) : grid(books.map(function (b) { return bookCard(b); })));
  }

  // Online metadata: links to the sites it came from; admins can refresh, pick the right match or clear it
  var PROVIDER_NAMES = { anilist: 'AniList', mangadex: 'MangaDex', mangaupdates: 'MangaUpdates', kitsu: 'Kitsu', myanimelist: 'MyAnimeList',
    openlibrary: 'Open Library', googlebooks: 'Google Books', comicvine: 'Comic Vine' };
  function providerName(id) { return PROVIDER_NAMES[id] || id; }
  // "Eiichiro Oda (writer, penciller), …": one entry per person
  function authorsLine(list) {
    if (!list || !list.length) return '';
    var byName = [], seen = {};
    list.forEach(function (a) {
      if (!seen[a.name]) { seen[a.name] = { name: a.name, roles: [] }; byName.push(seen[a.name]); }
      if (a.role && seen[a.name].roles.indexOf(a.role) === -1) seen[a.name].roles.push(a.role);
    });
    return '<p class="detail__authors">' + byName.slice(0, 8).map(function (a) {
      return esc(a.name) + (a.roles.length ? ' <span class="muted small">(' + esc(a.roles.map(function (r) { return t('author.' + r); }).join(', ')) + ')</span>' : '');
    }).join(', ') + '</p>';
  }
  function metadataBlock(s) {
    var md = s.metadata;
    if (!md && !isAdmin()) return '';
    var links = md && md.links.length
      ? chips(md.links.map(function (l) {
          return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(providerName(l.provider)) + ' ' + icon('open_in_new') + '</a>';
        }), 'chip--link')
      : '';
    var status = !md ? t('meta.never')
      : md.matched ? t('meta.updated', { time: A().fmtDate(md.fetchedAt) }) + (md.locked ? ' · ' + t('meta.lockedTo', { provider: providerName(md.locked.provider) }) : '') +
          (md.cover ? ' · ' + (md.coverProvider ? t('meta.coverFrom', { provider: providerName(md.coverProvider) }) : t('meta.coverDownloaded')) + (s.coverSource === 'metadata' ? '' : ' (' + t('meta.coverNotShown') + ')') : ' · ' + t('meta.noCover'))
      : t('meta.noMatch', { time: A().fmtDate(md.fetchedAt) });
    return '<div class="detail__in detail__meta-src">' +
      '<span class="muted small">' + esc(t('meta.sources')) + '</span>' + links +
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
      return backLink('#library/' + s.libraryId, s.libraryName) + tabs +
        '<div class="detail">' +
          '<div class="detail__cover cover cover--large">' + seriesCoverHtml(s) + '</div>' +
          '<div class="detail__body">' +
            (editions.length > 1 || s.edition !== 'base' ? '<p class="detail__eyebrow">' + esc(editionLabel(s.edition)) + '</p>' : '') +
            '<h1 class="detail__title">' + esc(d.workTitle || s.title) + '</h1>' +
            '<div class="detail__meta">' + meta.join('<span class="dot">·</span>') + '</div>' +
            authorsLine(s.authors) +
            (s.altTitles && s.altTitles.length ? '<p class="muted small detail__alt">' + esc(s.altTitles.slice(0, 4).join(' · ')) + '</p>' : '') +
            progressLine +
            filterChips(s, 'genre', s.genres || [], 'chip--genre') +
            filterChips(s, 'tag', s.tags, '') +
            '<div class="detail__actions">' +
              (next ? '<a class="btn btn--primary" href="#read/' + next.book.id + (next.fromStart ? '?page=1' : '') + '">' + icon('play') + esc(t(next.key)) + '</a>' : '') +
              '<button class="btn btn--outline" data-lib="series-toggle-read" data-id="' + s.id + '" data-done="' + (allRead ? '1' : '') + '">' + icon(allRead ? 'remove_done' : 'done_all') + esc(t(allRead ? 'series.markUnread' : 'series.markRead')) + '</button>' +
              (isAdmin() ? '<button class="btn btn--text" data-lib="series-add-collection" data-id="' + s.id + '">' + icon('collections') + esc(t('series.addToCollection')) + '</button>' +
                '<button class="btn btn--text" data-lib="series-edit" data-id="' + s.id + '">' + icon('edit') + esc(t('series.edit')) + '</button>' : '') +
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
      });
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
        isAdmin() && b.path ? ['book.file', b.path] : null
      ].filter(Boolean);
      var authors = b.authors.map(function (a) { return esc(a.name) + ' <span class="muted small">(' + esc(t('author.' + a.role)) + ')</span>'; });
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
            (authors.length ? '<p class="detail__authors">' + authors.join(', ') + '</p>' : '') +
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
    var label = (full ? t('manage.modeFull') + ': ' : '') + t('progress.phase.' + (p.phase || 'listing'));
    var detail = p.phase === 'reading' ? t('progress.files', { done: p.done, total: p.total })
      : p.phase === 'listing' ? t('progress.found', { count: p.filesSeen || 0 }) : '';
    return progressBar(p, label, detail);
  }

  /* ================= MANAGE LIBRARIES (admins) ================= */
  var pollTimer = null;
  function scanSummary(l) {
    if (l.scanning) {
      var p = l.scanProgress || {};
      if (p.serviceStopped) return '<p class="notice">' + esc(t('manage.queuedStopped')) + ' <a href="#processes">' + esc(t('nav.processes')) + '</a></p>';
      if (p.queued) return '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc(t('manage.queued')) + '</p>';
      if (p.progress) return scanProgressBar(p.progress, p.full);
      return '<p class="notice notice--info"><span class="spinner spinner--sm"></span>' + esc((p.full ? t('manage.modeFull') + ': ' : '') + t('manage.scanningNow', { seen: p.filesSeen || 0, analyzed: p.analyzed || 0 })) + '</p>';
    }
    if (l.scanError) return '<p class="notice notice--error">' + esc(A().errMsg({ code: l.scanError, message: l.scanError })) + '</p>';
    var s = l.lastScan;
    if (!s) return '<p class="muted small">' + esc(t('manage.neverScanned')) + '</p>';
    var html = '<p class="muted small">' + esc(t('manage.lastScan', { time: A().fmtDate(s.at) })) + ' (' + esc(t(s.full ? 'manage.modeFull' : 'manage.modeChanges')) + ') · ' +
      esc(t('manage.scanSummary', { series: s.series, books: s.books, added: s.added, updated: s.updated, removed: s.removed })) + '</p>';
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
              '<button class="btn btn--text" data-lib="library-metadata" data-id="' + l.id + '" title="' + esc(t('meta.fetchMissingHelp')) + '">' + icon('download') + esc(t('meta.fetchMissing')) + '</button>' +
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
        return Promise.all([api('GET', '/api/libraries'), api('GET', '/api/library-settings')]).then(function (r) {
          var wasScanning = cache.manage && cache.manage.libraries.some(function (l) { return l.scanning; });
          cache.manage = { libraries: r[0].libraries, settings: r[1] };
          var scanning = r[0].libraries.some(function (l) { return l.scanning; });
          // Keep the page live while a scan runs; refresh the sidebar counts when it ends
          if (scanning) pollTimer = setTimeout(function () { if (location.hash === route.hash) manage.enter(route); }, 1500);
          if (wasScanning && !scanning) { A().refreshLibraries(); cache.home = null; cache.libs = {}; }
        }, function (e) { cache.manage = { error: e }; throw e; });
      });
    }
  };

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
            : '') +
          '<h3 class="proc-sub">' + esc(t('proc.current')) + '</h3>' +
          (cur && cur.progress
            ? '<p class="proc-current"><strong>' + esc(cur.name) + '</strong></p>' + scanProgressBar(cur.progress, cur.full)
            : cur
            ? '<p class="notice notice--info"><span class="spinner spinner--sm"></span><span><strong>' + esc(cur.name) + '</strong> · ' +
                esc(t(cur.full ? 'manage.modeFull' : 'manage.modeChanges')) + ' · ' +
                esc(cur.toAnalyze ? t('proc.progress', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0, total: cur.toAnalyze }) : t('manage.scanningNow', { seen: cur.filesSeen || 0, analyzed: cur.analyzed || 0 })) + '</span></p>'
            : '<p class="muted small">' + esc(t('proc.idle')) + '</p>') +
          '<h3 class="proc-sub">' + esc(t('proc.queue')) + '</h3>' +
          (sc.queue.length
            ? '<ol class="proc-queue">' + sc.queue.map(function (q) { return '<li>' + esc(q.name) + ' <span class="muted small">(' + esc(t(q.full ? 'manage.modeFull' : 'manage.modeChanges')) + ')</span></li>'; }).join('') + '</ol>'
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
      return head + '<div class="cards">' + serverCard + scanCard + metaCard + '</div>';
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
      });
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
      el.hidden = v[w.field] !== w.value;
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
    cache.home = null; cache.libs = {}; cache.search = {}; cache.collections = null; cache.readlists = null;
  }
  function refreshCurrent() {
    var route = A().parseRoute();
    if (LibraryPages[route.name] && LibraryPages[route.name].enter) LibraryPages[route.name].enter(route);
  }
  function fail(e) { A().toast(A().errMsg(e)); }

  // The library's default chapter layout (known to admins from the libraries list)
  function libraryLayoutOf(s) {
    var l = (cache.manage && cache.manage.libraries || []).concat(A().state.libraries || []).filter(function (x) { return x.id === s.libraryId && x.defaults; })[0];
    return l ? l.defaults.bookLayout : 'tiles';
  }
  function editSeries(id) {
    var s = cache.series[id].series, o = s.overrides || {};
    var dir = function (v) { return { value: v, label: t('series.direction.' + v) }; };
    openForm({
      title: t('edit.seriesTitle'),
      note: t('edit.blankKeeps'),
      fields: [
        { name: 'title', label: t('edit.title'), value: o.title || '', placeholder: s.title },
        { name: 'sortTitle', label: t('edit.sortTitle'), value: o.sortTitle || '', placeholder: s.sortTitle },
        { name: 'summary', label: t('edit.summary'), type: 'textarea', value: o.summary || '', placeholder: s.summary },
        { name: 'status', label: t('edit.status'), type: 'select', value: o.status || '', options: [{ value: '', label: t('edit.auto') }].concat(['ongoing', 'ended', 'hiatus', 'abandoned'].map(function (v) { return { value: v, label: t('series.status.' + v) }; })) },
        { name: 'publisher', label: t('edit.publisher'), value: o.publisher || '', placeholder: s.publisher },
        { name: 'type', label: t('meta.type'), type: 'select', value: o.type || '',
          options: [{ value: '', label: t('edit.auto') + (!o.type && s.type ? ' (' + t('type.' + s.type) + ')' : '') }].concat(WORK_TYPES.map(function (ty) { return { value: ty, label: t('type.' + ty) }; })) },
        // Reading mode: blank = the library's default (a fixed mode) or, if it has none, what was detected
        { name: 'readingDirection', label: t('edit.direction'), type: 'select', value: o.readingDirection || '', help: t('edit.directionHelp'),
          options: [{ value: '', label: s.libraryDirection
            ? t('edit.libraryDefault', { value: t('series.direction.' + s.libraryDirection) })
            : t('edit.autoDetected', { value: t('series.direction.' + (s.detectedDirection || 'ltr')) }) }, dir('ltr'), dir('rtl'), dir('vertical')] },
        { name: 'bookLayout', label: t('layout.label'), type: 'select', value: o.bookLayout || '',
          options: [{ value: '', label: t('edit.libraryDefault', { value: t('layout.' + (o.bookLayout ? libraryLayoutOf(s) : s.bookLayout)) }) },
            { value: 'tiles', label: t('layout.tiles') }, { value: 'list', label: t('layout.list') }] },
        { name: 'cover', label: t('edit.cover'), type: 'select', value: o.cover || '', help: s.metadata && s.metadata.cover ? '' : t('edit.coverNoDownload'),
          options: [{ value: '', label: t('edit.coverAuto') }, { value: 'file', label: t('edit.coverFile') }, { value: 'metadata', label: t('edit.coverMetadata') }] },
        { name: 'edition', label: t('edit.edition'), type: 'select', value: o.edition || '', help: t('edit.editionHelp'),
          options: [{ value: '', label: t('edit.auto') + (o.edition ? '' : ' (' + editionLabel(s.edition) + ')') }].concat(['base', 'colored', 'raw', 'uncensored', 'animated'].map(function (e) { return { value: e, label: editionLabel(e) }; })) },
        { name: 'genres', label: t('edit.genres'), value: (o.genres || []).join(', '), placeholder: (s.genres || []).join(', '), help: t('edit.tagsHelp') },
        { name: 'tags', label: t('edit.tags'), value: (o.tags || []).join(', '), placeholder: s.tags.join(', '), help: t('edit.tagsHelp') }
      ],
      onSubmit: function (v) {
        return api('PATCH', '/api/series/' + id, v).then(function () { invalidate(); A().toast(t('edit.saved')); refreshCurrent(); });
      }
    });
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
        return api('PATCH', '/api/books/' + id, v).then(function () { invalidate(); cache.series = {}; A().toast(t('edit.saved')); refreshCurrent(); });
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
            invalidate(); cache.series = {}; cache.book = {};
            A().toast(t(isColl ? 'coll.added' : 'rl.added', { name: name }));
            refreshCurrent();
          });
        }
      });
    }, fail);
  }

  /* ================= IDENTIFY DIALOG ================= */
  var identifyFor = null;
  function openIdentify(id) {
    var d = cache.series[id];
    if (!d || !d.series) return;
    identifyFor = id;
    var lib = (A().state.libraries || []).filter(function (l) { return l.id === d.series.libraryId; })[0];
    loadProviders().then(function (all) {
      var order = libraryProviders(lib, all);
      $('#identify-provider').innerHTML = '<option value="">' + esc(t('meta.allEnabled')) + '</option>' +
        order.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.needsKey && !p.keySet ? ' disabled' : '') + '>' + esc(p.name) + '</option>'; }).join('');
      $('#identify-q').value = d.workTitle || d.series.title;
      $('#identify-error').hidden = true;
      $('#identify-results').innerHTML = '';
      $('#identify-dialog').showModal();
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
            '<button type="button" class="btn btn--outline btn--small" data-identify="' + esc(x.provider) + '" data-mid="' + esc(x.id) + '">' + esc(t('meta.useThis')) + '</button>' +
          '</li>';
        }).join('') + '</ul>' : '<p class="muted">' + esc(t('meta.noResults')) + '</p>');
    }, function (e) { box.innerHTML = ''; $('#identify-error').textContent = A().errMsg(e); $('#identify-error').hidden = false; });
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
    return '<li class="prov-item" data-id="' + esc(p.id) + '">' +
      '<label class="checkbox prov-item__check"><input type="checkbox"' + (p.enabled ? ' checked' : '') + ' aria-label="' + esc(p.name) + '" />' +
        '<span><strong>' + esc(p.name) + '</strong>' +
        '<span class="prov-item__types">' + p.types.map(function (ty) { return esc(t('type.' + ty)); }).join(', ') + '</span>' +
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
        var body = { name: v.name, root: v.root, oneshotsFolder: v.oneshotsFolder, defaults: { bookLayout: v.defLayout, readingDirection: v.defDirection } };
        if (v.metaProviders) body.metadata = { providers: v.metaProviders, autoFetch: v.metaAutoFetch, cover: v.metaCover };
        var req = lib ? api('PATCH', '/api/libraries/' + lib.id, body) : api('POST', '/api/libraries', body);
        return req.then(function () {
          A().toast(t(lib ? 'manage.saved' : 'manage.created'));
          invalidate(); cache.series = {};
          A().refreshLibraries();
          refreshCurrent();
        });
      }
    });
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
      case 'library-metadata':
        btn.disabled = true;
        return api('POST', '/api/libraries/' + id + '/metadata', { mode: btn.dataset.mode === 'all' ? 'all' : 'missing' }).then(function (r) {
          A().toast(r.queued ? t('meta.queued', { count: r.queued }) : t('meta.nothingToDo'));
          btn.disabled = false;
        }, function (e) { btn.disabled = false; fail(e); });
      case 'meta-refresh':
        btn.disabled = true;
        A().toast(t('meta.refreshing'));
        return api('POST', '/api/series/' + id + '/metadata/refresh').then(function (r) {
          A().toast(r.series.metadata && r.series.metadata.matched ? t('meta.refreshed') : t('meta.noMatchToast'));
          invalidate(); cache.series = {}; refreshCurrent();
        }, function (e) { btn.disabled = false; fail(e); });
      case 'meta-identify': return openIdentify(id);
      case 'meta-clear':
        if (!confirm(t('meta.clearConfirm'))) return;
        return api('DELETE', '/api/series/' + id + '/metadata').then(function () {
          A().toast(t('meta.cleared')); invalidate(); cache.series = {}; refreshCurrent();
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
          invalidate(); cache.series = {}; refreshCurrent();
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
    $('#identify-results').addEventListener('click', function (e) {
      var b = e.target.closest('[data-identify]');
      if (!b) return;
      $$('#identify-results [data-identify]').forEach(function (x) { x.disabled = true; });
      b.innerHTML = '<span class="spinner spinner--sm"></span>';
      api('POST', '/api/series/' + identifyFor + '/metadata/identify', { provider: b.dataset.identify, id: b.dataset.mid }).then(function () {
        $('#identify-dialog').close();
        A().toast(t('meta.identified'));
        invalidate(); cache.series = {}; refreshCurrent();
      }, function (err) {
        $$('#identify-results [data-identify]').forEach(function (x) { x.disabled = false; });
        b.textContent = t('meta.useThis');
        $('#identify-error').textContent = A().errMsg(err); $('#identify-error').hidden = false;
      });
    });
    $('#form-dialog-fields').addEventListener('change', syncShowWhen);
    $('#form-dialog-fields').addEventListener('click', function (e) {
      var b = e.target.closest('[data-fd]');
      if (!b) return;
      if (b.dataset.fd === 'prov-up' || b.dataset.fd === 'prov-down') {
        var li = b.closest('.prov-item');
        var other = b.dataset.fd === 'prov-up' ? li.previousElementSibling : li.nextElementSibling;
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
    processes: processes,
    'server-settings': serverSettings,
    read: { render: function () { return ''; }, title: function () { return t('reader.title'); } },
    reset: reset,
    invalidate: function () { invalidate(); cache.series = {}; cache.book = {}; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
