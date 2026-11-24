// Pages built in a browser (external catalog sources with "Build pages in a browser"):
//   - the address guard the browser goes through: private and local addresses refused, other ports refused
//   - with a Chrome / Edge / Chromium on this machine: a page that builds itself with scripts is read as built,
//     by the fetcher (robots.txt still followed) and by the generic reader's work page
//   - without one: a clear "noBrowser" error
// node tests/test-render.js
const http = require('http');
const net = require('net');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const render = require(path.join(APP, 'library/catalog/render'));
const { createFetcher } = require(path.join(APP, 'library/catalog/fetcher'));
const adapters = require(path.join(APP, 'library/catalog/adapters'));

let failed = 0, passed = 0;
const check = (ok, name, extra) => { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };
const PORT = 3996;

const SHELL = `<!doctype html><html><head><title>Shell</title></head><body style="background:#111"><div id="root"></div>
<script>setTimeout(function () {
  document.getElementById('root').innerHTML = '<h1 class="ttl">Built By Script</h1><p class="sum">A summary only scripts write.</p>' +
    '<ul class="chs"><li><a href="/series/one/chapter-2">Chapter 2</a></li><li><a href="/series/one/chapter-1">Chapter 1</a></li></ul>';
}, 300);</script></body></html>`;
const site = http.createServer((req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\n'); }
  if (req.url.startsWith('/series/one')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(SHELL); }
  res.writeHead(404); res.end('nope');
});

// One request through the guard proxy: → the status line
function viaGuard(port, raw) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => s.write(raw));
    let got = '';
    s.on('data', d => { got += d; if (/\r\n/.test(got)) { s.destroy(); resolve(got.split('\r\n')[0]); } });
    s.on('error', () => resolve('error'));
    s.on('close', () => resolve(got.split('\r\n')[0] || 'closed'));
    setTimeout(() => { s.destroy(); resolve('timeout'); }, 8000);
  });
}

(async () => {
  console.log('Address checks');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) check(render.privateIp(ip), `${ip} is private`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) check(!render.privateIp(ip), `${ip} is public`);

  console.log('The guard the browser goes through');
  const gport = await render.startGuard(false);
  check(/403/.test(await viaGuard(gport, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')), 'CONNECT to this machine refused');
  check(/403/.test(await viaGuard(gport, 'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n')), 'CONNECT to localhost refused');
  check(/403/.test(await viaGuard(gport, 'CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1:443\r\n\r\n')), 'CONNECT to the local network refused');
  check(/403/.test(await viaGuard(gport, 'CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n')), 'ports other than 80/443 refused');
  check(/403/.test(await viaGuard(gport, `GET http://127.0.0.1:${PORT}/series/one HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n\r\n`)), 'plain http to this machine refused');
  const f0 = createFetcher({ gapMs: 50 });
  let e0 = null; try { await f0.render(`http://127.0.0.1:${PORT}/series/one`); } catch (e) { e0 = e; }
  check(e0 && e0.code === 'notPublic', 'the fetcher refuses to build a local page', e0 && e0.code);

  const exe = render.findBrowser();
  if (!exe) {
    console.log('No Chrome / Edge / Chromium here: building pages is skipped');
    let e1 = null; try { await render.renderPage('https://example.com/'); } catch (e) { e1 = e; }
    check(e1 && e1.code === 'noBrowser', 'a clear error without a browser');
  } else {
    console.log('Building pages with ' + path.basename(exe));
    await new Promise(r => site.listen(PORT, '127.0.0.1', r));
    const base = `http://127.0.0.1:${PORT}`;
    try {
      const f = createFetcher({ gapMs: 50, allowLocal: true });
      const plain = await f.get(base + '/series/one');
      check(/<div id="root"><\/div>/.test(plain.text), 'as sent, the page is empty');
      const built = await f.render(base + '/series/one', { waitMs: 4000 });
      check(/<div id="root"><h1 class="ttl">Built By Script/.test(built.text) && built.rendered, 'built in the browser, it has what its scripts wrote');
      let e2 = null; try { await f.render(base + '/private/x'); } catch (e) { e2 = e; }
      check(e2 && e2.code === 'robots', 'robots.txt is still followed', e2 && e2.code);
      // The generic reader with "Build pages in a browser": the work page as built
      const src = { type: 'custom', baseUrl: base, includeChapters: true, render: true, selectors: { workTitle: 'h1.ttl', summary: 'p.sum', chapter: 'ul.chs li' } };
      const ctx = { src, get: f.get, page: u => f.render(u, { waitMs: 4000 }), incremental: false, known: new Set() };
      const work = await adapters.ADAPTERS.custom.fetchWork(ctx, { sid: '/series/one', url: base + '/series/one', title: 'one' });
      check(work.title === 'Built By Script', 'work title from the built page', work.title);
      check(/only scripts write/.test(work.summary || ''), 'summary from the built page');
      check((work.chapters || []).length === 2, 'chapters from the built page', String((work.chapters || []).length));
      // Through the preview the wizard asks for
      const pv = await require(path.join(APP, 'library/catalog/sitefiles')).previewPage({ url: base + '/series/one', allowLocal: true, render: true, waitMs: 4000 });
      check(pv.rendered && /Built By Script/.test(pv.source), 'the wizard preview gets the built page');
    } catch (e) { check(false, 'building pages', e.message); }
    site.close();
  }
  console.log(failed ? `\n${failed} RENDER CHECK(S) FAILED` : `\nALL ${passed} RENDER CHECKS PASSED`);
  process.exit(failed ? 1 : 0);
})();
