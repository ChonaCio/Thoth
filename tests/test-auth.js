// node test-auth.js <app dir>  — starts the server with a temp data dir and exercises the accounts API
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-data-'));
const PORT = 3997, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0;

function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    let out = '';
    srv.stdout.on('data', d => { out += d; if (out.includes('Thoth is running')) resolve(out); });
    srv.stderr.on('data', d => { out += d; });
    srv.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
}
function stop() { return new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); }); }

async function call(method, url, body, cookie, extra = {}) {
  const headers = Object.assign({}, extra);
  if (method !== 'GET') headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body || {})) });
  const setCookie = res.headers.get('set-cookie');
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}
function ok(cond, name) { assert(cond, name); passed++; console.log('  ✓', name); }

(async () => {
  await start();
  let r = await call('GET', '/api/session');
  ok(r.data.setupRequired === true && r.data.user === null, 'fresh install requires setup, no default user');
  r = await call('POST', '/api/login', { username: 'demo', password: 'demo123' });
  ok(r.status === 401, 'old demo/demo123 account does not exist');
  r = await call('POST', '/api/signup', { username: 'x', password: 'x' });
  ok(r.status === 409 && r.data.error === 'setupRequired', 'sign-up blocked before setup');
  r = await call('POST', '/api/setup', { username: 'ad', password: 'short' });
  ok(r.status === 400, 'setup validates input');
  r = await call('POST', '/api/setup', { username: 'Alice', password: 'alicepass1', displayName: 'Alice Admin', email: 'alice@example.com' });
  ok(r.status === 201 && r.data.user.role === 'admin' && r.cookie, 'first user created as admin and signed in');
  ok(!('passwordHash' in r.data.user), 'password hash never sent to the browser');
  const alice = r.cookie;
  r = await call('POST', '/api/setup', { username: 'mallory', password: 'mallorypass' });
  ok(r.status === 409 && r.data.error === 'setupDone', 'setup cannot run a second time');
  r = await call('GET', '/api/session', null, alice);
  ok(r.data.user.username === 'Alice' && r.data.setupRequired === false, 'session cookie works');

  r = await call('POST', '/api/users', { username: 'bob', password: 'bobpass12', displayName: 'Bob', role: 'user' }, alice);
  ok(r.status === 201 && r.data.user.role === 'user', 'admin creates a user');
  r = await call('POST', '/api/users', { username: 'BOB', password: 'bobpass12' }, alice);
  ok(r.status === 409 && r.data.error === 'usernameTaken', 'usernames are unique, case-insensitive');
  r = await call('POST', '/api/users', { username: 'b o b', password: 'bobpass12' }, alice);
  ok(r.status === 400 && r.data.error === 'usernameInvalid', 'invalid usernames rejected');

  r = await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' });
  const bob = r.cookie;
  ok(r.status === 200 && bob, 'user can sign in');
  ok((await call('GET', '/api/users', null, bob)).status === 403, 'regular user cannot list users');
  ok((await call('GET', '/api/version', null, bob)).status === 403, 'regular user cannot see updates');
  ok((await call('POST', '/api/updates/install', { channel: 'push', tag: 'p1' }, bob)).status === 403, 'regular user cannot install updates');
  ok((await call('GET', '/api/version', null, alice)).status === 200, 'admin can see updates');
  r = await call('PATCH', '/api/me', { displayName: 'Bobby', theme: 'dark', lang: 'es' }, bob);
  ok(r.status === 200 && r.data.user.displayName === 'Bobby' && r.data.user.lang === 'es', 'user edits own profile and prefs');
  r = await call('PATCH', '/api/me', { role: 'admin' }, bob);
  ok(r.status === 200 && r.data.user.role === 'user', 'user cannot make themselves admin via profile');
  r = await call('PATCH', '/api/me', { avatar: 'javascript:alert(1)' }, bob);
  ok(r.status === 400 && r.data.error === 'avatarInvalid', 'avatar must be an image data URL');

  r = await call('PATCH', '/api/users/bob', { disabled: true }, alice);
  ok(r.status === 200 && r.data.user.disabled, 'admin disables a user');
  ok((await call('GET', '/api/session', null, bob)).data.user === null, 'disabled user is signed out immediately');
  r = await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' });
  ok(r.status === 403 && r.data.error === 'accountDisabled', 'disabled user cannot sign in');

  ok((await call('DELETE', '/api/users/alice', null, alice)).data.error === 'cannotChangeSelf', 'cannot delete yourself');
  ok((await call('PATCH', '/api/users/alice', { role: 'user' }, alice)).data.error === 'cannotChangeSelf', 'cannot demote yourself');
  ok((await call('PATCH', '/api/users/alice', { disabled: true }, alice)).data.error === 'cannotChangeSelf', 'cannot disable yourself');

  r = await call('PATCH', '/api/users/bob', { disabled: false, role: 'admin', password: 'newbobpass' }, alice);
  ok(r.status === 200 && r.data.user.role === 'admin', 'admin promotes user and resets password');
  const bob2 = (await call('POST', '/api/login', { username: 'bob', password: 'newbobpass' })).cookie;
  ok(bob2, 'reset password works');
  r = await call('DELETE', '/api/users/alice', null, bob2);
  ok(r.status === 200, 'another admin can delete an admin');
  ok((await call('GET', '/api/session', null, alice)).data.user === null, 'deleted user is signed out');
  r = await call('PATCH', '/api/users/bob', { role: 'user' }, bob2);
  ok(r.data.error === 'cannotChangeSelf', 'last admin is protected');

  ok((await call('POST', '/api/signup', { username: 'carol', password: 'carolpass' })).data.error === 'signupDisabled', 'sign-up off by default');
  ok((await call('PATCH', '/api/settings', { signupAllowed: true }, bob2)).data.signupAllowed === true, 'admin turns on sign-up');
  r = await call('POST', '/api/signup', { username: 'carol', password: 'carolpass' });
  ok(r.status === 201 && r.data.user.role === 'user', 'self sign-up creates a regular user');
  const carol = r.cookie;

  r = await call('POST', '/api/me/password', { current: 'wrong', password: 'carolpass2' }, carol);
  ok(r.data.error === 'wrongPassword', 'password change needs current password');
  const carolOther = (await call('POST', '/api/login', { username: 'carol', password: 'carolpass' })).cookie;
  r = await call('POST', '/api/me/password', { current: 'carolpass', password: 'carolpass2' }, carol);
  ok(r.status === 200, 'password changed');
  ok((await call('GET', '/api/session', null, carol)).data.user, 'current session kept');
  ok((await call('GET', '/api/session', null, carolOther)).data.user === null, 'other sessions signed out');
  ok((await call('POST', '/api/login', { username: 'carol', password: 'carolpass' })).status === 401, 'old password no longer works');

  ok((await call('POST', '/api/logout', {}, carol)).status === 200 && (await call('GET', '/api/session', null, carol)).data.user === null, 'logout ends session');

  ok((await call('POST', '/api/login', { username: 'bob', password: 'newbobpass' }, null, { Origin: 'http://evil.example' })).status === 403, 'cross-origin requests blocked');
  ok((await call('POST', '/api/login', 'username=bob', null, { 'Content-Type': 'application/x-www-form-urlencoded' })).status === 415, 'form posts (CSRF) rejected');
  ok((await fetch(BASE + '/data/users.json')).status === 403, 'data folder not served');

  // Persistence across restart
  await stop(); await start();
  ok((await call('GET', '/api/session', null, bob2)).data.user.username === 'bob', 'sessions and users survive a restart');

  // Throttling (last, it blocks this IP)
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { username: 'bob', password: 'nope' });
  r = await call('POST', '/api/login', { username: 'bob', password: 'newbobpass' });
  ok(r.status === 429 && r.data.error === 'tooManyAttempts', 'sign-in throttled after 10 failures');

  // Damaged users file must not reopen first-user setup
  await stop();
  fs.writeFileSync(path.join(DATA, 'users.json'), '{ broken');
  let failed = false;
  try { await start(); } catch { failed = true; }
  ok(failed, 'corrupt users.json stops the server instead of re-opening setup');

  const stored = fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8');
  ok(!stored.includes(bob2.split('=')[1]), 'session tokens are stored hashed');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch(async e => { console.error('\nFAILED:', e.message); try { srv.kill(); } catch {} process.exit(1); });
