// Rename worker: a short-lived, low-priority process started by rename.apply for one batch of renames and
// closed right after (it never reads or writes the database). It gets the file operations already checked by
// the server and does the disk work, reporting progress:
//   { type: 'rename', ops: [{ from, to, json: [{ from, to }] }] }
//   → progress { done } … → result [{ ok, error, json: [{ ok, error, from }] }]  (same order as ops)
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
  process.on('message', async msg => {
    if (!msg || msg.type !== 'rename') return;
    try { process.send({ type: 'result', result: await run(msg.ops || [], done => process.send({ type: 'progress', done })) }); }
    catch (e) { process.send({ type: 'error', message: e.message }); }
  });
  process.send({ type: 'ready' });
}

module.exports = { run };
