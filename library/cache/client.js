// The server's side of a cache process (host.js): started on the first request, closed after idleMs without
// requests, started again if it stopped. With THOTH_SCAN_IN_PROCESS=1 (or if a process can't be started) the
// cache runs inside the server instead. info() is synchronous: the process reports its statistics every 2 s.
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const services = new Map();
process.on('exit', () => { for (const s of services.values()) if (s.child) try { s.child.kill(); } catch { /* gone */ } });

const toBuffer = v => (v && !Buffer.isBuffer(v) && v.buffer && typeof v.byteLength === 'number' ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
// Buffers arrive as Uint8Array after IPC: make them Buffers again (one level deep is enough for these results)
function revive(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.buf) r.buf = toBuffer(r.buf);
  return r;
}

function cacheService(kind, { idleMs = 10 * 60 * 1000, label } = {}) {
  if (services.has(kind)) return services.get(kind);
  const s = {
    kind, label: label || kind, mode: process.env.THOTH_SCAN_IN_PROCESS === '1' ? 'inline' : 'process',
    child: null, pid: null, startedAt: null, pending: new Map(), seq: 0, idleTimer: null, last: null, restarts: 0, lastError: null, requests: 0, inline: null
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
    } catch (e) {
      console.warn(`[cache] couldn't start the ${kind} cache process (${e.message}); it runs inside the server`);
      s.mode = 'inline'; s.lastError = e.message;
    }
  }
  function idle() {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.pending.size || !s.child) return;
      const c = s.child; s.child = null; s.pid = null; s.last = null;
      c.removeAllListeners('exit'); try { c.kill(); } catch { /* gone */ }
    }, idleMs);
    s.idleTimer.unref();
  }
  s.call = (op, args) => {
    s.requests++;
    clearTimeout(s.idleTimer);
    if (s.mode === 'process' && !s.child) start();
    if (s.mode === 'inline') {
      s.inline = s.inline || require(`./${kind}`);
      return Promise.resolve().then(() => s.inline.handlers[op](args || {}));
    }
    return new Promise((resolve, reject) => {
      const reqId = ++s.seq;
      s.pending.set(reqId, { resolve, reject });
      s.child.send({ reqId, op, args });
    });
  };
  s.info = () => ({
    kind, mode: s.mode, pid: s.pid, startedAt: s.child ? s.startedAt : null, busy: s.pending.size, requests: s.requests, restarts: s.restarts,
    lastError: s.lastError, idleCloseMs: idleMs, stats: s.mode === 'inline' && s.inline && s.inline.info ? s.inline.info() : s.last
  });
  s.stop = () => { if (s.child) { const c = s.child; s.child = null; s.pid = null; c.removeAllListeners('exit'); try { c.kill(); } catch {} } };
  services.set(kind, s);
  return s;
}
function allInfo() { return [...services.values()].map(s => s.info()); }

module.exports = { cacheService, allInfo };
