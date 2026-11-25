// The server's side of a cache process (host.js): started on the first request, closed after idleMs without
// requests, started again if it stopped. With THOTH_SCAN_IN_PROCESS=1 (or if a process can't be started) the
// cache runs inside the server instead. info() is synchronous: the process reports its statistics every 2 s.
// persist: { save: () => args, restore: () => args } — a cache that keeps its memory on disk (cache/persist.js):
// restored as soon as its process starts, saved every SAVE_EVERY_MS while it was used, before it closes when
// idle, and when the server stops (saveAll). The args come from the server (the data's fingerprint, versions).
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const services = new Map();
const SAVE_EVERY_MS = Math.max(1000, Number(process.env.THOTH_CACHE_SAVE_MS) || 5 * 60 * 1000); // (tests: shorter)
process.on('exit', () => { for (const s of services.values()) if (s.child) try { s.child.kill(); } catch { /* gone */ } });

const toBuffer = v => (v && !Buffer.isBuffer(v) && v.buffer && typeof v.byteLength === 'number' ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
// Buffers arrive as Uint8Array after IPC: make them Buffers again (one level deep is enough for these results)
function revive(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.buf) r.buf = toBuffer(r.buf);
  return r;
}
const QUIET = new Set(['save', 'restore', 'configure', 'status', 'ping']); // (calls that don't make a snapshot due)

function cacheService(kind, { idleMs = 10 * 60 * 1000, label, persist = null } = {}) {
  if (services.has(kind)) return services.get(kind);
  const s = {
    kind, label: label || kind, mode: process.env.THOTH_SCAN_IN_PROCESS === '1' ? 'inline' : 'process',
    child: null, pid: null, startedAt: null, pending: new Map(), seq: 0, idleTimer: null, last: null, restarts: 0, lastError: null, requests: 0, inline: null,
    persist, dirty: false, saving: null, restoring: null
  };
  function start() {
    try {
      const child = fork(path.join(__dirname, 'host.js'), [kind], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', env: process.env });
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here */ }
      s.child = child; s.pid = child.pid; s.startedAt = new Date().toISOString();
      child.on('message', m => {
        if (!m) return;
        if (m.type === 'stats') { s.last = m.info; return; }
        const p = s.pending.get(m.reqId);
        if (!p) return;
        s.pending.delete(m.reqId);
        if (m.type === 'result') p.resolve(revive(m.result));
        else p.reject(Object.assign(new Error(m.message), { code: m.code, status: m.status || undefined }));
        if (!s.pending.size) idle();
      });
      const gone = err => {
        if (s.child !== child) return;
        s.child = null; s.pid = null; s.last = null;
        for (const p of s.pending.values()) p.reject(err);
        s.pending.clear();
      };
      child.on('error', e => { s.lastError = e.message; gone(e); });
      child.on('exit', code => { if (code) { s.lastError = `${s.label} cache process stopped unexpectedly (exit code ${code})`; s.restarts++; } gone(new Error(s.lastError || 'stopped')); });
      restore();
    } catch (e) {
      console.warn(`[cache] couldn't start the ${kind} cache process (${e.message}); it runs inside the server`);
      s.mode = 'inline'; s.lastError = e.message;
    }
  }
  // What was saved, taken back first (its request goes before any other the new process gets)
  function restore() {
    if (!s.persist || !s.persist.restore) return;
    let args; try { args = s.persist.restore(); } catch { return; }
    if (!args) return;
    s.restoring = send('restore', args).then(r => { if (r && r.restored) console.log(`[cache] ${s.label}: ${r.restored} entr${r.restored === 1 ? 'y' : 'ies'} taken back from disk`); }, () => {})
      .finally(() => { s.restoring = null; });
  }
  function send(op, args) {
    if (s.mode === 'inline') {
      if (!s.inline) { s.inline = require(`./${kind}`); if (op !== 'restore') restore(); }
      // (like the process: requests wait while what was saved is taken back)
      return Promise.resolve(op !== 'restore' && s.restoring ? s.restoring.catch(() => {}) : null).then(() => (op === 'ping' ? true : s.inline.handlers[op](args || {})));
    }
    if (!s.child) start();
    if (!s.child) return send(op, args); // (couldn't start: inline now)
    return new Promise((resolve, reject) => {
      const reqId = ++s.seq;
      s.pending.set(reqId, { resolve, reject });
      s.child.send({ reqId, op, args });
    });
  }
  function idle() {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(async () => {
      if (s.pending.size || !s.child) return;
      await s.save().catch(() => {}); // (what it keeps, on disk before it goes)
      if (s.pending.size || !s.child) return;
      const c = s.child; s.child = null; s.pid = null; s.last = null;
      c.removeAllListeners('exit'); try { c.kill(); } catch { /* gone */ }
    }, idleMs);
    s.idleTimer.unref();
  }
  s.call = (op, args) => {
    s.requests++;
    if (!QUIET.has(op)) s.dirty = true;
    clearTimeout(s.idleTimer);
    return send(op, args);
  };
  // Saves what it keeps now (only when it was used since the last save, and its process is there)
  s.save = () => {
    if (!s.persist || !s.persist.save || !s.dirty || (s.mode === 'process' && !s.child) || (s.mode === 'inline' && !s.inline)) return Promise.resolve(null);
    if (s.saving) return s.saving;
    let args; try { args = s.persist.save(); } catch (e) { return Promise.resolve(null); }
    if (!args) return Promise.resolve(null);
    s.dirty = false;
    s.saving = send('save', args).catch(e => { s.dirty = true; s.lastError = `saving to disk: ${e.message}`; return null; }).finally(() => { s.saving = null; });
    return s.saving;
  };
  // Started now (and what it saved taken back), without waiting for its first request
  s.warm = () => { if (s.persist && ((s.mode === 'process' && !s.child) || (s.mode === 'inline' && !s.inline))) { send('ping', {}).catch(() => {}); idle(); } };
  s.info = () => ({
    kind, mode: s.mode, pid: s.pid, startedAt: s.child ? s.startedAt : null, busy: s.pending.size, requests: s.requests, restarts: s.restarts,
    lastError: s.lastError, idleCloseMs: idleMs, persists: Boolean(s.persist), stats: s.mode === 'inline' && s.inline && s.inline.info ? s.inline.info() : s.last
  });
  s.stop = () => { if (s.child) { const c = s.child; s.child = null; s.pid = null; c.removeAllListeners('exit'); try { c.kill(); } catch {} } };
  services.set(kind, s);
  return s;
}
function allInfo() { return [...services.values()].map(s => s.info()); }
// Every cache that keeps its memory on disk, saved now (the server stopping): at most `ms`
function saveAll(ms = 4000) {
  const all = Promise.all([...services.values()].map(s => s.save().catch(() => null)));
  return Promise.race([all, new Promise(r => setTimeout(r, ms).unref())]);
}
setInterval(() => { for (const s of services.values()) s.save().catch(() => {}); }, SAVE_EVERY_MS).unref();
// At server start: every cache that saved itself started, so what it saved is back before the first request
function warmAll() { for (const s of services.values()) s.warm(); }

module.exports = { cacheService, allInfo, saveAll, warmAll };
