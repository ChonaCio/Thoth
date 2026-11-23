// node test-supervisor.js <app dir> — the built-in supervisor restarts the server; nothing is left behind
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-sup-'));
const PORT = 3979, BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const call = async (m, u, b, c) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : null };
};
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* down */ } await wait(100); } throw new Error('timeout'); }

(async () => {
  // started exactly like `npm start` (no THOTH_SELF_RESTART, no systemd/Docker)
  const env = Object.assign({}, process.env, { PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA });
  delete env.THOTH_SELF_RESTART;
  const sup = spawn(process.execPath, ['server.js'], { cwd: APP, env });
  let out = ''; sup.stdout.on('data', d => out += d); sup.stderr.on('data', d => out += d);
  await until(() => out.includes('Libraries:'));
  const c = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  let p = (await call('GET', '/api/processes', null, c)).data.server;
  ok(p.supervised && p.supervisorPid === sup.pid && p.pid !== sup.pid, `plain "node server.js": supervisor ${sup.pid} runs the server as ${p.pid}`);
  const firstPid = p.pid;
  const workers = (await call('GET', '/api/processes', null, c)).data.scanService.workers.map(w => w.pid);

  ok((await call('POST', '/api/processes/server/restart', {}, c)).status === 202, 'restart accepted without systemd/Docker');
  p = await until(async () => { const x = (await call('GET', '/api/processes', null, c)).data.server; return x.pid !== firstPid && x; });
  ok(p.pid !== firstPid && p.supervisorPid === sup.pid && p.restarts === 1, `server restarted by itself (new pid ${p.pid}), same supervisor, restarts = 1`);
  ok((await call('GET', '/api/session', null, c)).data.user.username === 'admin', 'still signed in after the restart');
  ok(!alive(firstPid) && workers.every(w => !alive(w)), 'old server and its scan processes are gone');
  ok(out.includes('[supervisor] restarting the server'), 'the log says why');

  // a crash is restarted too
  const crashed = p.pid;
  process.kill(crashed);
  p = await until(async () => { const x = (await call('GET', '/api/processes', null, c)).data.server; return x.pid !== crashed && x; });
  ok(p.pid !== crashed, `a crashed server is started again (pid ${p.pid})`);

  // killing the supervisor (as a test harness or the OS would) leaves nothing behind
  const last = p.pid;
  const lastWorkers = (await call('GET', '/api/processes', null, c)).data.scanService.workers.map(w => w.pid);
  sup.kill();
  await until(async () => !alive(last) && lastWorkers.every(w => !alive(w)), 15000);
  ok(!alive(last) && lastWorkers.every(w => !alive(w)), 'supervisor gone → server and scan processes stop too');
  console.log(`\nALL ${passed} SUPERVISOR CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
