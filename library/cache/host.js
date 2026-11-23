// A cache process: `node host.js <kind>` runs library/cache/<kind>.js (pages, covers, works, search) in its own
// process, so each cache's memory and work stay out of the web server. It answers requests by id and reports
// its statistics every 2 seconds. It never touches the library database (the server sends what it needs).
//   → { reqId, op, args }   ← { type: 'result' | 'error', reqId, result | code, message }   ← { type: 'stats', info }
const kind = process.argv[2];
if (!/^[a-z]+$/.test(kind || '')) { console.error('[cache] unknown kind'); process.exit(2); }
const mod = require(`./${kind}`);

const send = m => { try { process.send(m); } catch { /* the server is gone */ } };
process.on('disconnect', () => process.exit(0));
process.on('message', async m => {
  if (!m || !m.reqId) return;
  const fn = mod.handlers[m.op];
  if (!fn) return send({ type: 'error', reqId: m.reqId, code: 'unknownOp', message: `Unknown ${kind} operation ${m.op}` });
  try { send({ type: 'result', reqId: m.reqId, result: await fn(m.args || {}) }); }
  catch (e) { send({ type: 'error', reqId: m.reqId, code: e.code || null, status: e.status || null, message: e.message }); }
});
const stats = () => {
  const mem = process.memoryUsage(), cpu = process.cpuUsage();
  send({ type: 'stats', info: Object.assign({ rss: mem.rss, heapUsed: mem.heapUsed, cpuMs: Math.round((cpu.user + cpu.system) / 1000) }, mod.info ? mod.info() : {}) });
};
setInterval(stats, 2000).unref();
send({ type: 'ready' });
stats();
