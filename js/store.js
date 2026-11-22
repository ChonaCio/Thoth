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

  // Pure-JS SHA-256. Browsers only expose crypto.subtle on HTTPS/localhost, so when the app is
  // opened over plain http://<server-ip> this gives the same result as the built-in one.
  var sha256 = (function () {
    var K = [], H0 = [];
    var primes = [], n = 2;
    while (primes.length < 64) {
      if (primes.every(function (p) { return n % p !== 0; })) primes.push(n);
      n++;
    }
    primes.forEach(function (p, i) {
      if (i < 8) H0.push(Math.floor((Math.sqrt(p) % 1) * 4294967296) >>> 0);
      K.push(Math.floor((Math.cbrt(p) % 1) * 4294967296) >>> 0);
    });
    function rotr(x, r) { return (x >>> r) | (x << (32 - r)); }
    return function (bytes) {
      var len = bytes.length, padded = ((len + 9 + 63) >> 6) << 6;
      var m = new Uint8Array(padded);
      m.set(bytes); m[len] = 0x80;
      var dv = new DataView(m.buffer);
      dv.setUint32(padded - 8, Math.floor(len / 536870912));
      dv.setUint32(padded - 4, (len * 8) >>> 0);
      var H = H0.slice(), W = new Uint32Array(64);
      for (var off = 0; off < padded; off += 64) {
        for (var t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4);
        for (t = 16; t < 64; t++) {
          var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
          var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
          W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (t = 0; t < 64; t++) {
          var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
          var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H = [H[0] + a, H[1] + b, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map(function (x) { return x >>> 0; });
      }
      return H.map(function (x) { return x.toString(16).padStart(8, '0'); }).join('');
    };
  })();

  async function hash(password, salt) {
    var bytes = new TextEncoder().encode(salt + ':' + password);
    if (window.crypto && crypto.subtle) {
      var buf = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    return sha256(bytes);
  }
  window.__thothSha256 = sha256; // exposed for tests

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
