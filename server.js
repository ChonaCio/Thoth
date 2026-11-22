// Zero-dependency static server + update API: `npm start` → http://<this-machine>:3000
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const updater = require('./updater');

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 = reachable from other devices (needed in containers/headless servers).
// Set HOST=127.0.0.1 to allow only this machine.
const HOST = process.env.HOST || '0.0.0.0';
// When set, installing updates requires this password (recommended whenever the app is reachable from a network).
const ADMIN_PASSWORD = process.env.THOTH_ADMIN_PASSWORD || '';
const SELF_RESTART = process.env.THOTH_SELF_RESTART === '1';
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
const HIDDEN = new Set(['.git', '.updates', '.update-state.json', 'node_modules', '.env', '.claude']);
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Block cross-site requests (e.g. another website POSTing to this server from a visitor's browser)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function checkAdminPassword(req) {
  if (!ADMIN_PASSWORD) return true;
  let given = '';
  try { given = decodeURIComponent(req.headers['x-thoth-admin'] || ''); } catch { return false; }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden', message: 'Cross-origin request blocked.' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/version') {
      return sendJson(res, 200, Object.assign(updater.currentVersion(), { adminRequired: Boolean(ADMIN_PASSWORD) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/updates/check') {
      return sendJson(res, 200, await updater.check(url.searchParams.get('channel')));
    }
    if (req.method === 'POST' && url.pathname === '/api/updates/install') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'unsupported', message: 'Expected JSON.' });
      }
      if (!checkAdminPassword(req)) {
        console.warn(`[update] rejected install with wrong password from ${req.socket.remoteAddress}`);
        await new Promise(r => setTimeout(r, 1000)); // slow down guessing
        return sendJson(res, 401, { error: 'adminRequired', message: 'Wrong or missing update password.' });
      }
      const body = await readBody(req);
      const result = await updater.install(body.channel, String(body.tag || ''));
      // Under systemd/Docker (THOTH_SELF_RESTART=1) exit after replying; the supervisor starts the new code.
      result.autoRestart = result.restartRequired && SELF_RESTART;
      sendJson(res, 200, result);
      console.log(`[update] ${result.installed} installed by ${req.socket.remoteAddress}`);
      if (result.autoRestart) {
        console.log('[update] restarting to load new server code');
        setTimeout(shutdown, 500);
      }
      return;
    }
    return sendJson(res, 404, { error: 'notFound' });
  } catch (e) {
    console.error('[api]', e.message);
    return sendJson(res, e.status || 500, { error: e.code || 'internal', message: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || HIDDEN.has(top)) {
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
  console.log(`Updates come from github.com/${updater.REPO}`);
  if (!LOOPBACK.has(HOST) && !ADMIN_PASSWORD) {
    console.warn('Warning: anyone who can reach this server can install updates. Set THOTH_ADMIN_PASSWORD to require a password.');
  }
});

// Graceful stop for `systemctl stop`, `docker stop` and Ctrl+C
function shutdown() {
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
