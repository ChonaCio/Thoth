// Server-side accounts: users, sessions, first-run setup and user management. No dependencies.
// Data lives in THOTH_DATA_DIR (default ./data) as JSON files; updates never touch that folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, 'data'));
const COOKIE = 'thoth_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_AVATAR = 400 * 1024;
const COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#007b83', '#c5221f', '#5f6368'];
const THEMES = ['system', 'light', 'dark'];
const LANGS = ['en', 'es', 'fr', 'de', 'pt'];
const ROLES = ['admin', 'user'];

/* ---------------- storage ---------------- */
function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // Never treat a damaged users file as "no users": that would re-open first-user setup.
    throw new Error(`Can't read ${path.join(DATA_DIR, file)}: ${e.message}`);
  }
}
function save(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

const db = {
  users: load('users.json', {}),
  sessions: load('sessions.json', {}),
  settings: Object.assign({ signupAllowed: false }, load('settings.json', {}))
};
const saveUsers = () => save('users.json', db.users);
const saveSessions = () => save('sessions.json', db.sessions);
const saveSettings = () => save('settings.json', db.settings);

// Drop expired sessions at startup
(function prune() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of Object.entries(db.sessions)) {
    if (s.expires < now || !db.users[s.username]) { delete db.sessions[k]; changed = true; }
  }
  if (changed) saveSessions();
})();

