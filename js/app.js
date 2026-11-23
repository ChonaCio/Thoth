(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.from((root || document).querySelectorAll(sel)); };

  // Every page the app knows. Library pages are rendered by js/library.js, the reader by js/reader.js.
  var ROUTES = {
    home: {}, library: {}, series: {}, book: {}, search: {}, read: {},
    collections: {}, collection: {}, readlists: {}, readlist: {},
    settings: { key: 'nav.settings' },
    'manage-libraries': { adminOnly: true },
    'metadata-sources': { adminOnly: true },
    files: { adminOnly: true },
    catalog: {},
    rename: { adminOnly: true }, // old address of File management
    processes: { adminOnly: true },
    'server-settings': { adminOnly: true },
    users: { adminOnly: true, key: 'nav.users' },
    updates: { adminOnly: true, key: 'nav.updates' }
  };
  var THEMES = [
    { id: 'system', icon: 'contrast', key: 'theme.system' },
    { id: 'light', icon: 'light_mode', key: 'theme.light' },
    { id: 'dark', icon: 'dark_mode', key: 'theme.dark' }
  ];
  var MIN_PASSWORD = 8;

  var state = {
    user: null, lang: 'en', theme: 'system',
    authMode: 'login', signupAllowed: false,
    pendingAvatar: undefined, pendingColor: null,
    editingUser: null,
    libraries: [],
    users: { list: null, error: null, query: '', settings: null },
    updates: { current: null, currentError: null, release: {}, push: {}, installing: null, done: null, installError: null }
  };

  /* ---------------- i18n ---------------- */
  function t(key, vars) {
    var dict = TRANSLATIONS[state.lang] || TRANSLATIONS.en;
    var str = dict[key] != null ? dict[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
    if (vars) Object.keys(vars).forEach(function (k) { str = str.split('{' + k + '}').join(vars[k]); });
    return str;
  }
  function has(key) { return TRANSLATIONS.en[key] != null; }
  function applyTranslations() {
    document.documentElement.lang = state.lang;
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n, el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : null); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $$('[data-i18n-title]').forEach(function (el) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
  }
  function detectLang() {
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return LANGUAGES[nav] ? nav : 'en';
  }
  // Turns an API error ({ code, message }) into a translated sentence
  function errMsg(err) {
    if (!err) return '';
    var code = err.code || 'internal';
    if (has('err.' + code)) return t('err.' + code, { min: MIN_PASSWORD });
    if (has('upd.err.' + code)) return t('upd.err.' + code);
    return t('upd.err.generic', { message: err.message || code });
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
  }

  function setPref(kind, value) {
    state[kind] = value;
    var patch = {}; patch[kind] = value;
    Store.savePrefs(patch);
    if (kind === 'theme') applyTheme(); else applyTranslations();
    if (state.user) {
      state.user[kind] = value;
      Store.updateMe(patch).then(function (r) { state.user = r.user; }).catch(function (e) { toast(errMsg(e)); });
    }
    renderAll();
  }

  /* ---------------- avatar ---------------- */
  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0]; }).join('').toUpperCase();
  }
  function paintAvatar(el, user, overrideAvatar, overrideColor) {
    var avatar = overrideAvatar !== undefined ? overrideAvatar : user.avatar;
    el.style.backgroundColor = overrideColor || user.color;
    if (avatar) {
      el.textContent = '';
      el.style.backgroundImage = 'url("' + avatar + '")';
    } else {
      el.style.backgroundImage = '';
      el.textContent = initials(user.displayName);
    }
  }

  function isAdmin() { return Boolean(state.user && state.user.role === 'admin'); }

  /* ---------------- views ---------------- */
  function showLogin(mode) {
    state.user = null;
    state.users = { list: null, error: null, query: '', settings: null };
    var prefs = Store.prefs();
    state.theme = prefs.theme || 'system';
    state.lang = prefs.lang || detectLang();
    applyTheme();
    document.title = 'Thoth';
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#auth-form').reset();
    setAuthMode(mode || 'login');
    renderLoginLang();
    applyTranslations();
    (mode === 'setup' || mode === 'signup' ? $('#reg-name') : $('#auth-username')).focus();
  }

  function showApp(user) {
    state.user = user;
    state.theme = user.theme || 'system';
    state.lang = user.lang || state.lang;
    Store.savePrefs({ theme: state.theme, lang: state.lang });
    applyTheme();
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    sizeTiles();
    $('#auth-form').reset();
    if (!location.hash) history.replaceState(null, '', '#home');
    markHistoryEntry();
    applyTranslations();
    renderAll();
    onRouteEnter();
    refreshLibraries();
    // Admins: is the running server older than its code on disk?
    if (isAdmin()) {
      Store.request('GET', '/api/processes').then(function (r) { setRestartNeeded(r.server.restartNeeded); }, function () {});
    }
  }

  function setRestartNeeded(needed) {
    var changed = Boolean(needed) !== Boolean(state.restartNeeded);
    state.restartNeeded = Boolean(needed);
    if (changed && state.user && currentRoute() !== 'processes') { renderPage(); applyTranslations(); }
  }

  // Libraries shown in the sidebar (only the ones this user may see)
  async function refreshLibraries() {
    try {
      state.libraries = (await Store.libraries()).libraries;
    } catch (e) {
      state.libraries = [];
    }
    if (state.user) {
      renderSidebar(); applyTranslations();
      // Library pages show per-library details (scan button, hidden works link): bring them up to date
      if (currentRoute() === 'library') renderPage();
    }
    return state.libraries;
  }

  function renderAll() {
    if (!state.user) return;
    renderSidebar();
    renderUserInfo();
    renderMenuOptions();
    renderPage();
    applyTranslations();
  }

  /* ---------------- login / first-user setup / sign-up ---------------- */
  function setAuthMode(mode) {
    state.authMode = mode;
    var newAccount = mode !== 'login';
    $$('.new-account-only').forEach(function (el) { el.hidden = !newAccount; });
    $('#auth-title').dataset.i18n = { login: 'login.title', setup: 'login.setupTitle', signup: 'login.registerTitle' }[mode];
    $('#auth-subtitle').dataset.i18n = mode === 'setup' ? 'login.setupSubtitle' : 'login.subtitle';
    $('#auth-submit').dataset.i18n = { login: 'login.signIn', setup: 'login.setupSubmit', signup: 'login.register' }[mode];
    $('#setup-hint').hidden = mode !== 'setup';
    var sw = $('#auth-switch');
    sw.hidden = mode === 'setup' || (mode === 'login' && !state.signupAllowed);
    sw.dataset.i18n = mode === 'signup' ? 'login.haveAccount' : 'login.createAccount';
    $('#auth-password').autocomplete = newAccount ? 'new-password' : 'current-password';
    $('#auth-error').hidden = true;
    applyTranslations();
  }

  function renderLoginLang() {
    $('#login-lang').innerHTML = Object.keys(LANGUAGES).map(function (code) {
      return '<option value="' + code + '"' + (code === state.lang ? ' selected' : '') + '>' + LANGUAGES[code] + '</option>';
    }).join('');
  }

  function showAuthError(msg) {
    $('#auth-error').textContent = msg;
    $('#auth-error').hidden = false;
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    $('#auth-error').hidden = true;
    var submit = $('#auth-submit');
    var username = $('#auth-username').value.trim();
    var password = $('#auth-password').value;
    if (!username || !password) return showAuthError(t('login.required'));

    var mode = state.authMode;
    if (mode !== 'login') {
      if (password.length < MIN_PASSWORD) return showAuthError(errMsg({ code: 'passwordTooShort' }));
      if (password !== $('#auth-password2').value) return showAuthError(errMsg({ code: 'passwordMismatch' }));
    }

    submit.disabled = true;
    try {
      var res;
      if (mode === 'login') {
        res = await Store.login(username, password);
      } else {
        var data = {
          username: username, password: password,
          displayName: $('#reg-name').value.trim(), email: $('#reg-email').value.trim(),
          theme: state.theme, lang: state.lang
        };
        res = mode === 'setup' ? await Store.setup(data) : await Store.signup(data);
      }
      showApp(res.user);
      if (mode === 'setup') toast(t('login.setupDone'));
    } catch (err) {
      if (err.code === 'setupDone') { setAuthMode('login'); }
      if (err.code === 'setupRequired') { setAuthMode('setup'); }
      if (err.code === 'signupDisabled') { state.signupAllowed = false; setAuthMode('login'); }
      showAuthError(errMsg(err));
    } finally {
      submit.disabled = false;
    }
  }

  /* ---------------- routing & sidebar ---------------- */
  // "#series/abc?page=2" → { name: 'series', param: 'abc', query: URLSearchParams, hash }
  function parseRoute() {
    var hash = (location.hash || '#home').slice(1);
    var qi = hash.indexOf('?');
    var pathPart = qi === -1 ? hash : hash.slice(0, qi);
    var parts = pathPart.split('/');
    var name = parts[0] || 'home';
    var route = ROUTES[name];
    if (!route || (route.adminOnly && !isAdmin())) name = 'home';
    return {
      name: name,
      param: parts[1] ? decodeURIComponent(parts[1]) : '',
      query: new URLSearchParams(qi === -1 ? '' : hash.slice(qi + 1)),
      hash: '#' + hash
    };
  }
  function currentRoute() { return parseRoute().name; }

  /* ---------------- tile size ----------------
   * Tiles fill the content area exactly: as many columns as fit at the screen's preferred tile size (larger
   * screens, larger tiles), stretched to use the whole width. Set once on :root, so every grid and shelf on
   * every page uses the same size; recalculated when the window or the sidebar changes. */
  function sizeTiles() {
    var content = $('#content');
    if (!content || !content.clientWidth) return;
    var cs = getComputedStyle(content);
    var width = content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var vw = window.innerWidth;
    var gap = vw <= 600 ? 12 : vw >= 1800 ? 24 : 20;
    var preferred = vw <= 600 ? 140 : vw <= 1100 ? 160 : vw <= 1600 ? 175 : vw <= 2200 ? 195 : 215;
    var cols = Math.max(2, Math.floor((width + gap) / (preferred + gap)));
    var tile = Math.floor((width - gap * (cols - 1)) / cols);
    var root = document.documentElement.style;
    root.setProperty('--tile-cols', cols);
    root.setProperty('--tile-w', tile + 'px');
    root.setProperty('--tile-gap', gap + 'px');
  }
  if (window.ResizeObserver) {
    var tileObserver = new ResizeObserver(function () { sizeTiles(); });
    document.addEventListener('DOMContentLoaded', function () { var c = $('#content'); if (c) tileObserver.observe(c); sizeTiles(); });
    if (document.readyState !== 'loading') { var c0 = $('#content'); if (c0) tileObserver.observe(c0); }
  }
  window.addEventListener('resize', sizeTiles);

  /* ---------------- scroll position per history entry ----------------
   * Every history entry gets a key (history.state.k). The scroll position is remembered per key. A new entry
   * (following a link) starts at the top; coming back to an entry (Back/Forward) scrolls to where the user
   * left it as soon as the page has loaded enough content (pages load their data after rendering). */
  var scrollMem = {}, scrollKey = null, scrollPending = null;
  try { history.scrollRestoration = 'manual'; } catch (e) { /* old browser */ }
  function markHistoryEntry() {
    var k = history.state && history.state.k;
    if (k) {
      scrollKey = k;
      var y = scrollMem[k] || 0;
      scrollPending = y > 0 ? { y: y, until: Date.now() + 10000 } : null;
      if (!scrollPending) window.scrollTo(0, 0);
      return;
    }
    k = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { history.replaceState(Object.assign({}, history.state || {}, { k: k }), ''); } catch (e) { /* ignore */ }
    scrollKey = k; scrollPending = null;
    window.scrollTo(0, 0);
  }
  // Called after anything renders: scroll back to the remembered spot once the page is tall enough
  function restoreScroll() {
    var p = scrollPending;
    if (!p) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= p.y - 2) { scrollPending = null; window.scrollTo(0, p.y); }
    else if (Date.now() > p.until) { scrollPending = null; window.scrollTo(0, Math.max(0, max)); }
  }
  window.addEventListener('scroll', function () { if (scrollKey && !scrollPending) scrollMem[scrollKey] = window.scrollY; }, { passive: true });
  // The user scrolling or clicking takes over
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) {
    window.addEventListener(ev, function () { scrollPending = null; }, { passive: true });
  });

  function onRouteEnter() {
    var route = parseRoute();
    if (route.name === 'updates') loadCurrentVersion();
    if (route.name === 'users') loadUsers();
    if (window.LibraryPages && LibraryPages[route.name] && LibraryPages[route.name].enter) LibraryPages[route.name].enter(route);
    if (window.Reader) {
      if (route.name === 'read') Reader.open(route); else Reader.close();
    }
    var search = $('#search');
    if (search && route.name === 'search') search.value = route.query.get('q') || '';
  }

  // Sidebar: Home, each library, collections, read lists, then admin pages and settings
  function navItems() {
    var items = [{ href: '#home', icon: 'home', key: 'nav.home' }];
    if (state.libraries.length) {
      items.push({ header: 'nav.libraries' });
      if (state.libraries.length > 1) items.push({ href: '#library/all', icon: 'library', key: 'nav.allLibraries' });
      state.libraries.forEach(function (l) { items.push({ href: '#library/' + l.id, icon: 'library', label: l.name }); });
    }
    items.push({ href: '#collections', icon: 'collections', key: 'nav.collections', match: ['collections', 'collection'] });
    items.push({ href: '#readlists', icon: 'readlist', key: 'nav.readlists', match: ['readlists', 'readlist'] });
    items.push({ href: '#catalog', icon: 'travel_explore', key: 'nav.catalog', match: ['catalog'] });
    items.push({ divider: true });
    if (isAdmin()) {
      items.push({ href: '#manage-libraries', icon: 'storage', key: 'nav.manageLibraries' });
      items.push({ href: '#metadata-sources', icon: 'dataset', key: 'nav.metadataSources' });
      items.push({ href: '#files', icon: 'folder_open', key: 'nav.files', match: ['files', 'rename'] });
      items.push({ href: '#processes', icon: 'memory', key: 'nav.processes' });
      items.push({ href: '#server-settings', icon: 'tune', key: 'nav.serverSettings' });
      items.push({ href: '#users', icon: 'group', key: 'nav.users' });
      items.push({ href: '#updates', icon: 'update', key: 'nav.updates' });
    }
    items.push({ href: '#settings', icon: 'settings', key: 'nav.settings' });
    return items;
  }

  function renderSidebar() {
    var route = parseRoute();
    var current = '#' + route.name + (route.param ? '/' + route.param : '');
    $('#sidebar-list').innerHTML = navItems().map(function (n) {
      if (n.divider) return '<li><hr class="divider" /></li>';
      if (n.header) return '<li class="nav-header" data-i18n="' + n.header + '"></li>';
      var active = n.href === current || (n.match && n.match.indexOf(route.name) !== -1);
      var label = n.key ? '<span class="nav-item__label" data-i18n="' + n.key + '"></span>' : '<span class="nav-item__label">' + esc(n.label) + '</span>';
      return '<li><a href="' + n.href + '" class="nav-item' + (active ? ' is-active' : '') + '"' +
        (active ? ' aria-current="page"' : '') + ' title="' + esc(n.label || t(n.key)) + '">' +
        '<span data-icon="' + n.icon + '"></span>' + label + '</a></li>';
    }).join('');
    renderIcons($('#sidebar'));
  }

  // Phones (drawer) and tablets (icon rail): the menu button opens the full sidebar over the content
  var OVERLAY_NAV = '(max-width: 1024px)';
  function isOverlayNav() { return window.matchMedia(OVERLAY_NAV).matches; }

  function toggleSidebar(force) {
    var app = $('#app-view');
    if (isOverlayNav()) {
      var open = force != null ? force : !app.classList.contains('sidebar-open');
      app.classList.toggle('sidebar-open', open);
      $('#scrim').hidden = !open;
    } else {
      var collapsed = force != null ? !force : !app.classList.contains('sidebar-collapsed');
      app.classList.toggle('sidebar-collapsed', collapsed);
      try { localStorage.setItem('thoth.sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- account menu ---------------- */
  function renderUserInfo() {
    var u = state.user;
    paintAvatar($('#topbar-avatar'), u);
    paintAvatar($('#menu-avatar'), u);
    $('#account-btn').title = u.displayName + '\n' + (u.email || '@' + u.username);
    $('#account-btn').setAttribute('aria-label', u.displayName);
    $('#menu-email').textContent = u.email || '';
    $('#menu-email').hidden = !u.email;
    $('#menu-greeting').textContent = t('menu.greeting', { name: u.displayName.split(' ')[0] });
    $('#menu-username').textContent = '@' + u.username;
    $('#menu-role').dataset.i18n = 'role.' + u.role;
    $('#menu-role').className = 'badge' + (u.role === 'admin' ? ' badge--primary' : '');
    $$('.admin-only').forEach(function (el) { el.hidden = !isAdmin(); });
  }

  function renderMenuOptions() {
    $('#menu-theme-value').textContent = t('theme.' + state.theme);
    $('#menu-lang-value').textContent = LANGUAGES[state.lang];

    $('#theme-options').innerHTML = THEMES.map(function (th) {
      var sel = th.id === state.theme;
      return '<button class="menu-item' + (sel ? ' is-selected' : '') + '" data-theme-choice="' + th.id + '" role="menuitemradio" aria-checked="' + sel + '">' +
        '<span data-icon="' + th.icon + '"></span><span class="menu-item__label" data-i18n="' + th.key + '"></span>' +
        (sel ? '<span data-icon="check"></span>' : '') + '</button>';
    }).join('');

    $('#lang-options').innerHTML = Object.keys(LANGUAGES).map(function (code) {
      var sel = code === state.lang;
      return '<button class="menu-item' + (sel ? ' is-selected' : '') + '" data-lang-choice="' + code + '" role="menuitemradio" aria-checked="' + sel + '" lang="' + code + '">' +
        '<span class="menu-item__check">' + (sel ? '<span data-icon="check"></span>' : '') + '</span>' +
        '<span class="menu-item__label">' + LANGUAGES[code] + '</span></button>';
    }).join('');
    renderIcons($('#account-menu'));
  }

  function showPanel(name) {
    $$('#account-menu [data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
  }

  function toggleAccountMenu(force) {
    var menu = $('#account-menu');
    var open = force != null ? force : menu.hidden;
    menu.hidden = !open;
    $('#account-btn').setAttribute('aria-expanded', String(open));
    if (open) showPanel('main');
  }

  function go(hash) {
    toggleAccountMenu(false);
    if (location.hash === hash) { renderPage(); onRouteEnter(); } else location.hash = hash;
  }

  async function signOut(silentMessage) {
    toggleAccountMenu(false);
    if (window.Reader) Reader.close();
    if (window.LibraryPages && LibraryPages.reset) LibraryPages.reset();
    state.libraries = [];
    try { await Store.logout(); } catch (e) { /* already signed out */ }
    history.replaceState(null, '', location.pathname);
    var s = await Store.session().catch(function () { return {}; });
    state.signupAllowed = Boolean(s.signupAllowed);
    showLogin('login');
    toast(silentMessage || t('toast.signedOut'));
  }

  /* ---------------- profile dialog ---------------- */
  function openProfile() {
    toggleAccountMenu(false);
    var u = state.user;
    state.pendingAvatar = undefined;
    state.pendingColor = null;
    $('#profile-name').value = u.displayName;
    $('#profile-username').value = u.username;
    $('#profile-email').value = u.email || '';
    $('#profile-bio').value = u.bio || '';
    $('#pw-current').value = $('#pw-new').value = $('#pw-confirm').value = '';
    $('#password-section').open = false;
    $('#profile-error').hidden = true;
    renderSwatches();
    paintAvatar($('#profile-avatar'), u);
    $('#profile-dialog').showModal();
    $('#profile-name').focus();
  }

  function renderSwatches() {
    var current = state.pendingColor || state.user.color;
    $('#profile-swatches').innerHTML = Store.AVATAR_COLORS.map(function (c) {
      return '<button type="button" class="swatch' + (c === current ? ' is-selected' : '') + '" data-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
    }).join('');
  }

  function refreshProfilePreview() {
    var preview = Object.assign({}, state.user, { displayName: $('#profile-name').value || state.user.displayName });
    paintAvatar($('#profile-avatar'), preview, state.pendingAvatar, state.pendingColor);
  }

  function profileError(msg) {
    $('#profile-error').textContent = msg;
    $('#profile-error').hidden = false;
  }

  function onPhotoChosen(e) {
    var file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return profileError(t('profile.imageTooLarge'));
    // Crop to a square and downscale to 256px before uploading
    var img = new Image();
    var reader = new FileReader();
    reader.onload = function () { img.src = reader.result; };
    img.onload = function () {
      var size = 256, canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      var s = Math.min(img.width, img.height);
      canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      state.pendingAvatar = canvas.toDataURL('image/jpeg', 0.85);
      $('#profile-error').hidden = true;
      refreshProfilePreview();
    };
    reader.readAsDataURL(file);
  }

  async function onProfileSave(e) {
    e.preventDefault();
    $('#profile-error').hidden = true;
    var name = $('#profile-name').value.trim();
    if (!name) return profileError(errMsg({ code: 'displayNameRequired' }));

    var current = $('#pw-current').value, next = $('#pw-new').value, confirm = $('#pw-confirm').value;
    var changingPassword = Boolean(current || next || confirm);
    if (changingPassword) {
      if (!current) return profileError(errMsg({ code: 'wrongPassword' }));
      if (next.length < MIN_PASSWORD) return profileError(errMsg({ code: 'passwordTooShort' }));
      if (next !== confirm) return profileError(errMsg({ code: 'passwordMismatch' }));
    }

    var patch = { displayName: name, email: $('#profile-email').value.trim(), bio: $('#profile-bio').value.trim() };
    if (state.pendingAvatar !== undefined) patch.avatar = state.pendingAvatar;
    if (state.pendingColor) patch.color = state.pendingColor;

    var btn = $('#profile-save');
    btn.disabled = true;
    try {
      if (changingPassword) await Store.changePassword(current, next);
      var res = await Store.updateMe(patch);
      state.user = res.user;
      $('#profile-dialog').close();
      renderAll();
      toast(changingPassword ? t('profile.passwordChanged') : t('profile.saved'));
    } catch (err) {
      if (err.code === 'wrongPassword') $('#password-section').open = true;
      profileError(errMsg(err));
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(state.lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------------- pages ---------------- */
  function renderPage() {
    var info = parseRoute();
    var route = info.name;
    var u = state.user;
    var html, title;
    var libPage = window.LibraryPages && LibraryPages[route];
    if (libPage) {
      html = libPage.render(info);
      title = libPage.title ? libPage.title(info) : '';
    } else if (route === 'settings') {
      html =
        '<h1 class="page-title">' + esc(t('nav.settings')) + '</h1>' +
        '<div class="cards"><section class="card">' +
          '<div class="field"><label for="set-theme">' + esc(t('menu.appearance')) + '</label><select id="set-theme" class="select">' +
            THEMES.map(function (th) { return '<option value="' + th.id + '"' + (th.id === state.theme ? ' selected' : '') + '>' + esc(t(th.key)) + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label for="set-lang">' + esc(t('menu.language')) + '</label><select id="set-lang" class="select">' +
            Object.keys(LANGUAGES).map(function (c) { return '<option value="' + c + '"' + (c === state.lang ? ' selected' : '') + '>' + LANGUAGES[c] + '</option>'; }).join('') +
          '</select></div>' +
          '<button class="btn btn--outline btn--pill" data-action="edit-profile">' + esc(t('menu.editProfile')) + '</button>' +
        '</section></div>';
    } else if (route === 'updates') {
      html = renderUpdatesPage();
    } else if (route === 'users') {
      html = renderUsersPage();
    }
    if (!title && ROUTES[route] && ROUTES[route].key) title = t(ROUTES[route].key);
    // Admins: the server code on disk is newer than the running server (after an update or git pull)
    if (state.restartNeeded && isAdmin() && route !== 'processes') {
      html = '<div class="banner banner--info"><span>' + esc(t('proc.restartNeeded')) + '</span>' +
        '<a class="btn btn--primary" href="#processes">' + esc(t('proc.restartNeededLink')) + '</a></div>' + (html || '');
    }
    $('#content').innerHTML = html || '';
    if (route === 'users') renderUsersTable();
    if (libPage && libPage.mount) libPage.mount($('#content'), info);
    renderIcons($('#content'));
    document.title = (title ? title + ' – ' : '') + 'Thoth';
    restoreScroll();
  }

  /* ---------------- user management ---------------- */
  async function loadUsers() {
    try {
      var results = await Promise.all([Store.users.list(), Store.settings.get()]);
      state.users.list = results[0].users;
      state.users.settings = results[1];
      state.users.error = null;
    } catch (e) {
      state.users.error = e;
    }
    if (currentRoute() === 'users') renderPage();
  }

  function renderUsersPage() {
    var s = state.users;
    var html =
      '<h1 class="page-title">' + esc(t('users.title')) + '</h1>' +
      '<p class="page-lead">' + esc(t('users.intro')) + '</p>';
    if (s.error) return html + '<div class="banner banner--error">' + esc(errMsg(s.error)) + '</div>';

    html +=
      '<div class="toolbar">' +
        '<label class="search-field">' +
          '<span data-icon="search"></span>' +
          '<input type="search" id="users-search" placeholder="' + esc(t('users.search')) + '" value="' + esc(s.query) + '" />' +
        '</label>' +
        '<button class="btn btn--primary" data-action="add-user"><span data-icon="person_add"></span>' + esc(t('users.add')) + '</button>' +
      '</div>' +
      '<section class="card card--wide card--flush">' +
        '<div class="table-wrap" id="users-table"></div>' +
      '</section>' +
      '<section class="card card--wide">' +
        '<h2 class="card__title">' + esc(t('users.signupTitle')) + '</h2>' +
        '<label class="switch-row">' +
          '<input type="checkbox" id="signup-toggle"' + (s.settings && s.settings.signupAllowed ? ' checked' : '') + (s.settings ? '' : ' disabled') + ' />' +
          '<span><strong>' + esc(t('users.signupLabel')) + '</strong><br><span class="muted small">' + esc(t('users.signupHelp')) + '</span></span>' +
        '</label>' +
      '</section>';
    return html;
  }

  function renderUsersTable() {
    var wrap = $('#users-table');
    if (!wrap) return;
    var list = state.users.list;
    if (!list) { wrap.innerHTML = '<p class="muted table-empty">…</p>'; return; }
    var q = state.users.query.trim().toLowerCase();
    var rows = list.filter(function (u) {
      return !q || [u.displayName, u.username, u.email, t('role.' + u.role)].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var me = state.user.username.toLowerCase();
    var html =
      '<table class="table">' +
        '<caption class="table-caption">' + esc(t('users.count', { count: rows.length })) + '</caption>' +
        '<thead><tr>' +
          '<th>' + esc(t('users.colUser')) + '</th>' +
          '<th class="col-email">' + esc(t('users.colEmail')) + '</th>' +
          '<th>' + esc(t('users.colRole')) + '</th>' +
          '<th>' + esc(t('users.colStatus')) + '</th>' +
          '<th class="col-last">' + esc(t('users.colLastLogin')) + '</th>' +
          '<th class="col-actions"><span class="visually-hidden">' + esc(t('users.actions')) + '</span></th>' +
        '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr><td colspan="6" class="table-empty">' + esc(t('users.empty')) + '</td></tr>';
    }
    rows.forEach(function (u) {
      var self = u.username.toLowerCase() === me;
      html +=
        '<tr' + (u.disabled ? ' class="is-disabled"' : '') + '>' +
          '<td class="col-user"><div class="user-cell">' +
            '<span class="avatar avatar--sm" data-avatar-for="' + esc(u.username) + '"></span>' +
            '<div class="user-cell__text"><div class="user-cell__name">' + esc(u.displayName) +
              (self ? ' <span class="badge">' + esc(t('users.you')) + '</span>' : '') + '</div>' +
              '<div class="muted small">@' + esc(u.username) + '</div></div>' +
          '</div></td>' +
          '<td class="col-email">' + (u.email ? esc(u.email) : '<span class="muted">—</span>') + '</td>' +
          '<td class="col-role"><span class="badge' + (u.role === 'admin' ? ' badge--primary' : '') + '">' + esc(t('role.' + u.role)) + '</span></td>' +
          '<td class="col-status"><span class="badge' + (u.disabled ? ' badge--danger' : ' badge--ok') + '">' + esc(t(u.disabled ? 'users.disabled' : 'users.active')) + '</span></td>' +
          '<td class="col-last">' + (u.lastLoginAt ? esc(fmtDate(u.lastLoginAt)) : '<span class="muted">' + esc(t('users.never')) + '</span>') + '</td>' +
          '<td class="col-actions">' +
            '<button class="icon-btn icon-btn--sm" data-action="edit-user" data-username="' + esc(u.username) + '" data-icon="edit" title="' + esc(t('users.edit')) + '" aria-label="' + esc(t('users.edit') + ' ' + u.username) + '"></button>' +
            (self ? '' : '<button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete-user" data-username="' + esc(u.username) + '" data-icon="delete" title="' + esc(t('users.delete')) + '" aria-label="' + esc(t('users.delete') + ' ' + u.username) + '"></button>') +
          '</td>' +
        '</tr>';
    });
    wrap.innerHTML = html + '</tbody></table>';
    $$('[data-avatar-for]', wrap).forEach(function (el) {
      var u = list.filter(function (x) { return x.username === el.dataset.avatarFor; })[0];
      if (u) paintAvatar(el, u);
    });
    renderIcons(wrap);
  }

  function findUser(username) {
    return (state.users.list || []).filter(function (u) { return u.username === username; })[0] || null;
  }

  function openUserDialog(user) {
    state.editingUser = user;
    var editing = Boolean(user);
    var self = editing && user.username.toLowerCase() === state.user.username.toLowerCase();
    $('#user-dialog-title').dataset.i18n = editing ? 'users.editTitle' : 'users.newTitle';
    $('#user-name').value = editing ? user.displayName : '';
    $('#user-username').value = editing ? user.username : '';
    $('#user-username').disabled = editing;
    $('#user-username-help').dataset.i18n = editing ? 'profile.usernameHelp' : 'field.usernameHelp';
    $('#user-email').value = editing ? (user.email || '') : '';
    $('#user-role').value = editing ? user.role : 'user';
    $('#user-role').disabled = self;
    $('#user-password').value = '';
    $('#user-password-label').dataset.i18n = editing ? 'field.newPassword' : 'field.password';
    $('#user-password-help').dataset.i18n = editing ? 'users.passwordKeep' : 'field.passwordHelp';
    $('#user-active-row').hidden = !editing;
    $('#user-active').checked = editing ? !user.disabled : true;
    $('#user-active').disabled = self;
    $('#user-error').hidden = true;
    renderLibraryAccess(editing ? user.libraries : null);
    applyTranslations();
    $('#user-dialog').showModal();
    $('#user-name').focus();
  }

  // "All libraries" or a checklist of libraries; hidden for administrators (they see everything)
  function renderLibraryAccess(selected) {
    var all = !Array.isArray(selected);
    $('#access-all').checked = all;
    $('#access-some').checked = !all;
    var libs = state.libraries;
    $('#access-list').innerHTML = libs.length
      ? libs.map(function (l) {
          var on = !all && selected.indexOf(l.id) !== -1;
          return '<label class="checkbox"><input type="checkbox" value="' + esc(l.id) + '"' + (on ? ' checked' : '') + ' /><span>' + esc(l.name) + '</span></label>';
        }).join('')
      : '<p class="muted small" data-i18n="users.noLibraries"></p>';
    syncLibraryAccess();
  }
  function syncLibraryAccess() {
    var admin = $('#user-role').value === 'admin';
    $('#access-admin-note').hidden = !admin;
    $('#access-options').hidden = admin;
    $$('#access-list input').forEach(function (i) { i.disabled = $('#access-all').checked; });
  }
  function libraryAccessValue() {
    if ($('#user-role').value === 'admin' || $('#access-all').checked) return null;
    return $$('#access-list input:checked').map(function (i) { return i.value; });
  }

  function userError(msg) {
    $('#user-error').textContent = msg;
    $('#user-error').hidden = false;
  }

  async function onUserSave(e) {
    e.preventDefault();
    $('#user-error').hidden = true;
    var editing = state.editingUser;
    var name = $('#user-name').value.trim();
    var password = $('#user-password').value;
    if (!name) return userError(errMsg({ code: 'displayNameRequired' }));
    if (!editing && !$('#user-username').value.trim()) return userError(t('login.required'));
    if ((!editing || password) && password.length < MIN_PASSWORD) return userError(errMsg({ code: 'passwordTooShort' }));

    var btn = $('#user-save');
    btn.disabled = true;
    try {
      var res;
      if (editing) {
        var patch = { displayName: name, email: $('#user-email').value.trim() };
        if (!$('#user-role').disabled) patch.role = $('#user-role').value;
        if (!$('#user-active').disabled) patch.disabled = !$('#user-active').checked;
        if (password) patch.password = password;
        patch.libraries = libraryAccessValue();
        res = await Store.users.update(editing.username, patch);
        if (res.user.username.toLowerCase() === state.user.username.toLowerCase()) {
          state.user = res.user;
          renderUserInfo();
        }
        toast(t('users.saved'));
      } else {
        res = await Store.users.create({
          displayName: name, username: $('#user-username').value.trim(), email: $('#user-email').value.trim(),
          role: $('#user-role').value, password: password, libraries: libraryAccessValue()
        });
        toast(t('users.created', { username: res.user.username }));
      }
      $('#user-dialog').close();
      await loadUsers();
    } catch (err) {
      userError(errMsg(err));
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteUser(username) {
    var u = findUser(username);
    if (!u) return;
    if (!window.confirm(t('users.confirmDelete', { name: u.displayName, username: u.username }))) return;
    try {
      await Store.users.remove(u.username);
      toast(t('users.deleted'));
      await loadUsers();
    } catch (err) {
      toast(errMsg(err));
    }
  }

  async function onSignupToggle(input) {
    try {
      state.users.settings = await Store.settings.update({ signupAllowed: input.checked });
      toast(t(input.checked ? 'users.signupOn' : 'users.signupOff'));
    } catch (err) {
      input.checked = !input.checked;
      toast(errMsg(err));
    }
  }

  /* ---------------- updates ---------------- */
  async function loadCurrentVersion() {
    try {
      state.updates.current = await Store.request('GET', '/api/version');
      state.updates.currentError = null;
    } catch (e) {
      state.updates.currentError = e;
    }
    if (currentRoute() === 'updates') renderPage();
  }

  async function checkUpdates(channel) {
    var u = state.updates;
    u[channel] = { loading: true };
    u.done = null; u.installError = null;
    renderPage();
    try {
      var result = await Store.request('GET', '/api/updates/check?channel=' + channel);
      u[channel] = { result: result };
      u.current = result.current;
    } catch (e) {
      u[channel] = { error: e };
    }
    if (currentRoute() === 'updates') renderPage();
  }

  // relation: 'newer' | 'current' (reinstall) | 'older' (downgrade)
  async function installUpdate(channel, tag, relation) {
    if (!window.confirm(t(relation === 'older' ? 'upd.confirmDowngrade' : relation === 'current' ? 'upd.confirmReinstall' : 'upd.confirm', { tag: tag }))) return;
    var u = state.updates;
    u.installing = tag; u.done = null; u.installError = null;
    renderPage();
    var oldPid = await serverPid();
    try {
      var result = await Store.request('POST', '/api/updates/install', { channel: channel, tag: tag });
      u.done = result;
      u.current = result.current;
      u.release = {}; u.push = {};
      toast(t('upd.success', { tag: tag }));
      if (result.autoRestart) waitForRestartThenReload(oldPid);
    } catch (e) {
      u.installError = e;
    }
    u.installing = null;
    if (currentRoute() === 'updates') renderPage();
  }

  // The running server's process ID (changes when it restarts); null if unknown
  async function serverPid() {
    try {
      var res = await fetch('/api/processes', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).server.pid || null;
    } catch (e) { return null; }
  }
  // The server restarts itself after a server-code update (built-in supervisor, or systemd/Docker);
  // reload once the new server process answers
  async function waitForRestartThenReload(oldPid) {
    for (var i = 0; i < 60; i++) {
      await new Promise(function (r) { setTimeout(r, 750); });
      if (!oldPid) {
        // Server without the Processes API: wait a few seconds, then reload once it answers
        try { if (i >= 4 && (await fetch('/api/session', { cache: 'no-store' })).ok) { location.reload(); return; } } catch (e) { /* restarting */ }
        continue;
      }
      var pid = await serverPid();
      if (pid !== null && pid !== oldPid) { location.reload(); return; }
    }
    state.updates.done.autoRestart = false;
    state.updates.done.restartRequired = true;
    if (currentRoute() === 'updates') renderPage();
  }

  // Every version of the channel, to install any of them: the installed one, newer ones and older ones
  // (downgrade). Folded away unless opened.
  function allVersionsHtml(channel, r) {
    var u = state.updates, list = r.versions || [];
    if (list.length < 2 && !(list.length === 1 && list[0].relation !== 'current')) return '';
    return '<details class="update-all"' + (u.openAll && u.openAll[channel] ? ' open' : '') + ' data-all="' + channel + '">' +
      '<summary>' + esc(t('upd.allVersions', { count: list.length })) + '</summary>' +
      '<p class="muted small">' + esc(t('upd.allVersionsHelp')) + '</p>' +
      '<ul class="update-list update-list--all">' + list.map(function (item) {
        var rel = item.relation;
        return '<li class="update-item' + (rel === 'current' ? ' is-current' : '') + '">' +
          '<div class="update-item__info">' +
            '<span class="update-item__tag">' + esc(item.tag) + '</span>' +
            (rel === 'current' ? '<span class="badge badge--ok">' + esc(t('upd.installedBadge')) + '</span>' : rel === 'older' ? '<span class="badge">' + esc(t('upd.olderBadge')) + '</span>' : '<span class="badge badge--primary">' + esc(t('upd.newerBadge')) + '</span>') +
            (item.date ? '<span class="muted small">' + esc(fmtDate(item.date)) + '</span>' : '') +
            '<a class="small" href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(t('upd.view')) + '</a>' +
          '</div>' +
          '<button class="btn btn--text" data-action="install" data-channel="' + channel + '" data-relation="' + rel + '" data-tag="' + esc(item.tag) + '"' + (u.installing ? ' disabled' : '') + '>' +
            '<span data-icon="' + (rel === 'older' ? 'history' : 'download') + '"></span>' +
            esc(u.installing === item.tag ? t('upd.installing', { tag: item.tag }) : t(rel === 'older' ? 'upd.downgrade' : rel === 'current' ? 'upd.reinstall' : 'upd.install')) +
          '</button>' +
        '</li>';
      }).join('') + '</ul></details>';
  }

  function renderChannelCard(channel) {
    var u = state.updates, c = u[channel] || {};
    var isRel = channel === 'release';
    var html =
      '<section class="card update-card">' +
        '<div class="update-card__head">' +
          '<h2 class="card__title">' + esc(t(isRel ? 'upd.releasesTitle' : 'upd.pushesTitle')) + '</h2>' +
          '<p class="muted">' + esc(t(isRel ? 'upd.releasesDesc' : 'upd.pushesDesc')) + '</p>' +
        '</div>' +
        '<button class="btn btn--outline btn--pill" data-action="check" data-channel="' + channel + '"' + (c.loading || u.installing ? ' disabled' : '') + '>' +
          '<span data-icon="update"></span>' + esc(c.loading ? t('upd.checking') : t(isRel ? 'upd.checkReleases' : 'upd.checkPushes')) +
        '</button>';

    if (c.error) {
      html += '<p class="notice notice--error">' + esc(errMsg(c.error)) + '</p>';
    } else if (c.result) {
      var r = c.result;
      if (!r.latest) {
        html += '<p class="notice">' + esc(t(isRel ? 'upd.noReleases' : 'upd.noPushes')) + '</p>';
      } else if (!r.updateAvailable) {
        html += '<p class="notice notice--ok"><span data-icon="check"></span>' + esc(t('upd.upToDate')) + ' ' + esc(t('upd.latest', { tag: r.latest.tag })) + '</p>';
      } else {
        html += '<p class="notice notice--info">' + esc(r.newer.length === 1 ? t('upd.availableOne') : t('upd.availableMany', { count: r.newer.length })) + '</p>';
        html += '<ul class="update-list">' + r.newer.map(function (item, i) {
          var badge = isRel
            ? (item.prerelease ? '<span class="badge">' + esc(t('upd.prerelease')) + '</span>' : '')
            : '<span class="badge' + (item.released ? ' badge--ok' : '') + '">' + esc(t(item.released ? 'upd.released' : 'upd.unreleased')) + '</span>';
          return '<li class="update-item">' +
            '<div class="update-item__info">' +
              '<span class="update-item__tag">' + esc(item.tag) + '</span>' + badge +
              (item.date ? '<span class="muted small">' + esc(fmtDate(item.date)) + '</span>' : '') +
              '<a class="small" href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(t('upd.view')) + '</a>' +
            '</div>' +
            '<button class="btn ' + (i === 0 ? 'btn--primary' : 'btn--text') + '" data-action="install" data-channel="' + channel + '" data-tag="' + esc(item.tag) + '"' + (u.installing ? ' disabled' : '') + '>' +
              '<span data-icon="download"></span>' + esc(u.installing === item.tag ? t('upd.installing', { tag: item.tag }) : t('upd.install')) +
            '</button>' +
          '</li>';
        }).join('') + '</ul>';
      }
      html += allVersionsHtml(channel, r);
      html += '<p class="muted small">' + esc(t('upd.lastChecked', { time: fmtDate(r.checkedAt) })) + '</p>';
    }
    return html + '</section>';
  }

  // "p2" or "p2 +3 commits": a tag plus how far the running code is past it
  function versionLabel(tag, ahead) {
    var html = esc(tag);
    if (ahead > 0) html += ' <span class="muted small">' + esc(ahead === 1 ? t('upd.aheadOne') : t('upd.ahead', { count: ahead })) + '</span>';
    return html;
  }

  function renderVersionInfo(cur, repo) {
    if (!cur) return '<p class="muted">…</p>';
    var none = '<span class="muted">' + esc(t('upd.none')) + '</span>';
    var commitLink = cur.commit
      ? '<a href="https://github.com/' + esc(repo) + '/commit/' + esc(cur.commit) + '" target="_blank" rel="noopener"><code>' + esc(cur.commit.slice(0, 7)) + '</code></a>' +
        (cur.branch ? ' <span class="muted small">' + esc(cur.branch) + '</span>' : '')
      : '<span class="muted">' + esc(t('upd.unknown')) + '</span>';
    var html = '<dl class="pref-list">' +
      '<dt>' + esc(t('upd.release')) + '</dt><dd>' + (cur.release ? versionLabel(cur.release, cur.releaseAhead) : none) + '</dd>' +
      '<dt>' + esc(t('upd.push')) + '</dt><dd>' + (cur.push != null ? versionLabel('p' + cur.push, cur.pushAhead) : none) + '</dd>' +
      '<dt>' + esc(t('upd.commit')) + '</dt><dd>' + commitLink + '</dd>' +
      (cur.origin ? '<dt>' + esc(t('upd.origin')) + '</dt><dd>' + esc(t('upd.origin.' + cur.origin)) + '</dd>' : '') +
      (cur.installedAt ? '<dt>' + esc(t('upd.installedAt')) + '</dt><dd>' + esc(fmtDate(cur.installedAt)) + '</dd>' : '') +
      '<dt>' + esc(t('upd.source')) + '</dt><dd><a href="https://github.com/' + esc(repo) + '" target="_blank" rel="noopener">' + esc(repo) + '</a></dd>' +
    '</dl>';
    if (!cur.commit) html += '<p class="notice">' + esc(t('upd.unknownVersion')) + '</p>';
    else if (cur.published === false) html += '<p class="notice notice--info">' + esc(t('upd.unpublished')) + '</p>';
    else if (cur.error) html += '<p class="notice notice--error">' + esc(t('upd.versionOffline')) + '</p>';
    return html;
  }

  function renderUpdatesPage() {
    var u = state.updates, cur = u.current;
    var repo = cur ? cur.repo : 'ChonaCio/Thoth';
    var html =
      '<h1 class="page-title">' + esc(t('upd.title')) + '</h1>' +
      '<p class="page-lead">' + esc(t('upd.intro', { repo: 'github.com/' + repo })) + '</p>';

    if (u.done) {
      html += '<div class="banner banner--ok"><div><strong>' + esc(t('upd.success', { tag: u.done.installed })) + '</strong>' +
        (u.done.autoRestart ? '<p>' + esc(t('upd.restarting')) + '</p>'
          : u.done.restartRequired ? '<p>' + esc(t('upd.restart')) + '</p>' : '') +
        // How it was installed: only the changed files (delta) or the whole version
        (u.done.mode ? '<p class="small">' + esc(t(u.done.mode === 'delta' ? 'upd.modeDelta' : 'upd.modeFull', { files: u.done.files, removed: u.done.removed || 0 })) + '</p>' : '') +
        (u.done.backup ? '<p class="small">' + esc(t('upd.backup', { path: u.done.backup })) + '</p>' : '') + '</div>' +
        '<button class="btn btn--primary" data-action="reload">' + esc(t('upd.reload')) + '</button></div>';
    }
    if (u.installError) html += '<div class="banner banner--error">' + esc(errMsg(u.installError)) + '</div>';

    html += '<div class="cards">' +
      '<section class="card">' +
        '<h2 class="card__title">' + esc(t('upd.current')) + '</h2>' +
        (u.currentError
          ? '<p class="notice notice--error">' + esc(errMsg(u.currentError)) + '</p>'
          : renderVersionInfo(cur, repo)) +
      '</section>' +
      renderChannelCard('release') +
      renderChannelCard('push') +
    '</div>';
    return html;
  }

  /* ---------------- toast ---------------- */
  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ---------------- wire up ---------------- */
  function bind() {
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#auth-switch').addEventListener('click', function () { setAuthMode(state.authMode === 'signup' ? 'login' : 'signup'); });
    $('#toggle-password').addEventListener('click', function () {
      var input = $('#auth-password');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      this.dataset.icon = show ? 'visibility_off' : 'visibility';
      renderIcons(this.parentNode);
    });
    $('#login-lang').addEventListener('change', function () { setPref('lang', this.value); });

    $('#menu-toggle').addEventListener('click', function () { toggleSidebar(); });
    $('#scrim').addEventListener('click', function () { toggleSidebar(false); });
    $('#sidebar').addEventListener('click', function (e) { if (e.target.closest('a') && isOverlayNav()) toggleSidebar(false); });

    $('#account-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleAccountMenu(); });
    $('#account-menu').addEventListener('click', function (e) {
      e.stopPropagation();
      var goto = e.target.closest('[data-goto]');
      if (goto) return showPanel(goto.dataset.goto);
      var th = e.target.closest('[data-theme-choice]');
      if (th) { setPref('theme', th.dataset.themeChoice); toast(t('toast.theme')); return; }
      var lg = e.target.closest('[data-lang-choice]');
      if (lg) { setPref('lang', lg.dataset.langChoice); toast(t('toast.lang')); return; }
    });
    $('#menu-edit-profile').addEventListener('click', openProfile);
    $('#menu-avatar-edit').addEventListener('click', openProfile);
    $('#menu-settings').addEventListener('click', function () { go('#settings'); });
    $('#menu-users').addEventListener('click', function () { go('#users'); });
    $('#menu-updates').addEventListener('click', function () { go('#updates'); });
    $('#menu-logout').addEventListener('click', function () { signOut(); });
    document.addEventListener('click', function () { if (!$('#account-menu').hidden) toggleAccountMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#account-menu').hidden) { toggleAccountMenu(false); $('#account-btn').focus(); }
    });

    // Keep "All versions" open across re-renders of the Updates page
    $('#content').addEventListener('toggle', function (e) {
      var d = e.target;
      if (d && d.dataset && d.dataset.all) { state.updates.openAll = state.updates.openAll || {}; state.updates.openAll[d.dataset.all] = d.open; }
    }, true);
    $('#content').addEventListener('click', function (e) {
      var el;
      if (e.target.closest('[data-action="edit-profile"]')) return openProfile();
      if ((el = e.target.closest('[data-action="check"]'))) return checkUpdates(el.dataset.channel);
      if ((el = e.target.closest('[data-action="install"]'))) return installUpdate(el.dataset.channel, el.dataset.tag, el.dataset.relation);
      if (e.target.closest('[data-action="reload"]')) return location.reload();
      if (e.target.closest('[data-action="add-user"]')) return openUserDialog(null);
      if ((el = e.target.closest('[data-action="edit-user"]'))) return openUserDialog(findUser(el.dataset.username));
      if ((el = e.target.closest('[data-action="delete-user"]'))) return deleteUser(el.dataset.username);
    });
    $('#content').addEventListener('input', function (e) {
      if (e.target.id === 'users-search') { state.users.query = e.target.value; renderUsersTable(); }
    });
    $('#content').addEventListener('change', function (e) {
      if (e.target.id === 'set-theme') { setPref('theme', e.target.value); toast(t('toast.theme')); }
      if (e.target.id === 'set-lang') { setPref('lang', e.target.value); toast(t('toast.lang')); }
      if (e.target.id === 'signup-toggle') onSignupToggle(e.target);
    });

    $('#profile-form').addEventListener('submit', onProfileSave);
    $('#profile-cancel').addEventListener('click', function () { $('#profile-dialog').close(); });
    $('#profile-photo-input').addEventListener('change', onPhotoChosen);
    $('#profile-photo-remove').addEventListener('click', function () { state.pendingAvatar = null; refreshProfilePreview(); });
    $('#profile-name').addEventListener('input', refreshProfilePreview);
    $('#profile-swatches').addEventListener('click', function (e) {
      var sw = e.target.closest('[data-color]');
      if (!sw) return;
      state.pendingColor = sw.dataset.color;
      renderSwatches();
      refreshProfilePreview();
    });

    $('#user-form').addEventListener('submit', onUserSave);
    $('#user-cancel').addEventListener('click', function () { $('#user-dialog').close(); });
    $('#user-role').addEventListener('change', syncLibraryAccess);
    $('#access-all').addEventListener('change', syncLibraryAccess);
    $('#access-some').addEventListener('change', syncLibraryAccess);

    // Top bar search: Enter opens the results page
    $('#search').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = this.value.trim();
      if (q) location.hash = '#search?q=' + encodeURIComponent(q);
    });

    window.addEventListener('hashchange', function () {
      if (!state.user) return;
      markHistoryEntry();
      renderSidebar(); renderPage(); applyTranslations();
      onRouteEnter();
    });
    // Close an open overlay sidebar when the layout changes (rotate, resize)
    ['(max-width: 768px)', OVERLAY_NAV].forEach(function (q) {
      window.matchMedia(q).addEventListener('change', function () {
        $('#app-view').classList.remove('sidebar-open');
        $('#scrim').hidden = true;
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('#app-view').classList.contains('sidebar-open')) toggleSidebar(false);
    });

    // Session expired or account disabled/deleted while the page was open
    Store.onUnauthenticated = function () {
      if (!state.user) return;
      $$('dialog[open]').forEach(function (d) { d.close(); });
      signOut(t('err.sessionExpired'));
    };
  }

  async function init() {
    renderIcons();
    bind();
    try {
      if (localStorage.getItem('thoth.sidebarCollapsed') === '1') $('#app-view').classList.add('sidebar-collapsed');
      // Accounts used to live in the browser; they're on the server now
      localStorage.removeItem('thoth.users');
      localStorage.removeItem('thoth.session');
    } catch (e) { /* storage unavailable */ }

    var session;
    try {
      session = await Store.session();
    } catch (err) {
      showLogin('login');
      showAuthError(errMsg(err));
      return;
    }
    state.signupAllowed = Boolean(session.signupAllowed);
    if (session.user) showApp(session.user);
    else showLogin(session.setupRequired ? 'setup' : 'login');
  }

  // Shared with js/library.js and js/reader.js
  window.App = {
    state: state, t: t, esc: esc, errMsg: errMsg, toast: toast, fmtDate: fmtDate,
    isAdmin: isAdmin, parseRoute: parseRoute, renderPage: renderPage, refreshLibraries: refreshLibraries,
    applyTranslations: applyTranslations, setRestartNeeded: setRestartNeeded,
    // Re-render only if the user is still on the page that asked for it
    rerenderIf: function (hash) { if (state.user && location.hash === hash) { renderPage(); applyTranslations(); } },
    restoreScroll: restoreScroll
  };

  init();
})();
