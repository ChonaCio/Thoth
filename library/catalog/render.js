// Pages that a site builds with its scripts in the browser (an app shell: <div id="root"></div> + scripts) arrive
// almost empty, so selectors find nothing in them. For a source with "Build pages in a browser" on, such pages
// are opened in a headless Chrome, Edge or Chromium installed on this server, and what it shows once the scripts
// have run (the page's DOM) is read instead of what the site sent.
//
//   findBrowser()             → the browser's path, or null (THOTH_BROWSER, else the usual install places)
//   renderPage(url, opts)     → { url, text }: the page after its scripts ran
//
// Safety:
//   - the browser gets a fresh, throwaway profile (nothing of anyone's own browser), no images, no extensions
//   - all its traffic goes through a small proxy here that only lets it reach public addresses (each host is
//     resolved and every address checked, and the connection goes to the address checked) on ports 80 and 443:
//     a page's scripts can't reach this machine or the local network. WebRTC and QUIC, which wouldn't go through
//     the proxy, are off.
//   - the same generic user agent as the fetcher; robots.txt and the site's pace are checked by the fetcher before
//     a page is opened (fetcher.render)
//   - extra arguments for the browser: THOTH_BROWSER_ARGS (e.g. "--no-sandbox" in a container that runs as root —
//     better: run it as another user)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const dns = require('dns');
const { execFile } = require('child_process');

const MAX_OUT = 16 * 1024 * 1024;
const MAX_AT_ONCE = 2;

/* ---------------- The browser ---------------- */
let found; // (looked for once)
function findBrowser() {
  if (found !== undefined) return found;
  const env = process.env.THOTH_BROWSER;
  if (env) return (found = fs.existsSync(env) ? env : null);
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const places = process.platform === 'win32'
    ? pf.flatMap(d => [['Google', 'Chrome', 'Application', 'chrome.exe'], ['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Chromium', 'Application', 'chrome.exe']].map(p => path.join(d, ...p)))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : String(process.env.PATH || '/usr/bin:/usr/local/bin').split(':').concat('/snap/bin').flatMap(d => ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable'].map(n => path.join(d, n)));
  return (found = places.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null);
}

/* ---------------- Only public addresses: the proxy the browser goes through ---------------- */
function privateIp(ip) {
  ip = String(ip).toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); if (m) ip = m[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  return ip === '::' || ip === '::1' || /^(f[cd]|fe[89ab])/.test(ip) || ip.startsWith('ff') || ip.startsWith('64:ff9b:') || ip.startsWith('2002:');
}
// host → an address to connect to (every address it has must be public)
function resolvePublic(host, allowLocal) {
  return new Promise((resolve, reject) => {
    const h = String(host).replace(/^\[|\]$/g, '');
    if (net.isIP(h)) return allowLocal || !privateIp(h) ? resolve(h) : reject(new Error('not public'));
    if (!allowLocal && (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(h) || !h.includes('.'))) return reject(new Error('not public'));
    dns.lookup(h, { all: true }, (e, list) => {
      if (e || !list || !list.length) return reject(e || new Error('no address'));
      if (!allowLocal && list.some(x => privateIp(x.address))) return reject(new Error('not public'));
      resolve(list[0].address);
    });
  });
}
let guard = null; // { port, allowLocal, server }
function startGuard(allowLocal) {
  if (guard && guard.allowLocal === allowLocal) return guard.ready;
  if (guard) guard.server.close();
  const okPort = p => allowLocal || p === 80 || p === 443;
  const server = http.createServer((req, res) => {
    // A plain http:// request: "GET http://host/path"
    let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    const port = Number(u.port) || 80;
    if (u.protocol !== 'http:' || !okPort(port)) { res.writeHead(403); return res.end(); }
    resolvePublic(u.hostname, allowLocal).then(ip => {
      const headers = Object.assign({}, req.headers); delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const out = http.request({ host: ip, port, method: req.method, path: u.pathname + u.search, headers, setHost: false }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      out.setTimeout(30000, () => out.destroy());
      out.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(out);
    }, () => { res.writeHead(403); res.end(); });
  });
  // https:// and wss://: "CONNECT host:443"
  server.on('connect', (req, sock, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    const port = m ? Number(m[2]) : 0;
    if (!m || !okPort(port)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    sock.on('error', () => {});
    resolvePublic(m[1], allowLocal).then(ip => {
      const up = net.connect(port, ip, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
      up.setTimeout(60000, () => up.destroy());
      up.on('error', () => sock.destroy());
      sock.on('close', () => up.destroy());
    }, () => sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  });
  server.unref();
  guard = { allowLocal, server, ready: new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }) };
  return guard.ready;
}

/* ---------------- Opening a page ---------------- */
let running = 0; const queue = [];
const turn = () => new Promise(r => { if (running < MAX_AT_ONCE) { running++; r(); } else queue.push(r); });
const leave = () => { const next = queue.shift(); if (next) next(); else running--; };

// waitMs: how long the page's scripts get (virtual time: the browser moves on sooner when nothing is pending)
async function renderPage(url, { allowLocal = false, waitMs = 8000, timeoutMs = 60000, userAgent } = {}) {
  const exe = findBrowser();
  if (!exe) throw Object.assign(new Error('No Chrome, Edge or Chromium found on the server to build pages with (install one, or set THOTH_BROWSER to its path)'), { code: 'noBrowser' });
  const port = await startGuard(Boolean(allowLocal));
  await turn();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-render-'));
  try {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--mute-audio', '--hide-scrollbars', '--blink-settings=imagesEnabled=false', '--window-size=1280,2000', '--lang=en',
      `--user-data-dir=${profile}`, `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>',
      '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--user-agent=${userAgent || require('./fetcher').UA}`, `--virtual-time-budget=${Math.max(1000, Math.min(60000, Math.round(waitMs)))}`]
      .concat(String(process.env.THOTH_BROWSER_ARGS || '').split(/\s+/).filter(Boolean))
      .concat(['--dump-dom', url]);
    const text = await new Promise((resolve, reject) => {
      execFile(exe, args, { timeout: timeoutMs, maxBuffer: MAX_OUT, windowsHide: true, encoding: 'utf8' }, (e, out) => {
        if (out && out.length > 20) return resolve(out); // (the page, even when the browser complained on its way out)
        reject(Object.assign(new Error(e && e.killed ? 'The browser took too long to build the page' : `The browser couldn't build the page${e ? ': ' + String(e.message).split('\n')[0].slice(0, 200) : ''}`), { code: 'render' }));
      });
    });
    return { url, text };
  } finally {
    leave();
    fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }, () => {});
  }
}

module.exports = { findBrowser, renderPage, privateIp, resolvePublic, startGuard };
