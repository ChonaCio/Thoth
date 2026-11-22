// Library scan worker: a separate, low-priority process started by scanner.js for each scan.
// It does the slow file work (walking folders, opening archives) so the web server stays responsive,
// then sends the results back and exits. It never reads or writes the database.
const { collect } = require('./scan-core');

// If the server goes away, stop too
process.on('disconnect', () => process.exit(0));

process.on('message', async msg => {
  if (!msg || msg.type !== 'scan') return;
  try {
    const result = await collect(msg.root, msg.known || {}, p => process.send({ type: 'progress', ...p }));
    process.send({ type: 'result', result }, () => process.exit(0));
  } catch (e) {
    process.send({ type: 'error', code: e.code || null, message: e.message }, () => process.exit(1));
  }
});
