// Zero-dependency web server: static files, accounts API and update API.
// `npm start` → http://<this-machine>:3000
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./auth');
const updater = require('./updater');

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 = reachable from other devices (needed in containers/headless servers).
// Set HOST=127.0.0.1 to allow only this machine.
const HOST = process.env.HOST || '0.0.0.0';
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
// Never served as static files
const HIDDEN = new Set(['.git', '.updates', '.update-state.json', '.build-info.json', 'node_modules', '.env', '.claude', 'data', 'deploy', 'scripts']);
const MAX_BODY = 1024 * 1024;

function sendJson(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(auth.httpError(413, 'tooLarge', 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
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
      body = await readBody(req);
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
      const result = await updater.install(body.channel, String(body.tag || ''));
      // Under systemd/Docker (THOTH_SELF_RESTART=1) exit after replying; the supervisor starts the new code.
      result.autoRestart = result.restartRequired && SELF_RESTART;
      sendJson(res, 200, result);
      console.log(`[update] ${result.installed} installed by ${user.username}`);
      if (result.autoRestart) {
        console.log('[update] restarting to load new server code');
        setTimeout(shutdown, 500);
      }
      return;
    }
    return sendJson(res, 404, { error: 'notFound' });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[api]', e.message);
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
  console.log(`Data folder: ${auth.DATA_DIR}`);
  console.log(`Updates come from github.com/${updater.REPO}`);
  if (auth.setupRequired()) {
    console.log('No users yet: open the app and create the first user (it becomes the administrator).');
  }
  updater.resolveVersion().then(v => console.log(`Version: ${describeVersion(v)}`), () => {});
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

// Graceful stop for `systemctl stop`, `docker stop` and Ctrl+C
function shutdown() {
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
