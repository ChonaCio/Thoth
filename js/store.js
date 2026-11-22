/*
 * Client-side data store (users, session, preferences) backed by localStorage.
 * NOTE: This is a front-end demo. Real authentication must happen on a server;
 * swap the functions in `Store.auth` for API calls when you add a backend.
 */
(function () {
  var memory = {};
  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return key in memory ? memory[key] : fallback;
    }
  }
  function write(key, value) {
    memory[key] = value;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }
  function remove(key) {
    delete memory[key];
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  var KEYS = { users: 'thoth.users', session: 'thoth.session', prefs: 'thoth.prefs' };
  var AVATAR_COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#007b83', '#c5221f', '#5f6368'];

  async function hash(password, salt) {
    var text = salt + ':' + password;
    if (window.crypto && crypto.subtle) {
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    // Fallback (non-secure context): simple non-cryptographic hash
    var h = 0;
    for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
    return 'x' + (h >>> 0).toString(16);
  }

  function randomSalt() {
    var arr = new Uint8Array(8);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(arr) : arr.forEach(function (_, i) { arr[i] = Math.random() * 256; });
    return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function users() { return read(KEYS.users, {}); }
  function saveUsers(u) { write(KEYS.users, u); }

  async function createUser(data) {
    var all = users();
    var key = data.username.toLowerCase();
    if (all[key]) throw new Error('login.userExists');
    var salt = randomSalt();
    all[key] = {
      username: data.username,
      displayName: data.displayName || data.username,
      email: data.email || '',
      bio: data.bio || '',
      avatar: null,
      color: AVATAR_COLORS[Object.keys(all).length % AVATAR_COLORS.length],
      salt: salt,
      passwordHash: await hash(data.password, salt),
      theme: data.theme || 'system',
      lang: data.lang || 'en',
      createdAt: new Date().toISOString()
    };
    saveUsers(all);
    return all[key];
  }

  async function seed() {
    if (!users().demo) {
      await createUser({ username: 'demo', password: 'demo123', displayName: 'Demo User', email: 'demo@thoth.app', bio: 'Just exploring Thoth.' });
    }
  }

  window.Store = {
    AVATAR_COLORS: AVATAR_COLORS,
    seed: seed,

    auth: {
      login: async function (username, password) {
        var u = users()[String(username).toLowerCase()];
        if (!u) throw new Error('login.invalid');
        if ((await hash(password, u.salt)) !== u.passwordHash) throw new Error('login.invalid');
        write(KEYS.session, { username: u.username.toLowerCase(), at: Date.now() });
        return u;
      },
      register: async function (data) {
        var u = await createUser(data);
        write(KEYS.session, { username: u.username.toLowerCase(), at: Date.now() });
        return u;
      },
      logout: function () { remove(KEYS.session); },
      currentUser: function () {
        var s = read(KEYS.session, null);
        return s ? users()[s.username] || null : null;
      }
    },

    updateUser: function (username, patch) {
      var all = users();
      var key = username.toLowerCase();
      if (!all[key]) return null;
      Object.keys(patch).forEach(function (k) {
        if (['passwordHash', 'salt', 'username', 'createdAt'].indexOf(k) === -1) all[key][k] = patch[k];
      });
      saveUsers(all);
      return all[key];
    },

    // Preferences used before anyone is signed in (login screen)
    prefs: function () { return read(KEYS.prefs, { theme: 'system', lang: null }); },
    savePrefs: function (p) { write(KEYS.prefs, Object.assign(this.prefs(), p)); }
  };
})();
