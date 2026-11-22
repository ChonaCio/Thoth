// Zero-dependency static server + update API: `npm start` → http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');

const PORT = Number(process.env.PORT) || 3000;
// Bound to this machine only: the update API writes files, so it must not be reachable from the network.
const HOST = process.env.HOST || '127.0.0.1';
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
const SELF_RESTART = process.env.THOTH_SELF_RESTART === '1';
const HIDDEN =new Set(['.git', '.updates', '.update-state.json', 'node_modules', '.env', '.claude']);

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

// Block cross-site requests (e.g. another website POSTing to localhost)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function handleApi(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden', message: 'Cross-origin request blocked.' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/version') {
      return sendJson(res, 200, updater.currentVersion());
    }
    if (req.method === 'GET' && url.pathname === '/api/updates/check') {
      return sendJson(res, 200, await updater.check(url.searchParams.get('channel')));
    }
    if (req.method === 'POST' && url.pathname === '/api/updates/install') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'unsupported', message: 'Expected JSON.' });
      }
      const body = await readBody(req);
      const result = await updater.install(body.channel, String(body.tag || ''));
      // Under systemd (THOTH_SELF_RESTART=1) exit after replying; systemd starts the new code.
      result.autoRestart = result.restartRequired && SELF_RESTART;
      sendJson(res, 200, result);
      if (result.autoRestart) {
        console.log(`[update] ${result.installed} installed; restarting to load new server code`);
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

  const urlPath = decodeURIComponent(url.pathname);
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

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to another value.` : err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Thoth running at http://${shown}:${PORT} (listening on ${HOST}; updates from github.com/${updater.REPO})`);
});

// Graceful stop for `systemctl stop/restart` and Ctrl+C
function shutdown() {
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