/* ---------------- helpers ---------------- */
function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== 64) return false;
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, expected);
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}
const userCount = () => Object.keys(db.users).length;
const activeAdmins = () => Object.values(db.users).filter(u => u.role === 'admin' && !u.disabled);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAgeMs) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${isHttps(req) ? '; Secure' : ''}`;
}

function createSession(req, username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha256(token)] = { username, created: Date.now(), expires: Date.now() + SESSION_MS };
  saveSessions();
  return sessionCookie(req, token, SESSION_MS);
}
function endSessionsFor(username, exceptHash) {
  let changed = false;
  for (const [k, s] of Object.entries(db.sessions)) {
    if (s.username === username && k !== exceptHash) { delete db.sessions[k]; changed = true; }
  }
  if (changed) saveSessions();
}

// Returns { user, sessionHash } for a valid session, else null
function sessionFor(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = db.sessions[hash];
  if (!s) return null;
  const user = db.users[s.username];
  if (!user || user.disabled || s.expires < Date.now()) {
    delete db.sessions[hash];
    saveSessions();
    return null;
  }
  return { user, sessionHash: hash };
}
function requireUser(req) {
  const s = sessionFor(req);
  if (!s) throw httpError(401, 'unauthenticated', 'Please sign in.');
  return s;
}
function requireAdmin(req) {
  const s = requireUser(req);
  if (s.user.role !== 'admin') throw httpError(403, 'forbidden', 'Administrators only.');
  return s;
}

/* ---------------- library access ----------------
 * user.libraries: null/absent = every library; array of library ids = only those.
 * Administrators always see every library.
 */
function parseLibraryAccess(v) {
  if (v === null || v === 'all') return null;
  if (!Array.isArray(v)) throw httpError(400, 'invalid', 'libraries must be null or a list of library ids.');
  return [...new Set(v.map(String).filter(id => /^[\w-]{1,40}$/.test(id)))].slice(0, 500);
}

// Other modules can react to account changes (e.g. delete a user's reading progress)
const hooks = { userDeleted: [] };

/* ---------------- validation ---------------- */
function cleanText(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function validateNewAccount(body) {
  const username = cleanText(body.username, 64);
  if (!USERNAME_RE.test(username)) throw httpError(400, 'usernameInvalid');
  if (db.users[username.toLowerCase()]) throw httpError(409, 'usernameTaken');
  const password = String(body.password || '');
  if (password.length < MIN_PASSWORD) throw httpError(400, 'passwordTooShort');
  return { username, password };
}

// Applies editable profile fields from body onto target (only fields present in body)
function applyProfile(target, body) {
  if ('displayName' in body) {
    const v = cleanText(body.displayName, 80);
    if (!v) throw httpError(400, 'displayNameRequired');
    target.displayName = v;
  }
  if ('email' in body) {
    const v = cleanText(body.email, 254);
    if (v && !EMAIL_RE.test(v)) throw httpError(400, 'emailInvalid');
    target.email = v;
  }
  if ('bio' in body) target.bio = cleanText(body.bio, 500);
  if ('avatar' in body) {
    const v = body.avatar;
    if (v !== null && !(typeof v === 'string' && v.length <= MAX_AVATAR && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v))) {
      throw httpError(400, 'avatarInvalid');
    }
    target.avatar = v;
  }
  if ('color' in body) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(body.color))) throw httpError(400, 'invalid', 'Invalid color.');
    target.color = body.color;
  }
  if ('theme' in body) {
    if (!THEMES.includes(body.theme)) throw httpError(400, 'invalid', 'Invalid theme.');
    target.theme = body.theme;
  }
  if ('lang' in body) {
    if (!LANGS.includes(body.lang)) throw httpError(400, 'invalid', 'Invalid language.');
    target.lang = body.lang;
  }
}

async function createUser(body, role) {
  const { username, password } = validateNewAccount(body);
  const user = {
    username,
    displayName: username,
    email: '',
    bio: '',
    avatar: null,
    color: COLORS[userCount() % COLORS.length],
    role,
    disabled: false,
    theme: THEMES.includes(body.theme) ? body.theme : 'system',
    lang: LANGS.includes(body.lang) ? body.lang : 'en',
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  applyProfile(user, { displayName: body.displayName || username, email: body.email || '' });
  user.passwordHash = await hashPassword(password);
  db.users[username.toLowerCase()] = user;
  saveUsers();
  return user;
}

/* ---------------- login throttling ---------------- */
const failures = new Map(); // ip -> { count, first }
const WINDOW_MS = 15 * 60 * 1000;
function checkThrottle(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first < WINDOW_MS && f.count >= 10) throw httpError(429, 'tooManyAttempts');
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first >= WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

/* ---------------- routes ---------------- */
// Returns { status, body, cookie? } or null when the route isn't an auth route.
async function handle({ method, pathname, body, req }) {
  const ip = req.socket.remoteAddress;

  if (method === 'GET' && pathname === '/api/session') {
    const s = sessionFor(req);
    return { status: 200, body: { setupRequired: userCount() === 0, signupAllowed: db.settings.signupAllowed, user: s ? publicUser(s.user) : null } };
  }

  if (method === 'POST' && pathname === '/api/setup') {
    if (userCount() > 0) throw httpError(409, 'setupDone');
    const user = await createUser(body, 'admin');
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    console.log(`[auth] first user "${user.username}" created as administrator from ${ip}`);
    return { status: 201, body: { user: publicUser(user) }, cookie: createSession(req, user.username.toLowerCase()) };
  }

  if (method === 'POST' && pathname === '/api/login') {
    checkThrottle(ip);
    const user = db.users[cleanText(body.username, 64).toLowerCase()];
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      recordFailure(ip);
      await new Promise(r => setTimeout(r, 400));
      throw httpError(401, 'invalidCredentials');
    }
    if (user.disabled) throw httpError(403, 'accountDisabled');
    failures.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    return { status: 200, body: { user: publicUser(user) }, cookie: createSession(req, user.username.toLowerCase()) };
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req)[COOKIE];
    if (token && db.sessions[sha256(token)]) { delete db.sessions[sha256(token)]; saveSessions(); }
    return { status: 200, body: { ok: true }, cookie: sessionCookie(req, '', 0) };
  }

  if (method === 'POST' && pathname === '/api/signup') {
    if (userCount() === 0) throw httpError(409, 'setupRequired');
    if (!db.settings.signupAllowed) throw httpError(403, 'signupDisabled');
    const user = await createUser(body, 'user');
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    return { status: 201, body: { user: publicUser(user) }, cookie: createSession(req, user.username.toLowerCase()) };
  }

  /* ---- own account ---- */
  if (method === 'PATCH' && pathname === '/api/me') {
    const { user } = requireUser(req);
    const draft = Object.assign({}, user);
    applyProfile(draft, body);
    Object.assign(user, draft);
    saveUsers();
    return { status: 200, body: { user: publicUser(user) } };
  }

  if (method === 'POST' && pathname === '/api/me/password') {
    const { user, sessionHash } = requireUser(req);
    if (!(await verifyPassword(body.current, user.passwordHash))) throw httpError(400, 'wrongPassword');
    if (String(body.password || '').length < MIN_PASSWORD) throw httpError(400, 'passwordTooShort');
    user.passwordHash = await hashPassword(String(body.password));
    saveUsers();
    endSessionsFor(user.username.toLowerCase(), sessionHash); // sign out other devices
    return { status: 200, body: { ok: true } };
  }

  /* ---- user management (admins) ---- */
  if (method === 'GET' && pathname === '/api/users') {
    requireAdmin(req);
    const users = Object.values(db.users).map(publicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { status: 200, body: { users } };
  }

  if (method === 'POST' && pathname === '/api/users') {
    const { user: admin } = requireAdmin(req);
    const role = ROLES.includes(body.role) ? body.role : 'user';
    const libraries = 'libraries' in body ? parseLibraryAccess(body.libraries) : null;
    const user = await createUser(body, role);
    if (libraries) { user.libraries = libraries; saveUsers(); }
    console.log(`[auth] ${admin.username} created user "${user.username}" (${role})`);
    return { status: 201, body: { user: publicUser(user) } };
  }

  const m = /^\/api\/users\/([^/]+)$/.exec(pathname);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const { user: admin } = requireAdmin(req);
    const key = decodeURIComponent(m[1]).toLowerCase();
    const target = db.users[key];
    if (!target) throw httpError(404, 'notFound');
    const self = key === admin.username.toLowerCase();
    const isLastAdmin = target.role === 'admin' && !target.disabled && activeAdmins().length === 1;

    if (method === 'DELETE') {
      if (self) throw httpError(400, 'cannotChangeSelf');
      if (isLastAdmin) throw httpError(400, 'lastAdmin');
      delete db.users[key];
      saveUsers();
      endSessionsFor(key);
      for (const fn of hooks.userDeleted) { try { fn(key); } catch (e) { console.error('[auth] userDeleted hook:', e.message); } }
      console.log(`[auth] ${admin.username} deleted user "${target.username}"`);
      return { status: 200, body: { ok: true } };
    }

    const draft = Object.assign({}, target);
    const profile = {};
    if ('displayName' in body) profile.displayName = body.displayName;
    if ('email' in body) profile.email = body.email;
    applyProfile(draft, profile);
    if ('libraries' in body) draft.libraries = parseLibraryAccess(body.libraries);
    if ('role' in body) {
      if (!ROLES.includes(body.role)) throw httpError(400, 'invalid', 'Invalid role.');
      if (body.role !== target.role && (self || isLastAdmin)) throw httpError(400, self ? 'cannotChangeSelf' : 'lastAdmin');
      draft.role = body.role;
    }
    if ('disabled' in body) {
      const disabled = Boolean(body.disabled);
      if (disabled && !target.disabled && (self || isLastAdmin)) throw httpError(400, self ? 'cannotChangeSelf' : 'lastAdmin');
      draft.disabled = disabled;
    }
    let passwordChanged = false;
    if (body.password) {
      if (String(body.password).length < MIN_PASSWORD) throw httpError(400, 'passwordTooShort');
      draft.passwordHash = await hashPassword(String(body.password));
      passwordChanged = true;
    }
    Object.assign(target, draft);
    saveUsers();
    if (target.disabled || passwordChanged) endSessionsFor(key, self ? sessionFor(req).sessionHash : undefined);
    return { status: 200, body: { user: publicUser(target) } };
  }

  if (pathname === '/api/settings' && (method === 'GET' || method === 'PATCH')) {
    requireAdmin(req);
    if (method === 'PATCH' && 'signupAllowed' in body) {
      db.settings.signupAllowed = Boolean(body.signupAllowed);
      saveSettings();
    }
    return { status: 200, body: db.settings };
  }

  return null;
}

module.exports = { handle, requireUser, requireAdmin, httpError, hooks, DATA_DIR, COLORS, setupRequired: () => userCount() === 0 };
