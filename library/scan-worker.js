// Library scan service: a long-running, low-priority process started by scanner.js.
// It does the slow file work (walking folders, opening archives, PDFs) one scan at a time, sends the
// results back, and reports its memory/CPU every few seconds. It never reads or writes the database.
// Started, stopped and restarted from the Processes page (or automatically after a crash).
const { collect } = require('./scan-core');

// If the server goes away, stop too
process.on('disconnect', () => process.exit(0));

function sendStats() {
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  process.send({ type: 'stats', rss: m.rss, heapUsed: m.heapUsed, cpuMs: Math.round((c.user + c.system) / 1000) });
}
setInterval(sendStats, 2000).unref();

process.on('message', async msg => {
  if (!msg || msg.type !== 'scan') return;
  const { jobId } = msg;
  try {
    const result = await collect(msg.root, msg.known || {}, p => process.send({ type: 'progress', jobId, ...p }));
    process.send({ type: 'result', jobId, result });
  } catch (e) {
    process.send({ type: 'error', jobId, code: e.code || null, message: e.message });
  }
  sendStats();
});

process.send({ type: 'ready' });
sendStats();
