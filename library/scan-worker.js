// Library scan worker: one of the low-priority processes of the scan service (scanner.js starts as many as
// Server settings → "Scan processes" says when a scan begins, and closes them when idle). It does the slow file work on request and
// reports its memory/CPU every few seconds. It never reads or writes the database.
//   { type: 'list', reqId, root, prev, quick }             → every book file with size and modified time (+ scan index)
//   { type: 'analyze', reqId, root, files, concurrency }   → page counts and ComicInfo.xml for those files
const { listFiles, analyzeFiles } = require('./scan-core');

// If the server goes away, stop too
process.on('disconnect', () => process.exit(0));

function sendStats() {
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  process.send({ type: 'stats', rss: m.rss, heapUsed: m.heapUsed, cpuMs: Math.round((c.user + c.system) / 1000) });
}
setInterval(sendStats, 2000).unref();

process.on('message', async msg => {
  if (!msg || !msg.reqId) return;
  const { reqId } = msg;
  try {
    let result;
    if (msg.type === 'list') {
      result = await listFiles(msg.root, n => process.send({ type: 'progress', reqId, filesSeen: n }), { prev: msg.prev, quick: msg.quick });
    } else if (msg.type === 'analyze') {
      result = await analyzeFiles(msg.root, msg.files || [], msg.concurrency || 1, n => process.send({ type: 'progress', reqId, analyzed: n }));
    } else {
      throw new Error(`Unknown request ${msg.type}`);
    }
    process.send({ type: 'result', reqId, result });
  } catch (e) {
    process.send({ type: 'error', reqId, code: e.code || null, message: e.message });
  }
});

process.send({ type: 'ready' });
sendStats();
