/*
 * API client for the Thoth server (accounts, profile, user management, updates).
 * Sign-in uses an HttpOnly session cookie set by the server.
 * Only the theme/language shown on the sign-in screen are kept in this browser.
 */
(function () {
  var PREFS_KEY = 'thoth.prefs';

  async function request(method, url, body) {
    var res;
    try {
      res = await fetch(url, {
        method: method,
        credentials: 'same-origin',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body || {})
      });
    } catch (e) {
      throw { code: 'offline', status: 0 };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data) {
      var err = { code: (data && data.error) || (res.status === 404 ? 'offline' : 'internal'), message: data && data.message, status: res.status };
      if (res.status === 401 && typeof Store.onUnauthenticated === 'function' && url !== '/api/login') Store.onUnauthenticated();
      throw err;
    }
    return data;
  }

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }

  window.Store = {
    AVATAR_COLORS: ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#007b83', '#c5221f', '#5f6368'],
    request: request,
    onUnauthenticated: null,

    session: function () { return request('GET', '/api/session'); },
    setup: function (data) { return request('POST', '/api/setup', data); },
    login: function (username, password) { return request('POST', '/api/login', { username: username, password: password }); },
    signup: function (data) { return request('POST', '/api/signup', data); },
    logout: function () { return request('POST', '/api/logout'); },

    updateMe: function (patch) { return request('PATCH', '/api/me', patch); },
    changePassword: function (current, password) { return request('POST', '/api/me/password', { current: current, password: password }); },

    users: {
      list: function () { return request('GET', '/api/users'); },
      create: function (data) { return request('POST', '/api/users', data); },
      update: function (username, patch) { return request('PATCH', '/api/users/' + encodeURIComponent(username), patch); },
      remove: function (username) { return request('DELETE', '/api/users/' + encodeURIComponent(username)); }
    },
    settings: {
      get: function () { return request('GET', '/api/settings'); },
      update: function (patch) { return request('PATCH', '/api/settings', patch); }
    },

    // Libraries, series, books, reading
    libraries: function () { return request('GET', '/api/libraries'); },
    qs: function (params) {
      return Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] != null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    },
    setProgress: function (bookId, page, completed) {
      var body = { page: page };
      if (completed != null) body.completed = completed;
      return request('PUT', '/api/books/' + bookId + '/progress', body);
    },

    // Theme/language for the sign-in screen (before anyone is signed in)
    prefs: function () { return Object.assign({ theme: 'system', lang: null }, readPrefs()); },
    savePrefs: function (p) {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.assign(readPrefs(), p))); } catch (e) { /* storage unavailable */ }
    }
  };
})();
