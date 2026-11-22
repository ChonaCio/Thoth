/*
 * Book reader (full screen).
 *   Modes: paged left-to-right, paged right-to-left (manga), vertical scroll (webtoon).
 *   Fit:   screen, width, height, original size.
 *   Input: keyboard, click/tap zones, swipe, slider. Progress is saved as you read.
 *   PDFs are rendered with pdf.js (loaded from a CDN the first time a PDF is opened).
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var A = function () { return window.App; };
  var t = function (k, v) { return A().t(k, v); };
  var esc = function (s) { return A().esc(s); };

  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var MODES = ['ltr', 'rtl', 'vertical'];
  var FITS = ['screen', 'width', 'height', 'original'];

  var st = null;       // current reading session
  var saveTimer = null;
  var observer = null;

  /* ---------------- preferences (this browser; per series) ---------------- */
  function loadPrefs(series) {
    var p = {};
    try { p = JSON.parse(localStorage.getItem('thoth.reader.' + series.id)) || {}; } catch (e) { /* none */ }
    var mode = MODES.indexOf(p.mode) !== -1 ? p.mode : (series.readingDirection || 'ltr');
    var fit = FITS.indexOf(p.fit) !== -1 ? p.fit : (mode === 'vertical' ? 'width' : 'screen');
    return { mode: mode, fit: fit };
  }
  function savePrefs() {
    try { localStorage.setItem('thoth.reader.' + st.series.id, JSON.stringify({ mode: st.mode, fit: st.fit })); } catch (e) { /* ignore */ }
  }

  /* ---------------- open / close ---------------- */
  function open(route) {
    var id = route.param;
    var readlist = route.query.get('readlist') || '';
    var startPage = Number(route.query.get('page')) || 0;
    if (st && st.bookId === id && st.readlist === readlist) { if (startPage) goTo(startPage); return; }
    close();
    st = { bookId: id, readlist: readlist, page: 1, count: 0, uiHidden: false, ended: false };
    var session = st;
    var el = $('#reader');
    el.hidden = false;
    el.className = 'reader';
    document.body.classList.add('is-reading');
    $('#reader-stage').innerHTML = '';
    $('#reader-end').hidden = true;
    $('#reader-settings').hidden = true;
    message('<span class="spinner"></span>');
    A().applyTranslations();
    renderIcons(el);

    Store.request('GET', '/api/books/' + id + (readlist ? '?readlist=' + encodeURIComponent(readlist) : '')).then(function (r) {
      if (st !== session) return;
      st.book = r.book; st.series = r.series; st.next = r.next; st.prev = r.prev;
      st.count = r.book.pageCount || 0;
      var prefs = loadPrefs(r.series || { id: r.book.seriesId });
      st.mode = r.book.format === 'pdf' && prefs.mode === 'vertical' ? 'ltr' : prefs.mode;
      st.fit = prefs.fit;
      var p = r.book.progress;
      st.page = startPage || (p && !p.completed ? p.page : 1);
      $('#reader-title').textContent = r.book.title;
      $('#reader-subtitle').textContent = r.book.oneshot ? t('lib.oneshot')
        : (r.series ? r.series.title + ' · ' : '') + t('book.number', { number: r.book.number });
      document.title = r.book.title + ' – Thoth';
      if (r.book.error) return message('<p>' + esc(t('book.error', { error: r.book.error })) + '</p>' + closeButton());
      if (r.book.format === 'pdf') return openPdf(session);
      if (!st.count) return message('<p>' + esc(t('reader.loadFailed')) + '</p>' + closeButton());
      message(null);
      build();
    }, function (e) {
      if (st !== session) return;
      message('<p>' + esc(A().errMsg(e)) + '</p>' + closeButton());
    });
  }

  function close() {
    if (!st) return;
    flushProgress();
    if (st.renderTask) try { st.renderTask.cancel(); } catch (e) { /* ignore */ }
    if (st.pdf) try { st.pdf.destroy(); } catch (e) { /* ignore */ }
    if (observer) { observer.disconnect(); observer = null; }
    st = null;
    $('#reader').hidden = true;
    $('#reader-stage').innerHTML = '';
    document.body.classList.remove('is-reading');
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  // Leave the reader: back to the read list or the book page
  function exitReader() {
    if (!st) return;
    var target = st.readlist ? '#readlist/' + st.readlist : '#book/' + st.bookId;
    if (window.LibraryPages) LibraryPages.invalidate();
    location.hash = target;
  }

  function message(html) {
    var m = $('#reader-message');
    if (!html) { m.hidden = true; m.innerHTML = ''; return; }
    m.innerHTML = html;
    m.hidden = false;
    renderIcons(m);
  }
  function closeButton() { return '<button class="btn btn--primary" data-reader="close">' + esc(t('reader.close')) + '</button>'; }

  /* ---------------- layout ---------------- */
  function pageUrl(n) { return '/api/books/' + st.book.id + '/pages/' + n + '?v=' + st.book.v; }

  function build() {
    var stage = $('#reader-stage');
    var el = $('#reader');
    el.className = 'reader reader--' + st.mode + ' reader--fit-' + st.fit + (st.uiHidden ? ' reader--ui-hidden' : '');
    if (observer) { observer.disconnect(); observer = null; }
    var slider = $('#reader-slider');
    slider.max = String(Math.max(1, st.count));
    slider.dir = st.mode === 'rtl' ? 'rtl' : 'ltr';

    if (st.mode === 'vertical') {
      var html = '<div class="reader__scroll">';
      for (var i = 1; i <= st.count; i++) {
        html += '<img class="reader__vpage" data-page="' + i + '" loading="lazy" decoding="async" alt="' + esc(t('reader.page', { page: i, total: st.count })) + '" src="' + pageUrl(i) + '" />';
      }
      stage.innerHTML = html + '</div>';
      var current = st.page;
      // Ignore page sightings while jumping to the saved page, or progress would be reset to page 1
      st.restoring = true;
      stage.addEventListener('load', function (ev) { if (ev.target.classList) ev.target.classList.add('is-loaded'); }, true);
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && st && !st.restoring) {
            var n = Number(e.target.dataset.page);
            if (n !== st.page) { st.page = n; afterPageChange(false); }
            if (n === st.count) markEnd();
          }
        });
      }, { root: stage, rootMargin: '-50% 0px -50% 0px' });
      Array.prototype.forEach.call(stage.querySelectorAll('.reader__vpage'), function (img) { observer.observe(img); });
      var session = st;
      requestAnimationFrame(function () {
        scrollToPage(current, false);
        setTimeout(function () { if (st === session) { scrollToPage(current, false); st.restoring = false; } }, 400);
      });
    } else if (st.book.format === 'pdf') {
      stage.innerHTML = '<div class="reader__paged"><canvas class="reader__page" id="reader-canvas"></canvas></div>';
    } else {
      stage.innerHTML = '<div class="reader__paged"><img class="reader__page" id="reader-img" alt="" /></div>';
      $('#reader-img').addEventListener('error', function () { if (st) message('<p>' + esc(t('reader.loadFailed')) + '</p>'); });
      $('#reader-img').addEventListener('load', function () { message(null); });
    }
    showPage();
    renderSettings();
  }

  function scrollToPage(n, smooth) {
    var img = $('#reader-stage .reader__vpage[data-page="' + n + '"]');
    if (img) img.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  function showPage() {
    if (!st) return;
    st.page = Math.max(1, Math.min(st.page, st.count || 1));
    if (st.mode === 'vertical') { afterPageChange(false); return; }
    var stage = $('#reader-stage');
    stage.scrollTop = 0;
    stage.scrollLeft = st.mode === 'rtl' ? stage.scrollWidth : 0;
    if (st.book.format === 'pdf') renderPdfPage();
    else {
      $('#reader-img').src = pageUrl(st.page);
      // Preload the next pages so turning is instant
      [1, 2].forEach(function (d) { if (st.page + d <= st.count) { var im = new Image(); im.src = pageUrl(st.page + d); } });
    }
    afterPageChange(true);
  }

  function afterPageChange(save) {
    $('#reader-count').textContent = t('reader.page', { page: st.page, total: st.count || '?' });
    var slider = $('#reader-slider');
    slider.value = String(st.page);
    slider.setAttribute('aria-valuetext', $('#reader-count').textContent);
    queueProgress();
    if (save !== false && st.page === st.count) markEnd();
  }

  /* ---------------- navigation ---------------- */
  function goTo(n) {
    if (!st || !st.count) return;
    n = Math.max(1, Math.min(n, st.count));
    hideEnd();
    if (st.mode === 'vertical') {
      st.page = n; st.restoring = true; scrollToPage(n, false); afterPageChange(false);
      var session = st;
      setTimeout(function () { if (st === session) st.restoring = false; }, 300);
      return;
    }
    if (n === st.page) return;
    st.page = n;
    showPage();
  }
  function next() {
    if (!st || !st.count) return;
    if (!$('#reader-end').hidden) { if (st.next) return openBook(st.next.id); return; }
    if (st.page >= st.count) return showEnd();
    goTo(st.page + 1);
  }
  function prev() {
    if (!st) return;
    if (!$('#reader-end').hidden) return hideEnd();
    if (st.page > 1) goTo(st.page - 1);
  }
  function openBook(id) {
    location.hash = '#read/' + id + (st.readlist ? '?readlist=' + encodeURIComponent(st.readlist) : '');
  }

  /* ---------------- progress ---------------- */
  function queueProgress() {
    if (!st || !st.book) return;
    clearTimeout(saveTimer);
    var bookId = st.book.id, page = st.page;
    st.pendingSave = { bookId: bookId, page: page };
    saveTimer = setTimeout(flushProgress, 800);
  }
  function flushProgress() {
    clearTimeout(saveTimer);
    if (!st || !st.pendingSave) return;
    var p = st.pendingSave;
    st.pendingSave = null;
    Store.setProgress(p.bookId, p.page).catch(function () { /* offline; next page turn retries */ });
  }
  function markEnd() {
    if (!st || st.completedSent) return;
    st.completedSent = true;
    clearTimeout(saveTimer);
    st.pendingSave = null;
    Store.setProgress(st.book.id, st.count, true).catch(function () { st.completedSent = false; });
  }

  /* ---------------- end of book ---------------- */
  function showEnd() {
    markEnd();
    var end = $('#reader-end');
    var oneshot = st.book.oneshot && st.series;
    var backHref = st.readlist ? '#readlist/' + st.readlist
      : oneshot ? '#library/' + st.series.libraryId
      : (st.series ? '#series/' + st.series.id : '#home');
    var backKey = st.readlist ? 'reader.backToReadlist' : oneshot ? 'reader.backToLibrary' : 'reader.backToSeries';
    end.innerHTML =
      '<div class="reader__end-card">' +
        '<p class="reader__end-title">' + esc(t('reader.finished', { title: st.book.title })) + '</p>' +
        (st.next ? '<button class="btn btn--primary" data-reader="next-book">' + esc(t('reader.nextBook', { title: st.next.number + ' · ' + st.next.title })) + '</button>' : '') +
        '<a class="btn btn--outline" href="' + backHref + '">' + esc(t(backKey)) + '</a>' +
        '<button class="btn btn--text" data-reader="stay">' + esc(t('reader.stay')) + '</button>' +
      '</div>';
    end.hidden = false;
    var first = end.querySelector('button, a');
    if (first) first.focus();
  }
  function hideEnd() { $('#reader-end').hidden = true; }

  /* ---------------- settings panel ---------------- */
  function renderSettings() {
    var panel = $('#reader-settings');
    var isPdf = st.book.format === 'pdf';
    var group = function (label, items, current, attr) {
      return '<div class="reader__setting"><span class="reader__setting-label">' + esc(t(label)) + '</span><div class="segmented">' +
        items.map(function (it) {
          return '<button type="button" class="segmented__btn' + (it[0] === current ? ' is-active' : '') + '" data-' + attr + '="' + it[0] + '"' +
            (it[2] ? ' disabled' : '') + ' aria-pressed="' + (it[0] === current) + '">' + esc(t(it[1])) + '</button>';
        }).join('') + '</div></div>';
    };
    panel.innerHTML =
      group('reader.mode', [['ltr', 'series.direction.ltr'], ['rtl', 'series.direction.rtl'], ['vertical', 'series.direction.vertical', isPdf]], st.mode, 'mode') +
      (isPdf ? '<p class="reader__hint">' + esc(t('reader.pdfVertical')) + '</p>' : '') +
      group('reader.fit', [['screen', 'reader.fitScreen'], ['width', 'reader.fitWidth'], ['height', 'reader.fitHeight'], ['original', 'reader.fitOriginal']], st.fit, 'fit') +
      '<p class="reader__hint">' + esc(t('reader.keys')) + '</p>';
  }

  function toggleUi(force) {
    st.uiHidden = force != null ? force : !st.uiHidden;
    $('#reader').classList.toggle('reader--ui-hidden', st.uiHidden);
    if (st.uiHidden) $('#reader-settings').hidden = true;
  }

  function toggleFullscreen() {
    var el = $('#reader');
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
  }

  /* ---------------- PDF ---------------- */
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = function () {
        if (!window.pdfjsLib) return reject(new Error('pdf.js missing'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  function openPdf(session) {
    message('<span class="spinner"></span><p>' + esc(t('reader.pdfLoading')) + '</p>');
    var fileUrl = '/api/books/' + st.book.id + '/file';
    loadPdfJs().then(function (pdfjs) {
      return pdfjs.getDocument({ url: fileUrl, withCredentials: true }).promise;
    }).then(function (pdf) {
      if (st !== session) { pdf.destroy(); return; }
      st.pdf = pdf;
      if (pdf.numPages !== st.count) {
        st.count = pdf.numPages;
        Store.request('POST', '/api/books/' + st.book.id + '/page-count', { pageCount: pdf.numPages }).catch(function () {});
      }
      message(null);
      build();
    }, function () {
      if (st !== session) return;
      message('<p>' + esc(t('reader.pdfFailed')) + '</p><a class="btn btn--primary" href="' + fileUrl + '" target="_blank" rel="noopener">' + esc(t('reader.openPdf')) + '</a>' + closeButton());
    });
  }
  function renderPdfPage() {
    var session = st;
    if (st.renderTask) try { st.renderTask.cancel(); } catch (e) { /* ignore */ }
    st.pdf.getPage(st.page).then(function (page) {
      if (st !== session) return;
      var stage = $('#reader-stage');
      var base = page.getViewport({ scale: 1 });
      var w = stage.clientWidth, h = stage.clientHeight;
      var scale = st.fit === 'width' ? w / base.width
        : st.fit === 'height' ? h / base.height
        : st.fit === 'original' ? 1.5
        : Math.min(w / base.width, h / base.height);
      var dpr = window.devicePixelRatio || 1;
      var vp = page.getViewport({ scale: scale * dpr });
      var canvas = $('#reader-canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / dpr) + 'px';
      canvas.style.height = Math.floor(vp.height / dpr) + 'px';
      st.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      return st.renderTask.promise;
    }).catch(function (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      if (st === session) message('<p>' + esc(t('reader.loadFailed')) + '</p>');
    });
  }

  /* ---------------- input ---------------- */
  function bind() {
    var el = $('#reader');
    $('#reader-close').addEventListener('click', exitReader);
    $('#reader-fullscreen').addEventListener('click', toggleFullscreen);
    $('#reader-settings-btn').addEventListener('click', function () { $('#reader-settings').hidden = !$('#reader-settings').hidden; });
    $('#reader-left').addEventListener('click', function () { if (st) (st.mode === 'rtl' ? next : prev)(); });
    $('#reader-right').addEventListener('click', function () { if (st) (st.mode === 'rtl' ? prev : next)(); });
    $('#reader-slider').addEventListener('input', function () { if (st) goTo(Number(this.value)); });

    $('#reader-settings').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !st) return;
      if (b.dataset.mode) st.mode = b.dataset.mode;
      if (b.dataset.fit) st.fit = b.dataset.fit;
      savePrefs();
      build();
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-reader]');
      if (!b || !st) return;
      if (b.dataset.reader === 'close') exitReader();
      if (b.dataset.reader === 'next-book' && st.next) openBook(st.next.id);
      if (b.dataset.reader === 'stay') hideEnd();
    });

    // Tap/click zones and swipes on the page (paged modes): left third / right third / middle toggles the bars
    var down = null;
    $('#reader-stage').addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    $('#reader-stage').addEventListener('pointerup', function (e) {
      if (!st || !down || e.button > 0) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      var quick = Date.now() - down.t < 600;
      down = null;
      if (st.mode === 'vertical') { if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && quick) toggleUi(); return; }
      if (Math.abs(dx) > 50 && Math.abs(dy) < 80) { // swipe
        var forward = dx < 0 ? st.mode !== 'rtl' : st.mode === 'rtl';
        return forward ? next() : prev();
      }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || !quick) return; // drag/scroll, not a tap
      var w = window.innerWidth, x = e.clientX;
      if (x < w * 0.3) return st.mode === 'rtl' ? next() : prev();
      if (x > w * 0.7) return st.mode === 'rtl' ? prev() : next();
      toggleUi();
    });

    document.addEventListener('keydown', function (e) {
      if (!st || $('#reader').hidden || document.querySelector('dialog[open]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var paged = st.mode !== 'vertical';
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); (st.mode === 'rtl' ? prev : next)(); toggleUi(true); break;
        case 'ArrowLeft': e.preventDefault(); (st.mode === 'rtl' ? next : prev)(); toggleUi(true); break;
        case 'PageDown': case ' ':
          if (paged) { e.preventDefault(); next(); toggleUi(true); }
          else if (st.page === st.count) { e.preventDefault(); next(); }
          break;
        case 'PageUp': if (paged) { e.preventDefault(); prev(); } break;
        case 'Home': e.preventDefault(); goTo(1); break;
        case 'End': e.preventDefault(); goTo(st.count); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'Escape':
          if (!$('#reader-settings').hidden) $('#reader-settings').hidden = true;
          else if (!$('#reader-end').hidden) hideEnd();
          else if (!document.fullscreenElement) exitReader();
          break;
      }
    });

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (st && st.pdf && st.mode !== 'vertical') renderPdfPage(); }, 150);
    });
    window.addEventListener('pagehide', flushProgress);
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushProgress(); });
  }

  window.Reader = { open: open, close: close };
  bind();
})();
