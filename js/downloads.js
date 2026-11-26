/*
 * Downloads (administrators): jobs that download works of the external catalog into a library as CBZ files.
 *   #downloads                      the jobs: what each downloads, its schedule, what it has done, Run / Full pass / Stop
 *   #downloads/new[?work=KEY]       a new job (with a catalog work already in it)
 *   #downloads/job?id=ID            a job's settings: Works · Sites & quality · Chapters · Schedule
 *   #downloads/work?job=ID&key=KEY  one work's chapters in a job: downloaded, waiting (premium), failed — and why
 * Also the Download box on a catalog work's page (add it to a job, or start one with it).
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.from((r || document).querySelectorAll(s)); };
  var A = function () { return window.App; };
  var U = function () { return window.LibraryUI; };
  var t = function (k, v) { return A().t(k, v); };
  var esc = function (s) { return A().esc(s); };
  var api = function (m, u, b) { return Store.request(m, u, b); };
  var icon = function (n) { return '<span data-icon="' + n + '"></span>'; };
  var spinner = '<div class="loading" role="status"><span class="spinner"></span></div>';
  var errorBanner = function (e) { return '<div class="banner banner--error">' + esc(A().errMsg(e)) + '</div>'; };
  var onPage = function () { return A().parseRoute().name === 'downloads'; };
  var rerender = function () { if (onPage()) A().renderPage(); };
  var VERSIONS = ['base', 'colored', 'raw', 'uncensored', 'animated'];
  var DAYS = [1, 2, 3, 4, 5, 6, 0];

  var st = { list: null, error: null, sources: null, ed: null, work: null, poll: null };
  function fmtSize(b) { return U() && U().fmtSize ? U().fmtSize(b) : Math.round((b || 0) / 1048576) + ' MB'; }
  function when(iso) { return iso ? A().fmtDate(iso) : ''; }
  function scheduleText(s) {
    if (!s || s.type === 'manual') return t('dl.sched.manual');
    if (s.type === 'interval') return t('dl.sched.everyHours', { count: s.hours });
    if (s.type === 'daily') return t('dl.sched.dailyAt', { time: s.time });
    return t('dl.sched.daysAt', { days: (s.days || []).map(function (d) { return t('dl.day.' + d); }).join(', '), time: s.time });
  }
  function versionsText(vs) { return (vs || ['base']).map(function (v) { return t('edition.' + v); }).join(' + '); }
  function sourceName(id) { var s = (st.sources || []).filter(function (x) { return x.id === id; })[0]; return s ? s.name : id; }
  function loadSources() {
    if (st.sources) return Promise.resolve(st.sources);
    return api('GET', '/api/catalog/sources').then(function (r) { st.sources = r.sources; return st.sources; });
  }

  /* ---------------- the jobs ---------------- */
  function loadList() {
    clearTimeout(st.poll);
    return Promise.all([api('GET', '/api/downloads/jobs'), loadSources()]).then(function (r) { st.list = r[0]; st.error = null; }, function (e) { st.error = e; }).then(function () {
      if (!onPage() || A().parseRoute().param) return;
      rerender();
      if (st.list && st.list.jobs.some(function (j) { return j.run; })) st.poll = setTimeout(loadList, 2000);
    });
  }
  function runLine(j) {
    var r = j.run;
    if (!r) return '';
    if (r.status === 'queued') return '<p class="muted small">' + icon('history') + ' ' + esc(t('dl.queued')) + '</p>';
    if (r.phase === 'planning') return U().progressBar({ percent: null, etaMs: null, elapsedMs: r.startedAt ? Date.now() - Date.parse(r.startedAt) : 0 }, t('dl.planning'), '');
    var bar = { percent: r.total ? Math.min(100, Math.floor(r.done / r.total * 100)) : null, etaMs: r.etaMs, elapsedMs: r.startedAt ? Date.now() - Date.parse(r.startedAt) : 0 };
    var html = U().progressBar(bar, t(r.full ? 'dl.runningFull' : 'dl.running'), t('dl.runProgress', { done: r.done, total: r.total, ok: r.ok, failed: r.failed, locked: r.locked }));
    if (r.current && r.current.length) html += '<ul class="dl-now small">' + r.current.map(function (c) { return '<li>' + icon('download') + '<span>' + esc(c) + '</span></li>'; }).join('') + '</ul>';
    return html;
  }
  function jobCard(j) {
    var busy = Boolean(j.run);
    var b = function (o) {
      var why = o.off ? o.why : o.title;
      return '<button type="button" class="btn ' + (o.cls || 'btn--outline') + ' btn--small" data-dl="' + o.act + '" data-id="' + esc(j.id) + '"' + (o.off ? ' disabled aria-disabled="true"' : '') + (why ? ' title="' + esc(why) + '"' : '') + '>' + icon(o.icon) + esc(o.label) + '</button>';
    };
    var c = j.counts || {};
    var what = j.autoAll ? t('dl.everyWorkOn', { sites: j.listSources.map(sourceName).join(', ') }) + ' · ' : '';
    return '<section class="card lib-card dl-job' + (j.enabled ? '' : ' is-paused') + '">' +
      '<div class="lib-card__head"><span class="lib-card__icon">' + icon('download') + '</span><div class="lib-card__titles">' +
        '<h2 class="card__title"><a href="#downloads/job?id=' + encodeURIComponent(j.id) + '">' + esc(j.name) + '</a>' + (j.enabled ? '' : ' <span class="badge">' + esc(t('dl.paused')) + '</span>') + '</h2>' +
        '<p class="muted small">' + esc(t('dl.into', { library: j.libraryName || '—' }) + ' · ' + scheduleText(j.schedule) + (j.enabled && j.nextRunAt ? ' · ' + t('dl.nextRun', { time: when(j.nextRunAt) }) : '')) + '</p></div></div>' +
      '<p class="small">' + esc(what + t('dl.worksCount', { count: j.worksCount })) + (j.someWorks.length ? '<span class="muted"> — ' + esc(j.someWorks.join(', ') + (j.worksCount > j.someWorks.length ? '…' : '')) + '</span>' : '') + '</p>' +
      '<p class="muted small">' + esc([t('dl.mode.' + j.mode), versionsText(j.versions), t('dl.atATime', { count: j.concurrency }), j.sourceOrder.map(sourceName).join(' › ')].join(' · ')) + '</p>' +
      '<p class="small dl-counts"><span class="dl-stat dl-stat--done">' + icon('check') + esc(t('dl.doneCount', { count: c.done || 0 })) + (c.bytes ? ' · ' + esc(fmtSize(c.bytes)) : '') + '</span>' +
        (c.locked ? '<span class="dl-stat dl-stat--locked">' + icon('lock') + esc(t('dl.lockedCount', { count: c.locked })) + '</span>' : '') +
        (c.failed ? '<span class="dl-stat dl-stat--failed">' + icon('close') + esc(t('dl.failedCount', { count: c.failed })) + '</span>' : '') +
        (j.blacklisted ? '<span class="dl-stat">' + icon('block') + esc(t('dl.blacklistedCount', { count: j.blacklisted })) + '</span>' : '') + '</p>' +
      '<p class="muted small">' + (j.lastRunAt ? esc(t('dl.lastRun', { time: when(j.lastRunAt), status: j.lastStatus || '' })) : esc(t('dl.neverRun'))) + (j.fullPassAt ? ' · ' + esc(t('dl.fullPassAt', { time: when(j.fullPassAt) })) : '') + '</p>' +
      runLine(j) +
      '<div class="cat-src__actions">' +
        '<div class="cat-src__group" role="group" aria-label="' + esc(t('dl.grpRun')) + '">' +
          b({ act: 'run', cls: 'btn--primary', icon: 'play', label: t('dl.runNow'), title: t('dl.runNowHelp'), off: busy, why: t('dl.why.running') }) +
          b({ act: 'run-full', icon: 'sync', label: t('dl.fullPass'), title: t('dl.fullPassHelp'), off: busy, why: t('dl.why.running') }) +
          b({ act: 'stop', icon: 'stop', label: t('proc.stop'), off: !busy, why: t('dl.why.notRunning') }) +
        '</div>' +
        '<div class="cat-src__group" role="group" aria-label="' + esc(t('dl.grpJob')) + '">' +
          '<a class="btn btn--text btn--small" href="#downloads/job?id=' + encodeURIComponent(j.id) + '">' + icon('edit') + esc(t('cat.edit')) + '</a>' +
          b({ act: 'delete', cls: 'btn--text btn--danger', icon: 'delete', label: t('manage.delete'), off: busy, why: t('dl.why.running') }) +
        '</div></div>' +
    '</section>';
  }
  function listPage() {
    var head = '<h1 class="page-title">' + esc(t('nav.downloads')) + '</h1><p class="page-lead">' + esc(t('dl.intro')) + '</p>' +
      '<div class="toolbar"><div class="toolbar__group"><a class="btn btn--primary btn--pill" href="#downloads/new">' + icon('add') + esc(t('dl.newJob')) + '</a>' +
      '<a class="btn btn--outline btn--pill" href="#catalog">' + icon('travel_explore') + esc(t('nav.catalog')) + '</a></div></div>';
    if (st.error) return head + errorBanner(st.error);
    if (!st.list) return head + spinner;
    if (!st.list.jobs.length) return head + U().emptyState('download', t('dl.noJobsTitle'), t('dl.noJobs'));
    return head + '<div class="lib-list">' + st.list.jobs.map(jobCard).join('') + '</div>';
  }

  /* ---------------- a job's settings ---------------- */
  function newDraft(workKey) {
    var libs = (A().state.libraries || []);
    return { name: '', libraryId: libs.length ? libs[0].id : '', enabled: true, sourceOrder: null, listSources: [], autoAll: false, mode: 'priority', versions: ['base'], concurrency: 2,
      minChapter: null, maxChapter: null, maxPerRun: 0, workOrder: 'title', blacklist: null, schedule: { type: 'daily', hours: 24, time: '03:00', days: [1] }, works: [], _work: workKey || null };
  }
  function openEditor(route) {
    var id = route.param === 'job' ? route.query.get('id') : null;
    var workKey = route.param === 'new' ? route.query.get('work') : null;
    if (st.ed && st.ed.id === id && st.ed.forWork === workKey && st.ed.hash === route.hash) return;
    st.ed = { id: id, forWork: workKey, hash: route.hash, job: null, error: null, saveError: null, tab: 'works', added: [], removed: {}, search: { q: '', items: null, loading: false }, saving: false };
    var ed = st.ed;
    Promise.all([id ? api('GET', '/api/downloads/jobs/' + encodeURIComponent(id)) : Promise.resolve(null), loadSources(),
      workKey ? api('GET', '/api/catalog/work?key=' + encodeURIComponent(workKey)).then(null, function () { return null; }) : Promise.resolve(null)]).then(function (r) {
      if (st.ed !== ed) return;
      ed.job = r[0] ? r[0].job : newDraft(workKey);
      if (!ed.job.sourceOrder) ed.job.sourceOrder = (st.sources || []).map(function (s) { return s.id; });
      if (r[2] && r[2].work) { var w = r[2].work; ed.added.push({ key: w.key, title: w.title, cover: w.cover ? w.coverKey : null }); if (!ed.job.name) ed.job.name = w.title; }
    }, function (e) { if (st.ed === ed) ed.error = e; }).then(rerender);
  }
  var TABS = [['works', 'collections', 'dl.tabWorks'], ['sources', 'dataset', 'dl.tabSources'], ['chapters', 'list', 'dl.tabChapters'], ['schedule', 'calendar', 'dl.tabSchedule']];
  function editorPage() {
    var ed = st.ed;
    var back = '<a class="back-link" href="#downloads">' + icon('arrow_back') + esc(t('nav.downloads')) + '</a>';
    if (!ed || (!ed.job && !ed.error)) return back + spinner;
    if (ed.error) return back + errorBanner(ed.error);
    var j = ed.job, libs = A().state.libraries || [];
    if (!libs.length) return back + '<div class="banner banner--info">' + esc(t('dl.noLibrary')) + ' <a href="#manage-libraries">' + esc(t('nav.manageLibraries')) + '</a></div>';
    var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>'; };
    var chk = function (name, value, on, label, hint) { return '<label class="checkbox"' + (hint ? ' title="' + esc(hint) + '"' : '') + '><input type="checkbox" name="' + name + '" value="' + esc(value) + '"' + (on ? ' checked' : '') + ' /><span>' + label + '</span></label>'; };
    var sources = st.sources || [];
    var order = j.sourceOrder.concat(sources.map(function (s) { return s.id; }).filter(function (id) { return j.sourceOrder.indexOf(id) === -1; }));
    var works = '<section class="card card--wide dl-pane" data-dl-pane="works"' + (ed.tab === 'works' ? '' : ' hidden') + '>' +
      '<h2 class="card__title">' + esc(t('dl.fromSites')) + '</h2>' +
      '<div class="dl-checks">' + sources.map(function (s) { return chk('dl-list', s.id, j.listSources.indexOf(s.id) !== -1, esc(s.name) + ' <span class="muted small">(' + esc(t('cat.srcWorks', { count: s.works })) + ')</span>'); }).join('') + '</div>' +
      '<label class="checkbox dl-auto"><input type="checkbox" id="dl-auto"' + (j.autoAll ? ' checked' : '') + ' /><span><strong>' + esc(t('dl.autoAll')) + '</strong> <span class="muted small">' + esc(t('dl.autoAllHelp')) + '</span></span></label>' +
      (j.excluded ? '<p class="muted small">' + esc(t('dl.excluded', { count: j.excluded })) + ' <button type="button" class="btn btn--text btn--small" data-dl="restore">' + esc(t('dl.restore')) + '</button></p>' : '') +
      '<div class="dl-works-head"><h2 class="card__title">' + esc(t('dl.inThisJob')) + ' <span class="muted small" id="dl-count"></span></h2>' +
        '<label class="field field--inline"><span>' + esc(t('dl.workOrder')) + '</span><select class="select select--compact" id="dl-order">' +
          ['title', 'added', 'updated', 'manual'].map(function (o) { return opt(o, t('dl.order.' + o), j.workOrder); }).join('') + '</select></label></div>' +
      '<p class="muted small" id="dl-order-note">' + esc(t('dl.orderNote.' + j.workOrder)) + '</p>' +
      '<ul class="dl-works" id="dl-works">' + worksRows() + '</ul>' +
      '<h2 class="card__title dl-add-title">' + esc(t('dl.addWorks')) + '</h2>' +
      '<label class="search-field">' + icon('search') + '<input type="search" id="dl-search" placeholder="' + esc(t('dl.searchCatalog')) + '" value="' + esc(ed.search.q) + '" autocomplete="off" /></label>' +
      '<ul class="dl-works dl-results" id="dl-results">' + resultRows() + '</ul>' +
      '<p class="muted small">' + esc(t('dl.savedAs')) + '</p>' +
    '</section>';
    var srcPane = '<section class="card card--wide dl-pane" data-dl-pane="sources"' + (ed.tab === 'sources' ? '' : ' hidden') + '>' +
      '<p class="muted small">' + esc(t('dl.sourcesHelp')) + '</p>' +
      '<ol class="dl-order" id="dl-sources">' + order.map(function (id, i) {
        var s = sources.filter(function (x) { return x.id === id; })[0];
        if (!s) return '';
        return '<li class="dl-order__item" data-id="' + esc(id) + '"><span class="dl-order__n">' + (i + 1) + '</span>' +
          '<label class="checkbox"><input type="checkbox" name="dl-src" value="' + esc(id) + '"' + (j.sourceOrder.indexOf(id) !== -1 ? ' checked' : '') + ' /><span><strong>' + esc(s.name) + '</strong> <span class="muted small">' + esc(s.baseUrl) + '</span></span></label>' +
          '<span class="dl-order__btns"><button type="button" class="icon-btn icon-btn--sm" data-dl="src-up" title="' + esc(t('dl.higher')) + '" aria-label="' + esc(t('dl.higher')) + '">' + icon('arrow_upward') + '</button>' +
          '<button type="button" class="icon-btn icon-btn--sm" data-dl="src-down" title="' + esc(t('dl.lower')) + '" aria-label="' + esc(t('dl.lower')) + '">' + icon('arrow_downward') + '</button></span></li>';
      }).join('') + '</ol>' +
      '<h2 class="card__title">' + esc(t('dl.whichCopy')) + '</h2>' +
      ['priority', 'quality'].map(function (m) { return '<label class="checkbox dl-radio"><input type="radio" name="dl-mode" value="' + m + '"' + (j.mode === m ? ' checked' : '') + ' /><span><strong>' + esc(t('dl.mode.' + m)) + '</strong> — ' + esc(t('dl.modeHelp.' + m)) + '</span></label>'; }).join('') +
      '<label class="field dl-field"><span>' + esc(t('dl.concurrency')) + '</span><select class="select" id="dl-conc">' + [1, 2, 3, 4, 6].map(function (n) { return opt(n, n === 1 ? t('dl.oneAtATime') : String(n), j.concurrency); }).join('') + '</select></label>' +
      '<p class="muted small">' + esc(t('dl.brokenHelp')) + '</p>' +
    '</section>';
    var bl = j.blacklist || { genres: [], tags: [] };
    var chPane = '<section class="card card--wide dl-pane" data-dl-pane="chapters"' + (ed.tab === 'chapters' ? '' : ' hidden') + '>' +
      '<h2 class="card__title">' + esc(t('dl.versions')) + '</h2>' +
      '<div class="dl-checks">' + VERSIONS.map(function (v) { return chk('dl-ver', v, j.versions.indexOf(v) !== -1, esc(t('edition.' + v))); }).join('') + '</div>' +
      '<p class="muted small">' + esc(t('dl.versionsHelp')) + '</p>' +
      '<div class="dl-grid">' +
        '<label class="field"><span>' + esc(t('dl.fromChapter')) + '</span><input type="number" step="any" id="dl-min" value="' + (j.minChapter != null ? esc(j.minChapter) : '') + '" placeholder="' + esc(t('dl.first')) + '" /></label>' +
        '<label class="field"><span>' + esc(t('dl.toChapter')) + '</span><input type="number" step="any" id="dl-max" value="' + (j.maxChapter != null ? esc(j.maxChapter) : '') + '" placeholder="' + esc(t('dl.latest')) + '" /></label>' +
        '<label class="field"><span>' + esc(t('dl.maxPerRun')) + '</span><input type="number" min="0" id="dl-per-run" value="' + esc(j.maxPerRun || 0) + '" /></label>' +
      '</div>' +
      '<h2 class="card__title">' + esc(t('dl.blacklist')) + '</h2><p class="muted small">' + esc(t('dl.blacklistHelp')) + (j.blacklisted ? ' ' + t('dl.blacklistedNow', { count: j.blacklisted }) : '') + '</p>' +
      '<div class="dl-grid dl-grid--2">' +
        '<label class="field"><span>' + esc(t('cat.blGenres')) + '</span><textarea id="dl-bl-genres" rows="3">' + esc((bl.genres || []).join('\n')) + '</textarea></label>' +
        '<label class="field"><span>' + esc(t('cat.blTags')) + '</span><textarea id="dl-bl-tags" rows="3">' + esc((bl.tags || []).join('\n')) + '</textarea></label>' +
      '</div>' +
    '</section>';
    var s = j.schedule;
    var schedPane = '<section class="card card--wide dl-pane" data-dl-pane="schedule"' + (ed.tab === 'schedule' ? '' : ' hidden') + '>' +
      '<div class="dl-grid">' +
        '<label class="field"><span>' + esc(t('dl.run')) + '</span><select class="select" id="dl-sched">' + ['manual', 'interval', 'daily', 'weekly'].map(function (x) { return opt(x, t('dl.schedType.' + x), s.type); }).join('') + '</select></label>' +
        '<label class="field" data-dl-s="interval"><span>' + esc(t('dl.everyHoursLabel')) + '</span><input type="number" min="1" max="720" id="dl-hours" value="' + esc(s.hours) + '" /></label>' +
        '<label class="field" data-dl-s="daily weekly"><span>' + esc(t('dl.at')) + '</span><input type="time" id="dl-time" value="' + esc(s.time) + '" /></label>' +
      '</div>' +
      '<div class="dl-checks" data-dl-s="weekly">' + DAYS.map(function (d) { return chk('dl-day', d, s.days.indexOf(d) !== -1, esc(t('dl.day.' + d))); }).join('') + '</div>' +
      (j.nextRunAt ? '<p class="muted small">' + esc(t('dl.nextRun', { time: when(j.nextRunAt) })) + '</p>' : '') +
      '<p class="muted small">' + esc(t('dl.scheduleHelp')) + '</p>' +
    '</section>';
    return back + '<h1 class="page-title">' + esc(ed.id ? t('dl.editJob', { name: j.name }) : t('dl.newJob')) + '</h1>' +
      '<form id="dl-form" class="dl-editor" novalidate>' +
        '<section class="card card--wide dl-basics"><div class="dl-grid">' +
          '<label class="field"><span>' + esc(t('dl.name')) + '</span><input type="text" id="dl-name" maxlength="120" value="' + esc(j.name) + '" placeholder="' + esc(t('dl.namePh')) + '" required /></label>' +
          '<label class="field"><span>' + esc(t('dl.library')) + '</span><select class="select" id="dl-library">' + libs.map(function (l) { return opt(l.id, l.name, j.libraryId); }).join('') + '</select></label>' +
        '</div>' +
        '<label class="checkbox"><input type="checkbox" id="dl-enabled"' + (j.enabled ? ' checked' : '') + ' /><span>' + esc(t('dl.enabled')) + '</span></label></section>' +
        '<nav class="tabs files-tabs dl-tabs" role="tablist" aria-label="' + esc(t('dl.settings')) + '">' + TABS.map(function (x) {
          return '<button type="button" role="tab" class="tab' + (ed.tab === x[0] ? ' is-active' : '') + '" aria-selected="' + (ed.tab === x[0]) + '" data-dl="tab" data-tab="' + x[0] + '">' + icon(x[1]) + esc(t(x[2])) + '</button>';
        }).join('') + '</nav>' +
        works + srcPane + chPane + schedPane +
        '<div class="dl-editor__foot"><p class="wizard__error" role="alert" id="dl-save-error">' + (ed.saveError ? esc(A().errMsg(ed.saveError)) : '') + '</p>' +
          '<a class="btn btn--text" href="#downloads">' + esc(t('common.cancel')) + '</a>' +
          (ed.id ? '<button type="button" class="btn btn--outline" data-dl="save-run">' + icon('play') + esc(t('dl.saveAndRun')) + '</button>' : '') +
          '<button type="submit" class="btn btn--primary"' + (ed.saving ? ' disabled' : '') + '>' + esc(ed.id ? t('common.save') : t('dl.create')) + '</button></div>' +
      '</form>';
  }
  function thumb(coverKey) {
    return '<span class="dl-thumb">' + (coverKey ? '<img alt="" loading="lazy" src="/api/catalog/cover?key=' + encodeURIComponent(coverKey) + '" onerror="this.remove()" />' : '') + icon('menu_book') + '</span>';
  }
  function inJobKeys() {
    var ed = st.ed, keys = {};
    (ed.job.works || []).forEach(function (w) { if (!ed.removed[w.key]) keys[w.key] = true; });
    ed.added.forEach(function (w) { keys[w.key] = true; });
    return keys;
  }
  function worksRows() {
    var ed = st.ed, j = ed.job;
    var manual = currentOrder() === 'manual';
    var list = (j.works || []).filter(function (w) { return !ed.removed[w.key]; });
    var rows = ed.added.map(function (w) {
      return '<li class="dl-work is-new">' + thumb(w.cover) + '<div class="dl-work__body"><strong>' + esc(w.title) + '</strong> <span class="badge badge--primary">' + esc(t('dl.new')) + '</span>' +
        '<p class="muted small">' + esc(t('dl.newHelp')) + '</p></div>' +
        '<button type="button" class="icon-btn icon-btn--sm" data-dl="unadd" data-key="' + esc(w.key) + '" title="' + esc(t('coll.remove')) + '" aria-label="' + esc(t('coll.remove')) + '">' + icon('close') + '</button></li>';
    }).concat(list.slice(0, 400).map(function (w, i) {
      var counts = !w.inCatalog ? '<span class="dl-stat--failed">' + esc(t('dl.notInCatalog')) + '</span>'
        : esc(t('dl.workCounts', { chapters: w.chapters, done: w.done })) + (w.pending ? ' · ' + esc(t('dl.pendingCount', { count: w.pending })) : '') +
          (w.locked ? ' · <span class="dl-stat--locked">' + icon('lock') + esc(t('dl.lockedCount', { count: w.locked })) + '</span>' : '') +
          (w.failed ? ' · <span class="dl-stat--failed">' + esc(t('dl.failedCount', { count: w.failed })) + '</span>' : '');
      return '<li class="dl-work">' + (manual ? '<span class="dl-order__n">' + (i + 1) + '</span>' : '') + thumb(w.cover) +
        '<div class="dl-work__body"><strong>' + esc(w.title) + '</strong>' + (w.auto ? ' <span class="badge" title="' + esc(t('dl.autoHelp')) + '">' + esc(t('dl.auto')) + '</span>' : '') +
          (w.blacklisted ? ' <span class="badge badge--warn" title="' + esc(t('dl.blacklistedHelp')) + '">' + icon('block') + esc(t('dl.skipped', { term: w.blacklisted })) + '</span>' : '') +
          '<p class="muted small">' + counts + (w.folders && w.folders.length ? ' · ' + icon('folder') + esc(w.folders.join(', ')) : '') + '</p></div>' +
        '<span class="dl-work__btns">' +
          (manual ? '<button type="button" class="icon-btn icon-btn--sm" data-dl="work-up" data-key="' + esc(w.key) + '"' + (i === 0 ? ' disabled' : '') + ' title="' + esc(t('dl.earlier')) + '" aria-label="' + esc(t('dl.earlier')) + '">' + icon('arrow_upward') + '</button>' +
            '<button type="button" class="icon-btn icon-btn--sm" data-dl="work-down" data-key="' + esc(w.key) + '"' + (i === list.length - 1 ? ' disabled' : '') + ' title="' + esc(t('dl.later')) + '" aria-label="' + esc(t('dl.later')) + '">' + icon('arrow_downward') + '</button>' : '') +
          (ed.id && w.inCatalog ? '<a class="btn btn--text btn--small" href="#downloads/work?job=' + encodeURIComponent(ed.id) + '&key=' + encodeURIComponent(w.key) + '">' + esc(t('dl.chapters')) + '</a>' : '') +
          '<button type="button" class="icon-btn icon-btn--sm" data-dl="unwork" data-key="' + esc(w.key) + '" title="' + esc(t('dl.removeWork')) + '" aria-label="' + esc(t('dl.removeWork')) + '">' + icon('close') + '</button>' +
        '</span></li>';
    }));
    if (list.length > 400) rows.push('<li class="muted small">' + esc(t('dl.moreWorks', { count: list.length - 400 })) + '</li>');
    return rows.join('') || '<li class="muted small dl-empty">' + esc(t('dl.noWorksYet')) + '</li>';
  }
  function resultRows() {
    var s = st.ed.search;
    if (s.loading && !s.items) return '<li>' + spinner + '</li>';
    if (!s.items) return '<li class="muted small dl-empty">' + esc(t('dl.browseHint')) + '</li>';
    if (!s.items.length) return '<li class="muted small dl-empty">' + esc(t('lib.noMatch')) + '</li>';
    var have = inJobKeys();
    var head = '<li class="dl-browse-head"><span class="muted small">' + esc(t(s.sites ? 'dl.browseCount' : 'dl.searchCount', { count: s.total })) + '</span>' +
      '<button type="button" class="btn btn--text btn--small" data-dl="add-shown">' + icon('add') + esc(t('dl.addShown', { count: s.items.length })) + '</button></li>';
    var more = s.items.length < s.total ? '<li class="dl-browse-more"><button type="button" class="btn btn--outline btn--small" data-dl="browse-more"' + (s.loading ? ' disabled' : '') + '>' + esc(t('lib.loadMore')) + '</button></li>' : '';
    return head + s.items.map(function (it) {
      var inJob = have[it.key] || it.sources.some(function (x) { return have[x.key]; });
      return '<li class="dl-work">' + thumb(it.cover ? it.coverKey : null) + '<div class="dl-work__body"><strong>' + esc(it.title) + '</strong>' +
          (it.inLibrary ? ' <span class="badge badge--success">' + icon('check') + esc(t('cat.inLibrary')) + '</span>' : '') +
          '<p class="muted small">' + esc([it.sources.map(function (x) { return x.name; }).join(', '), it.chapters ? t('cat.chapters', { count: it.chapters }) : ''].filter(Boolean).join(' · ')) + '</p></div>' +
        (inJob ? '<span class="muted small">' + icon('check') + esc(t('dl.inJob')) + '</span>'
          : '<button type="button" class="btn btn--outline btn--small" data-dl="add" data-key="' + esc(it.key) + '" data-title="' + esc(it.title) + '" data-cover="' + esc(it.cover ? it.coverKey : '') + '">' + icon('add') + esc(t('common.add')) + '</button>') + '</li>';
    }).join('') + more;
  }
  function currentOrder() { var o = $('#dl-order'); return o ? o.value : st.ed.job.workOrder; }
  function drawWorks() {
    var box = $('#dl-works');
    if (box) { box.innerHTML = worksRows(); window.renderIcons(box); }
    var n = (st.ed.job.works || []).filter(function (w) { return !st.ed.removed[w.key]; }).length + st.ed.added.length;
    var c = $('#dl-count'); if (c) c.textContent = '(' + t('dl.worksCount', { count: n }) + ')';
    var res = $('#dl-results'); if (res) { res.innerHTML = resultRows(); window.renderIcons(res); }
  }
  // Works to add: every work of the ticked sites ("Works from these sites"), loaded page by page, narrowed by the
  // search when there is one; or, with no site ticked, the search over the whole catalog
  var searchTimer = null;
  function tickedSites() { return $$('input[name="dl-list"]:checked').map(function (x) { return x.value; }); }
  function browse(reset) {
    var s = st.ed.search, ed = st.ed;
    var sites = tickedSites(), q = (s.q || '').trim();
    if (!sites.length && q.length < 2) { s.items = null; s.total = 0; drawWorks(); return; }
    var seq = s.seq = (s.seq || 0) + 1;
    s.loading = true;
    if (reset) { s.items = null; drawWorks(); }
    var params = { q: q.length >= 2 ? q : '', sources: sites.join(','), sort: 'title', limit: 60, offset: reset ? 0 : (s.items || []).length };
    api('GET', '/api/catalog?' + Store.qs(params)).then(function (r) {
      if (st.ed !== ed || seq !== s.seq) return;
      s.items = reset ? r.items : (s.items || []).concat(r.items); s.total = r.total; s.sites = sites.length;
    }, function () { if (seq === s.seq) s.items = []; }).then(function () { if (seq === s.seq) { s.loading = false; if (st.ed === ed) drawWorks(); } });
  }
  function search(q) {
    st.ed.search.q = q;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { browse(true); }, 300);
  }
  function syncSchedule() {
    var v = ($('#dl-sched') || {}).value;
    $$('[data-dl-s]').forEach(function (el) { el.hidden = el.dataset.dlS.split(' ').indexOf(v) === -1; });
  }
  function readForm() {
    var vals = function (name) { return $$('input[name="' + name + '"]:checked').map(function (x) { return x.value; }); };
    var ed = st.ed;
    var body = {
      name: $('#dl-name').value.trim(), libraryId: $('#dl-library').value, enabled: $('#dl-enabled').checked,
      listSources: vals('dl-list'), autoAll: $('#dl-auto').checked, workOrder: $('#dl-order').value,
      sourceOrder: $$('#dl-sources .dl-order__item').filter(function (li) { return $('input', li).checked; }).map(function (li) { return li.dataset.id; }),
      mode: (($$('input[name="dl-mode"]:checked')[0]) || {}).value || 'priority', concurrency: Number($('#dl-conc').value),
      versions: vals('dl-ver'), minChapter: $('#dl-min').value, maxChapter: $('#dl-max').value, maxPerRun: Number($('#dl-per-run').value) || 0,
      blacklist: { genres: $('#dl-bl-genres').value, tags: $('#dl-bl-tags').value },
      schedule: { type: $('#dl-sched').value, hours: Number($('#dl-hours').value), time: $('#dl-time').value, days: vals('dl-day').map(Number) },
      works: ed.added.map(function (w) { return w.key; })
    };
    if (body.workOrder === 'manual') body.positions = (ed.job.works || []).filter(function (w) { return !ed.removed[w.key]; }).map(function (w) { return w.key; }).concat(body.works);
    return body;
  }
  function save(runAfter) {
    var ed = st.ed;
    if (!ed || ed.saving) return;
    var body = readForm();
    var problem = !body.name ? 'dl.err.name' : !body.sourceOrder.length ? 'dl.err.sources' : !body.versions.length ? 'dl.err.versions' : body.autoAll && !body.listSources.length ? 'dl.err.listSources' : null;
    var errEl = $('#dl-save-error');
    if (problem) { if (errEl) errEl.textContent = t(problem); return; }
    ed.saving = true;
    var removed = Object.keys(ed.removed);
    var req = ed.id ? api('PATCH', '/api/downloads/jobs/' + encodeURIComponent(ed.id), body) : api('POST', '/api/downloads/jobs', body);
    req.then(function (r) {
      var id = r.job.id;
      return removed.reduce(function (p, k) { return p.then(function () { return api('DELETE', '/api/downloads/jobs/' + encodeURIComponent(id) + '/work?key=' + encodeURIComponent(k)); }); }, Promise.resolve()).then(function () {
        return runAfter ? api('POST', '/api/downloads/jobs/' + encodeURIComponent(id) + '/run', {}) : null;
      }).then(function () {
        A().toast(t(runAfter ? 'dl.savedRunning' : ed.id ? 'dl.saved' : 'dl.created'));
        st.ed = null; st.list = null;
        location.hash = '#downloads';
      });
    }, function (e) { ed.saving = false; ed.saveError = e; if (errEl) errEl.textContent = A().errMsg(e); });
  }

  /* ---------------- one work's chapters in a job ---------------- */
  var STATUS_ICON = { done: 'check', pending: 'history', locked: 'lock', failed: 'close', nosource: 'block' };
  function openWork(route) {
    var job = route.query.get('job'), key = route.query.get('key');
    var w = { job: job, key: key, data: null, error: null, jobName: null };
    st.work = w;
    Promise.all([api('GET', '/api/downloads/jobs/' + encodeURIComponent(job) + '/work?key=' + encodeURIComponent(key)), api('GET', '/api/downloads/jobs/' + encodeURIComponent(job)).then(null, function () { return null; })]).then(function (r) {
      w.data = r[0].work; w.jobName = r[1] && r[1].job.name;
    }, function (e) { w.error = e; }).then(function () { if (st.work === w) rerender(); });
  }
  function workPage() {
    var w = st.work;
    var back = '<a class="back-link" href="#downloads/job?id=' + encodeURIComponent((w && w.job) || '') + '">' + icon('arrow_back') + esc((w && w.jobName) || t('nav.downloads')) + '</a>';
    if (!w || (!w.data && !w.error)) return back + spinner;
    if (w.error) return back + errorBanner(w.error);
    var d = w.data;
    var all = [];
    d.versions.forEach(function (v) { all = all.concat(v.chapters); });
    var count = function (s) { return all.filter(function (c) { return c.status === s; }).length; };
    var stuck = count('failed') + count('locked');
    return back + '<h1 class="page-title">' + esc(d.title) + '</h1>' +
      '<p class="page-lead">' + esc(t('dl.workLead')) + '</p>' +
      '<div class="toolbar"><div class="toolbar__group dl-counts">' + ['done', 'pending', 'locked', 'failed'].map(function (s) {
        return '<span class="dl-stat dl-stat--' + s + '">' + icon(STATUS_ICON[s]) + esc(t('dl.status.' + s)) + ' ' + count(s) + '</span>';
      }).join('') + '</div>' +
      (stuck ? '<button type="button" class="btn btn--outline btn--small" data-dl="retry" data-key="' + esc(d.key) + '" data-job="' + esc(w.job) + '">' + icon('restart_alt') + esc(t('dl.retry')) + '</button>' : '') + '</div>' +
      (d.blacklisted ? '<div class="banner banner--info">' + esc(t('dl.workBlacklisted', { term: d.blacklisted })) + '</div>' : '') +
      (d.versions.length ? d.versions.map(function (v) {
        return '<section class="card card--wide dl-version"><h2 class="card__title">' + esc(t('edition.' + (v.edition.indexOf('+') === -1 ? v.edition : 'base'))) + (v.edition.indexOf('+') !== -1 ? ' (' + esc(v.edition) + ')' : '') +
            ' <span class="muted small">' + icon('folder') + esc(v.folder) + '</span></h2>' +
          (v.chapters.length ? '<ul class="dl-chapters">' + v.chapters.map(function (c) {
            var detail = c.status === 'done' ? (c.inLibrary && !c.source ? t('dl.inLibraryAlready') : [c.source, c.pages ? t('dl.pages', { count: c.pages }) : '', c.bytes ? fmtSize(c.bytes) : '', c.width ? c.width + ' px' : ''].filter(Boolean).join(' · '))
              : c.status === 'pending' ? t('dl.pendingHelp') : c.status === 'nosource' ? t('dl.noSourceHelp') : (c.error || (c.status === 'locked' ? t('dl.lockedHelp') : ''));
            return '<li class="dl-ch dl-ch--' + c.status + '"><span class="dl-ch__st" title="' + esc(t('dl.status.' + c.status)) + '">' + icon(STATUS_ICON[c.status] || 'help') + '</span>' +
              '<span class="dl-ch__n">' + esc(c.n != null ? c.n : '—') + '</span>' +
              '<span class="dl-ch__body"><span>' + esc(c.t || '') + '</span><span class="muted small">' + esc(detail) + (c.at && c.status !== 'done' ? ' · ' + esc(when(c.at)) : '') + '</span></span>' +
              '<span class="dl-ch__links">' + c.links.map(function (l) { return '<a class="chip chip--link' + (l.pr ? ' is-premium' : '') + '" href="' + esc(l.u) + '" target="_blank" rel="noopener noreferrer">' + esc(l.source) + (l.pr ? icon('lock') : '') + '</a>'; }).join('') + '</span></li>';
          }).join('') + '</ul>' : '<p class="muted">' + esc(t('dl.noChaptersMatch')) + '</p>') + '</section>';
      }).join('') : '<p class="muted">' + esc(t('dl.noVersionsMatch')) + '</p>');
  }

  /* ---------------- the catalog work page's Download box ---------------- */
  var boxes = {}; // key → { jobs, inJobs, loading }
  function workBox(key) {
    if (!A().isAdmin()) return '';
    var b = boxes[key];
    if (!b) { boxes[key] = b = { loading: true }; Promise.all([api('GET', '/api/downloads/jobs'), api('GET', '/api/downloads/for-work?key=' + encodeURIComponent(key))]).then(function (r) { b.jobs = r[0].jobs; b.inJobs = r[1].jobs; }, function () { b.jobs = []; b.inJobs = []; }).then(function () { b.loading = false; drawBox(key); }); }
    return '<section class="card card--wide dl-workbox" id="dl-workbox" data-key="' + esc(key) + '">' + boxInner(key) + '</section>';
  }
  function boxInner(key) {
    var b = boxes[key];
    if (!b || b.loading) return '<h2 class="card__title">' + icon('download') + esc(t('dl.download')) + '</h2>' + spinner;
    var inIds = (b.inJobs || []).map(function (j) { return j.id; });
    var others = (b.jobs || []).filter(function (j) { return inIds.indexOf(j.id) === -1; });
    return '<h2 class="card__title">' + icon('download') + esc(t('dl.download')) + '</h2>' +
      (b.inJobs.length ? '<p class="small">' + esc(t('dl.inJobs')) + ' ' + b.inJobs.map(function (j) { return '<a href="#downloads/job?id=' + encodeURIComponent(j.id) + '">' + esc(j.name) + '</a>'; }).join(', ') + '</p>' : '<p class="muted small">' + esc(t('dl.notInJobs')) + '</p>') +
      '<div class="toolbar__group dl-workbox__acts">' +
        (others.length ? '<select class="select select--compact" id="dl-box-job" aria-label="' + esc(t('dl.pickJob')) + '">' + others.map(function (j) { return '<option value="' + esc(j.id) + '">' + esc(j.name) + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="btn btn--outline btn--small" data-dl="box-add" data-key="' + esc(key) + '">' + icon('add') + esc(t('dl.addToJob')) + '</button>' : '') +
        '<a class="btn btn--primary btn--small" href="#downloads/new?work=' + encodeURIComponent(key) + '">' + icon('download') + esc(t('dl.newJobWith')) + '</a>' +
      '</div>';
  }
  function drawBox(key) { var el = $('#dl-workbox'); if (el && el.dataset.key === key) { el.innerHTML = boxInner(key); window.renderIcons(el); } }

  /* ---------------- events (bound once) ---------------- */
  function moveLi(li, up) {
    var other = up ? li.previousElementSibling : li.nextElementSibling;
    if (!other) return;
    if (up) li.parentNode.insertBefore(li, other); else li.parentNode.insertBefore(other, li);
    $$('.dl-order__n', li.parentNode).forEach(function (n, i) { n.textContent = i + 1; });
  }
  function moveWork(key, up) {
    var list = st.ed.job.works;
    var visible = list.filter(function (w) { return !st.ed.removed[w.key]; });
    var i = visible.map(function (w) { return w.key; }).indexOf(key), jx = up ? i - 1 : i + 1;
    if (i < 0 || jx < 0 || jx >= visible.length) return;
    var a = list.indexOf(visible[i]), b2 = list.indexOf(visible[jx]);
    var tmp = list[a]; list[a] = list[b2]; list[b2] = tmp;
    drawWorks();
    var btn = $('[data-dl="' + (up ? 'work-up' : 'work-down') + '"][data-key="' + key.replace(/"/g, '\\"') + '"]'); if (btn && !btn.disabled) btn.focus();
  }
  function bind() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-dl]');
      if (!b || b.disabled) return;
      var act = b.dataset.dl, id = b.dataset.id;
      var fail = function (err) { A().toast(A().errMsg(err)); };
      if (act === 'tab') {
        st.ed.tab = b.dataset.tab;
        $$('[data-dl="tab"]').forEach(function (x) { var on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', on); });
        $$('[data-dl-pane]').forEach(function (p) { p.hidden = p.dataset.dlPane !== st.ed.tab; });
        return;
      }
      if (act === 'run' || act === 'run-full') return api('POST', '/api/downloads/jobs/' + encodeURIComponent(id) + '/run', { full: act === 'run-full' }).then(function () { A().toast(t('dl.started')); loadList(); }, fail);
      if (act === 'stop') return api('POST', '/api/downloads/jobs/' + encodeURIComponent(id) + '/stop', {}).then(function () { A().toast(t('dl.stopping')); loadList(); }, fail);
      if (act === 'delete') {
        var j = (st.list.jobs || []).filter(function (x) { return x.id === id; })[0];
        if (!window.confirm(t('dl.deleteConfirm', { name: j ? j.name : '' }))) return;
        return api('DELETE', '/api/downloads/jobs/' + encodeURIComponent(id)).then(function () { A().toast(t('dl.deleted')); loadList(); }, fail);
      }
      if (act === 'add') { st.ed.added.push({ key: b.dataset.key, title: b.dataset.title, cover: b.dataset.cover || null }); delete st.ed.removed[b.dataset.key]; drawWorks(); return; }
      if (act === 'browse-more') { b.disabled = true; return browse(false); }
      if (act === 'add-shown') {
        var have = inJobKeys();
        (st.ed.search.items || []).forEach(function (it) { if (!have[it.key] && !it.sources.some(function (x) { return have[x.key]; })) { st.ed.added.push({ key: it.key, title: it.title, cover: it.cover ? it.coverKey : null }); delete st.ed.removed[it.key]; } });
        drawWorks(); return;
      }
      if (act === 'unadd') { st.ed.added = st.ed.added.filter(function (w) { return w.key !== b.dataset.key; }); drawWorks(); return; }
      if (act === 'unwork') { st.ed.removed[b.dataset.key] = true; drawWorks(); return; }
      if (act === 'work-up' || act === 'work-down') return moveWork(b.dataset.key, act === 'work-up');
      if (act === 'src-up' || act === 'src-down') { moveLi(b.closest('li'), act === 'src-up'); b.focus(); return; }
      if (act === 'restore') return api('POST', '/api/downloads/jobs/' + encodeURIComponent(st.ed.id) + '/restore-excluded', {}).then(function () { A().toast(t('dl.restored')); st.ed = null; openEditor(A().parseRoute()); }, fail);
      if (act === 'save-run') return save(true);
      if (act === 'retry') return api('POST', '/api/downloads/jobs/' + encodeURIComponent(b.dataset.job) + '/retry', { key: b.dataset.key }).then(function (r) { A().toast(t('dl.retried', { count: r.retried })); openWork(A().parseRoute()); }, fail);
      if (act === 'box-add') {
        var sel = $('#dl-box-job'), key = b.dataset.key;
        if (!sel) return;
        return api('POST', '/api/downloads/jobs/' + encodeURIComponent(sel.value) + '/works', { keys: [key] }).then(function () { A().toast(t('dl.addedToJob')); delete boxes[key]; var el = $('#dl-workbox'); if (el) { el.outerHTML = workBox(key); } }, fail);
      }
    });
    document.addEventListener('submit', function (e) { if (e.target.id === 'dl-form') { e.preventDefault(); save(false); } });
    document.addEventListener('input', function (e) { if (e.target.id === 'dl-search') search(e.target.value); });
    document.addEventListener('keydown', function (e) { if (e.target.id === 'dl-search' && e.key === 'Enter') e.preventDefault(); });
    document.addEventListener('change', function (e) {
      if (e.target.id === 'dl-sched') syncSchedule();
      if (e.target.name === 'dl-list' && st.ed) browse(true); // (the ticked sites' works listed to add)
      if (e.target.id === 'dl-order') { var n = $('#dl-order-note'); if (n) n.textContent = t('dl.orderNote.' + e.target.value); drawWorks(); }
    });
  }

  window.DownloadsPage = { workBox: workBox, forget: function () { boxes = {}; } };
  if (!window.LibraryPages) window.LibraryPages = {};
  var page = {
    title: function (route) { return route.param === 'work' && st.work && st.work.data ? st.work.data.title : t('nav.downloads'); },
    render: function (route) {
      if (route.param === 'new' || route.param === 'job') return editorPage();
      if (route.param === 'work') return workPage();
      return listPage();
    },
    enter: function (route) {
      if (route.param === 'new' || route.param === 'job') return openEditor(route);
      if (route.param === 'work') return openWork(route);
      st.ed = null;
      loadList();
    },
    mount: function () {
      if ($('#dl-sched')) syncSchedule();
      if ($('#dl-works')) drawWorks();
      // (a job with sites ticked: their works listed to add, once)
      if (st.ed && st.ed.job && !st.ed.browsed && $('#dl-results')) { st.ed.browsed = true; if (tickedSites().length) browse(true); }
    }
  };
  // (registered once library.js has made LibraryPages)
  function register() { window.LibraryPages.downloads = page; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { register(); bind(); }); else { register(); bind(); }
})();
