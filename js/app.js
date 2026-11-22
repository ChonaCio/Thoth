(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.from((root || document).querySelectorAll(sel)); };

  var NAV = [
    { id: 'home', icon: 'home', key: 'nav.home' },
    { id: 'dashboard', icon: 'dashboard', key: 'nav.dashboard' },
    { id: 'projects', icon: 'folder', key: 'nav.projects' },
    { id: 'messages', icon: 'mail', key: 'nav.messages' },
    { id: 'calendar', icon: 'calendar', key: 'nav.calendar' },
    { divider: true },
    { id: 'settings', icon: 'settings', key: 'nav.settings' }
  ];
  var THEMES = [
    { id: 'system', icon: 'contrast', key: 'theme.system' },
    { id: 'light', icon: 'light_mode', key: 'theme.light' },
    { id: 'dark', icon: 'dark_mode', key: 'theme.dark' }
  ];

  var state = { user: null, lang: 'en', theme: 'system', registerMode: false, pendingAvatar: undefined, pendingColor: null };

  /* ---------------- i18n ---------------- */
  function t(key, vars) {
    var dict = TRANSLATIONS[state.lang] || TRANSLATIONS.en;
    var str = dict[key] != null ? dict[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
    if (vars) Object.keys(vars).forEach(function (k) { str = str.split('{' + k + '}').join(vars[k]); });
    return str;
  }
  function applyTranslations() {
    document.documentElement.lang = state.lang;
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $$('[data-i18n-title]').forEach(function (el) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
  }
  function detectLang() {
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return LANGUAGES[nav] ? nav : 'en';
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
  }

  function setPref(kind, value) {
    state[kind] = value;
    var patch = {}; patch[kind] = value;
    if (state.user) state.user = Store.updateUser(state.user.username, patch);
    Store.savePrefs(patch);
    if (kind === 'theme') applyTheme(); else applyTranslations();
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

  /* ---------------- views ---------------- */
  function showLogin() {
    state.user = null;
    var prefs = Store.prefs();
    state.theme = prefs.theme || 'system';
    state.lang = prefs.lang || detectLang();
    applyTheme();
    document.title = 'Thoth';
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    setRegisterMode(false);
    renderLoginLang();
    applyTranslations();
    $('#auth-username').focus();
  }

  function showApp(user) {
    state.user = user;
    state.theme = user.theme || 'system';
    state.lang = user.lang || state.lang;
    applyTheme();
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#auth-form').reset();
    if (!location.hash) history.replaceState(null, '', '#home');
    applyTranslations();
    renderAll();
  }

  function renderAll() {
    if (!state.user) return;
    renderSidebar();
    renderUserInfo();
    renderMenuOptions();
    renderPage();
    applyTranslations();
  }

  /* ---------------- login ---------------- */
  function setRegisterMode(on) {
    state.registerMode = on;
    $$('.register-only').forEach(function (el) { el.hidden = !on; });
    var title = $('#auth-title'), submit = $('#auth-submit'), sw = $('#auth-switch');
    title.dataset.i18n = on ? 'login.registerTitle' : 'login.title';
    submit.dataset.i18n = on ? 'login.register' : 'login.signIn';
    sw.dataset.i18n = on ? 'login.haveAccount' : 'login.createAccount';
    $('#auth-password').autocomplete = on ? 'new-password' : 'current-password';
    $('#auth-error').hidden = true;
    applyTranslations();
  }

  function renderLoginLang() {
    var sel = $('#login-lang');
    sel.innerHTML = Object.keys(LANGUAGES).map(function (code) {
      return '<option value="' + code + '"' + (code === state.lang ? ' selected' : '') + '>' + LANGUAGES[code] + '</option>';
    }).join('');
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    var err = $('#auth-error');
    err.hidden = true;
    var username = $('#auth-username').value.trim();
    var password = $('#auth-password').value;
    try {
      if (!username || !password) throw new Error('login.required');
      var user;
      if (state.registerMode) {
        if (password.length < 6) throw new Error('login.shortPassword');
        user = await Store.auth.register({
          username: username,
          password: password,
          displayName: $('#reg-name').value.trim(),
          email: $('#reg-email').value.trim(),
          theme: state.theme,
          lang: state.lang
        });
      } else {
        user = await Store.auth.login(username, password);
      }
      showApp(user);
    } catch (ex) {
      err.textContent = t(ex.message);
      err.hidden = false;
    }
  }

  /* ---------------- sidebar ---------------- */
  function currentRoute() {
    var id = (location.hash || '#home').slice(1);
    return NAV.some(function (n) { return n.id === id; }) ? id : 'home';
  }

  function renderSidebar() {
    var route = currentRoute();
    $('#sidebar-list').innerHTML = NAV.map(function (n) {
      if (n.divider) return '<li><hr class="divider" /></li>';
      return '<li><a href="#' + n.id + '" class="nav-item' + (n.id === route ? ' is-active' : '') + '"' +
        (n.id === route ? ' aria-current="page"' : '') + '>' +
        '<span data-icon="' + n.icon + '"></span><span class="nav-item__label" data-i18n="' + n.key + '"></span></a></li>';
    }).join('');
    renderIcons($('#sidebar'));
  }

  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

  function toggleSidebar(force) {
    var app = $('#app-view');
    if (isMobile()) {
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

  function onPhotoChosen(e) {
    var file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      $('#profile-error').textContent = t('profile.imageTooLarge');
      $('#profile-error').hidden = false;
      return;
    }
    // Downscale to 256px so it fits comfortably in localStorage
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

  function onProfileSave(e) {
    e.preventDefault();
    var name = $('#profile-name').value.trim();
    if (!name) {
      $('#profile-error').textContent = t('login.required');
      $('#profile-error').hidden = false;
      return;
    }
    var patch = { displayName: name, email: $('#profile-email').value.trim(), bio: $('#profile-bio').value.trim() };
    if (state.pendingAvatar !== undefined) patch.avatar = state.pendingAvatar;
    if (state.pendingColor) patch.color = state.pendingColor;
    state.user = Store.updateUser(state.user.username, patch);
    $('#profile-dialog').close();
    renderAll();
    toast(t('profile.saved'));
  }

  /* ---------------- pages ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function renderPage() {
    var route = currentRoute();
    var nav = NAV.filter(function (n) { return n.id === route; })[0];
    var u = state.user;
    var html;
    if (route === 'home') {
      var since = new Date(u.createdAt).toLocaleDateString(state.lang, { year: 'numeric', month: 'long', day: 'numeric' });
      html =
        '<h1 class="page-title">' + esc(t('page.welcome', { name: u.displayName.split(' ')[0] })) + '</h1>' +
        '<p class="page-lead">' + esc(t('page.homeIntro')) + '</p>' +
        '<div class="cards">' +
          '<section class="card">' +
            '<h2 class="card__title">' + esc(t('page.profileCard')) + '</h2>' +
            '<div class="profile-summary">' +
              '<span class="avatar avatar--lg" id="home-avatar"></span>' +
              '<div><p class="profile-summary__name">' + esc(u.displayName) + '</p>' +
              '<p class="muted">@' + esc(u.username) + (u.email ? ' · ' + esc(u.email) : '') + '</p>' +
              '<p class="muted small">' + esc(t('page.memberSince', { date: since })) + '</p></div>' +
            '</div>' +
            (u.bio ? '<p class="profile-summary__bio">' + esc(u.bio) + '</p>' : '') +
            '<button class="btn btn--outline btn--pill" data-action="edit-profile">' + esc(t('menu.editProfile')) + '</button>' +
          '</section>' +
          '<section class="card">' +
            '<h2 class="card__title">' + esc(t('page.preferences')) + '</h2>' +
            '<dl class="pref-list">' +
              '<dt>' + esc(t('menu.appearance')) + '</dt><dd>' + esc(t('theme.' + state.theme)) + '</dd>' +
              '<dt>' + esc(t('menu.language')) + '</dt><dd>' + esc(LANGUAGES[state.lang]) + '</dd>' +
            '</dl>' +
          '</section>' +
        '</div>';
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
    } else {
      html =
        '<h1 class="page-title">' + esc(t(nav.key)) + '</h1>' +
        '<div class="empty-state"><span data-icon="' + nav.icon + '"></span><p>' + esc(t('page.placeholder')) + '</p></div>';
    }
    $('#content').innerHTML = html;
    var ha = $('#home-avatar');
    if (ha) paintAvatar(ha, u);
    renderIcons($('#content'));
    document.title = t(nav.key) + ' – Thoth';
  }

  /* ---------------- toast ---------------- */
  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  /* ---------------- wire up ---------------- */
  function bind() {
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#auth-switch').addEventListener('click', function () { setRegisterMode(!state.registerMode); });
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
    $('#sidebar').addEventListener('click', function (e) { if (e.target.closest('a') && isMobile()) toggleSidebar(false); });

    $('#account-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleAccountMenu(); });
    $('#account-menu').addEventListener('click', function (e) {
      e.stopPropagation();
      var go = e.target.closest('[data-goto]');
      if (go) return showPanel(go.dataset.goto);
      var th = e.target.closest('[data-theme-choice]');
      if (th) { setPref('theme', th.dataset.themeChoice); toast(t('toast.theme')); return; }
      var lg = e.target.closest('[data-lang-choice]');
      if (lg) { setPref('lang', lg.dataset.langChoice); toast(t('toast.lang')); return; }
    });
    $('#menu-edit-profile').addEventListener('click', openProfile);
    $('#menu-avatar-edit').addEventListener('click', openProfile);
    $('#menu-settings').addEventListener('click', function () { toggleAccountMenu(false); location.hash = '#settings'; });
    $('#menu-logout').addEventListener('click', function () {
      toggleAccountMenu(false);
      Store.auth.logout();
      history.replaceState(null, '', location.pathname);
      showLogin();
      toast(t('toast.signedOut'));
    });
    document.addEventListener('click', function () { if (!$('#account-menu').hidden) toggleAccountMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#account-menu').hidden) { toggleAccountMenu(false); $('#account-btn').focus(); }
    });

    $('#content').addEventListener('click', function (e) {
      if (e.target.closest('[data-action="edit-profile"]')) openProfile();
    });
    $('#content').addEventListener('change', function (e) {
      if (e.target.id === 'set-theme') { setPref('theme', e.target.value); toast(t('toast.theme')); }
      if (e.target.id === 'set-lang') { setPref('lang', e.target.value); toast(t('toast.lang')); }
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

    window.addEventListener('hashchange', function () { if (state.user) { renderSidebar(); renderPage(); applyTranslations(); } });
    window.matchMedia('(max-width: 768px)').addEventListener('change', function () {
      $('#app-view').classList.remove('sidebar-open');
      $('#scrim').hidden = true;
    });
  }

  async function init() {
    renderIcons();
    bind();
    try { if (localStorage.getItem('thoth.sidebarCollapsed') === '1') $('#app-view').classList.add('sidebar-collapsed'); } catch (e) { /* ignore */ }
    await Store.seed();
    var user = Store.auth.currentUser();
    if (user) showApp(user); else showLogin();
  }

  init();
})();
