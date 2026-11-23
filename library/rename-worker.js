// Rename worker: a low-priority process started when a rename job begins and closed when the rename queue
// is empty (it never reads or writes the database). It gets the file operations already checked by the
// server, a chunk at a time, and does the disk work, reporting progress:
//   { type: 'rename', reqId, ops: [{ from, to, json: [{ from, to }] }] }
//   → progress { reqId, done } … → result { reqId, result: [{ ok, error, json: [{ ok, error, from }] }] }  (same order as ops)
const fs = require('fs');

const reason = e => (e.code === 'EROFS' ? 'read-only' : e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission' : e.code || e.message);

async function run(ops, onProgress = () => {}) {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const r = { ok: false, error: null, json: [] };
    // A case-only change ("chapter 1" → "Chapter 1") is fine; otherwise never overwrite
    if (fs.existsSync(op.to) && op.from.toLowerCase() !== op.to.toLowerCase()) r.error = 'exists';
    else {
      try { await fs.promises.rename(op.from, op.to); r.ok = true; } catch (e) { r.error = reason(e); }
    }
    if (r.ok) {
      for (const j of op.json || []) {
        if (j.to === j.from || fs.existsSync(j.to)) continue;
        try { await fs.promises.rename(j.from, j.to); r.json.push({ ok: true, from: j.from }); } catch (e) { r.json.push({ ok: false, from: j.from, error: reason(e) }); }
      }
    }
    out.push(r);
    if (i % 20 === 19 || i === ops.length - 1) onProgress(i + 1);
  }
  return out;
}

if (require.main === module && process.send) {
  process.on('disconnect', () => process.exit(0));
  // One chunk of a job per message, in order (a job sends the next chunk when this one is answered)
  process.on('message', async msg => {
    if (!msg || msg.type !== 'rename') return;
    const { reqId } = msg;
    try { process.send({ type: 'result', reqId, result: await run(msg.ops || [], done => process.send({ type: 'progress', reqId, done })) }); }
    catch (e) { process.send({ type: 'error', reqId, message: e.message }); }
  });
  process.send({ type: 'ready' });
}

module.exports = { run };
