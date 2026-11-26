// Zero-dependency web server: static files, accounts API and update API.
// `npm start` → http://<this-machine>:3000
//
// The first process started is a small supervisor (supervisor.js) that runs the real server as a child
// and starts it again when it asks to be restarted (after an update) or crashes. THOTH_NO_SUPERVISOR=1
// skips it (the server then can't restart itself).
if (!process.env.THOTH_SERVER_PROCESS && process.env.THOTH_NO_SUPERVISOR !== '1') {
  require('./supervisor')();
  return; // eslint-disable-line no-useless-return -- (CommonJS: stop here; the child runs the server)
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./auth');
const config = require('./config');
const updater = require('./updater');
const library = require('./library/api');
const libraryStore = require('./library/db');
const scanner = require('./library/scanner');
const metadata = require('./library/metadata');
const rename = require('./library/rename');
const media = require('./library/media');
const tasks = require('./library/tasks');

// Deleting a user also deletes their reading progress
auth.hooks.userDeleted.push(username => libraryStore.removeUser(username));

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 = reachable from other devices (needed in containers/headless servers).
// Set HOST=127.0.0.1 to allow only this machine.
const HOST = process.env.HOST || '0.0.0.0';
// Can this server restart itself? Yes when run by the built-in supervisor (it starts it again), or under
// systemd/Docker with THOTH_SELF_RESTART=1 (they start it again).
const SUPERVISED = Boolean(process.send && process.env.THOTH_SERVER_PROCESS);
const SELF_RESTART = SUPERVISED || process.env.THOTH_SELF_RESTART === '1';
const RESTART_CODE = 75; // tells the built-in supervisor "start me again"
const STARTED_AT = new Date().toISOString();
// What the server code on disk looked like when this process started; if it changes (an update or a
// git pull), the running server is out of date until it's restarted
const CODE_AT_START = updater.serverCodeFingerprint();
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
// The only static files ever served: the page itself and its CSS/JS. Everything else in the app folder
// (data, server code, and any comics someone keeps inside it) is only reachable through the signed-in API.
const PUBLIC_FILES = new Set(['index.html']);
const PUBLIC_DIRS = new Set(['css', 'js']);
const PUBLIC_EXT = new Set(['.html', '.css', '.js', '.svg', '.png', '.ico']);
const MAX_BODY = 1024 * 1024;

function sendJson(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(body));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0, tooLarge = false;
    req.on('data', c => {
      size += c.length;
      // Too large: keep reading but drop the data, then answer 413 (cutting the connection would leave the
      // browser with a network error instead of a message). Give up on absurd sizes.
      if (size > limit) {
        tooLarge = true; chunks = [];
        if (size > limit * 4) { reject(auth.httpError(413, 'tooLarge', 'Request too large.')); req.destroy(); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(auth.httpError(413, 'tooLarge', 'Request too large.'));
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(auth.httpError(400, 'badJson', 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Block cross-site requests (e.g. another website sending requests from a visitor's browser)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function handleApi(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden', message: 'Cross-origin request blocked.' });
  const method = req.method;
  try {
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      // JSON-only writes: browsers can't send this cross-site without a CORS preflight, which we never allow
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'unsupported', message: 'Expected JSON.' });
      }
      // A cover upload (image as base64 in JSON) may be bigger than other requests
      // Bigger bodies: an uploaded cover image, a long list of files to rename
      body = await readBody(req, /^\/api\/series\/[\w-]+\/cover$/.test(url.pathname) ? 12 * 1024 * 1024 : (url.pathname === '/api/rename/apply' || url.pathname === '/api/files/delete') ? 16 * 1024 * 1024 : /^\/api\/backup\/(check|import)$/.test(url.pathname) ? 64 * 1024 * 1024 : MAX_BODY);
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }

    const authResult = await auth.handle({ method, pathname: url.pathname, body, req });
    if (authResult) {
      return sendJson(res, authResult.status, authResult.body, authResult.cookie ? { 'Set-Cookie': authResult.cookie } : null);
    }

    // ---- updates: administrators only ----
    if (method === 'GET' && url.pathname === '/api/version') {
      auth.requireAdmin(req);
      return sendJson(res, 200, await updater.resolveVersion({ force: url.searchParams.get('refresh') === '1' }));
    }
    if (method === 'GET' && url.pathname === '/api/updates/check') {
      auth.requireAdmin(req);
      return sendJson(res, 200, await updater.check(url.searchParams.get('channel')));
    }
    if (method === 'POST' && url.pathname === '/api/updates/install') {
      const { user } = auth.requireAdmin(req);
      const result = await updater.install(body.channel, String(body.tag || ''), { full: body.full === true });
      // New server code: restart by itself after replying (the supervisor starts the new code); the page
      // waits for the server to come back and reloads
      result.autoRestart = result.restartRequired && SELF_RESTART;
      sendJson(res, 200, result);
      console.log(`[update] ${result.installed} installed by ${user.username}`);
      if (result.autoRestart) {
        console.log('[update] restarting to load the new server code');
        setTimeout(restartServer, 500);
      }
      return;
    }

    // ---- tasks (Processes → Tasks) and their log files (Logs page): administrators ----
    if (url.pathname === '/api/tasks' && method === 'GET') { auth.requireAdmin(req); return sendJson(res, 200, tasks.list()); }
    let tm;
    if ((tm = /^\/api\/tasks\/([\w-]+)$/.exec(url.pathname)) && method === 'GET') {
      auth.requireAdmin(req);
      const t = tasks.get(tm[1], { lines: Math.min(2000, Math.max(10, Number(url.searchParams.get('lines')) || 200)) });
      return t ? sendJson(res, 200, { task: t }) : sendJson(res, 404, { error: 'notFound' });
    }
    if ((tm = /^\/api\/tasks\/([\w-]+)\/stop$/.exec(url.pathname)) && method === 'POST') {
      const { user } = auth.requireAdmin(req);
      if (!tasks.stop(tm[1])) return sendJson(res, 409, { error: 'cannotStop', message: 'That task can’t be stopped (or has ended).' });
      console.log(`[tasks] ${tm[1]} stopped by ${user.username}`);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/logs' && method === 'GET') {
      auth.requireAdmin(req);
      return sendJson(res, 200, tasks.listLogs({ kind: url.searchParams.get('kind') || null, q: url.searchParams.get('q') || '' }));
    }
    if ((tm = /^\/api\/logs\/([\w.-]+)$/.exec(url.pathname)) && (method === 'GET' || method === 'DELETE')) {
      auth.requireAdmin(req);
      const file = tasks.logFile(tm[1]);
      if (!file) return sendJson(res, 404, { error: 'notFound' });
      if (method === 'DELETE') { tasks.deleteLog(tm[1]); return sendJson(res, 200, { ok: true }); }
      // ?download=1: as a file to save; else the last lines (?lines=) as JSON for the viewer
      if (url.searchParams.get('download') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${tm[1]}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(file).pipe(res);
      }
      const lines = Math.min(20000, Math.max(10, Number(url.searchParams.get('lines')) || 2000));
      return sendJson(res, 200, { name: tm[1], size: fs.statSync(file).size, lines: tasks.tail(file, lines) });
    }

    // ---- processes: the web server and the library scan service (administrators) ----
    if (url.pathname === '/api/processes' && method === 'GET') {
      auth.requireAdmin(req);
      const m = process.memoryUsage();
      return sendJson(res, 200, {
        server: {
          pid: process.pid, startedAt: STARTED_AT, rss: m.rss, heapUsed: m.heapUsed,
          cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
          node: process.version, platform: `${os.type()} ${os.release()} (${process.arch})`,
          supervised: SELF_RESTART, supervisorPid: SUPERVISED ? Number(process.env.THOTH_SUPERVISOR_PID) : null,
          restarts: Number(process.env.THOTH_RESTARTS) || 0,
          restartNeeded: updater.serverCodeFingerprint() !== CODE_AT_START
        },
        scanService: scanner.serviceInfo(),
        metadata: metadata.info(),
        rename: rename.info(),
        catalog: require('./library/catalog').info(),
        downloads: require('./library/downloads').info(),
        caches: require('./library/cache/client').allInfo(), // Pages, Covers, Works, Search: a process each
        tasks: { running: tasks.list().running.length }
      });
    }
    // ---- server settings (administrators) ----
    if (url.pathname === '/api/config' && (method === 'GET' || method === 'PATCH')) {
      const { user } = auth.requireAdmin(req);
      if (method === 'PATCH') {
        const changed = config.update(body);
        // (API keys are never written to the log)
        if (changed.length) console.log(`[config] ${changed.map(k => (/ApiKey$/.test(k) ? `${k} ${config.get()[k] ? 'set' : 'removed'}` : `${k}=${config.get()[k]}`)).join(', ')} (by ${user.username})`);
      }
      return sendJson(res, 200, config.describe());
    }
    let pm;
    if ((pm = /^\/api\/processes\/scan-service\/(start|stop|restart)$/.exec(url.pathname)) && method === 'POST') {
      const { user } = auth.requireAdmin(req);
      ({ start: scanner.startService, stop: scanner.stopService, restart: scanner.restartService })[pm[1]]();
      console.log(`[processes] scan service ${pm[1]} by ${user.username}`);
      return sendJson(res, 200, { scanService: scanner.serviceInfo() });
    }
    if (url.pathname === '/api/processes/server/restart' && method === 'POST') {
      const { user } = auth.requireAdmin(req);
      if (!SELF_RESTART) return sendJson(res, 409, { error: 'notSupervised', message: 'The server was started with THOTH_NO_SUPERVISOR=1 and cannot restart itself.' });
      console.log(`[processes] server restart by ${user.username}`);
      sendJson(res, 202, { restarting: true });
      setTimeout(restartServer, 300);
      return;
    }

    // ---- libraries, series, books, reading (signed-in users) ----
    const { user } = auth.requireUser(req);
    const handled = await library.handle({
      method, pathname: url.pathname, query: url.searchParams, body, req, res, user,
      send: (status, data) => { sendJson(res, status, data); return true; }
    });
    if (handled) return;
    // An API route this server doesn't have: usually the page is newer than the running server
    // (updated files, server not restarted yet). Distinct from "that item doesn't exist".
    return sendJson(res, 404, { error: 'unknownEndpoint', message: `This server has no ${method} ${url.pathname}.` });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[api]', e.message);
    if (res.headersSent) return res.destroy();
    return sendJson(res, e.status || 500, { error: e.code || 'internal', message: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  const parts = path.relative(ROOT, file).split(path.sep);
  const allowed = file.startsWith(ROOT + path.sep) && PUBLIC_EXT.has(path.extname(file).toLowerCase()) &&
    (parts.length === 1 ? PUBLIC_FILES.has(parts[0]) : PUBLIC_DIRS.has(parts[0]));
  if (!allowed) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // no-cache so a reload after installing an update always gets the new files
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function networkUrls() {
  if (HOST !== '0.0.0.0' && HOST !== '::') return [`http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`];
  const urls = [`http://localhost:${PORT}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.internal) continue;
      if (ni.family === 'IPv4' || ni.family === 4) urls.push(`http://${ni.address}:${PORT}`);
    }
  }
  return urls;
}

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to another value.` : err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Thoth is running (listening on ${HOST}:${PORT}). Open it at:`);
  for (const u of networkUrls()) console.log(`  ${u}`);
  console.log(`Data folder: ${auth.DATA_DIR}`);
  console.log(`Updates come from github.com/${updater.REPO}`);
  if (auth.setupRequired()) {
    console.log('No users yet: open the app and create the first user (it becomes the administrator).');
  }
  updater.resolveVersion().then(v => console.log(`Version: ${describeVersion(v)}`), () => {});
  // Pick up changes made while the server was off, then rescan on the configured interval
  const libs = Object.keys(libraryStore.db.libraries).length;
  console.log(`Libraries: ${libs}${libs ? ' (scanning for changes)' : ' (add one on the Libraries page)'}`);
  scanner.init();      // start the scan service (unless an admin stopped it)
  scanner.scanAll();
media.scheduleWarm(15000); // work covers into the cover cache (also after every scan)
require('./library/catalog').startSchedule(); // external catalog: scheduled crawls
require('./library/downloads').start(); // download jobs: runs still going, scheduled runs
require('./library/cache/client').warmAll(); // caches saved to disk: back before the first request
tasks.startCleanup(); // task log files older than Server settings → logRetentionDays

  scanner.startSchedule();
});

function describeVersion(v) {
  if (!v.commit) return 'unknown (no git checkout or build info)';
  const name = (tag, ahead) => (ahead ? `${tag} +${ahead} commit${ahead === 1 ? '' : 's'}` : tag);
  const parts = [];
  if (v.release) parts.push(`release ${name(v.release, v.releaseAhead)}`);
  if (v.push != null) parts.push(`push ${name('p' + v.push, v.pushAhead)}`);
  if (v.published === false) parts.push('includes commits not on GitHub');
  if (!parts.length) parts.push(v.error ? `couldn't reach GitHub (${v.error})` : 'no tags yet');
  return `${parts.join(', ')} (commit ${v.commit.slice(0, 7)}, from ${v.origin})`;
}

// Graceful stop for `systemctl stop`, `docker stop` and Ctrl+C (data is saved by the 'exit' handlers)
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // (the caches' memory saved to disk first, at most 4 s: they come back at once on the next start)
  require('./library/cache/client').saveAll(4000).catch(() => {}).then(() => {
    server.close(() => process.exit(code));
    if (server.closeIdleConnections) server.closeIdleConnections();
  });
  setTimeout(() => process.exit(code), 6000).unref();
}
// Restart: the built-in supervisor (exit code 75) or systemd/Docker (exit 0, they restart it) starts the new code
function restartServer() {
  shutdown(SUPERVISED ? RESTART_CODE : 0);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
if (SUPERVISED) {
  process.on('message', m => { if (m && m.type === 'shutdown') shutdown(0); });
  process.on('disconnect', () => shutdown(0)); // the supervisor went away
}
