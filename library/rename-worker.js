// Rename worker: a low-priority process started when a rename job begins and closed when the rename queue
// is empty (it never reads or writes the database). It gets the file operations already checked by the
// server, a chunk at a time, and does the disk work, reporting progress:
//   { type: 'rename', reqId, ops: [{ from, to, json: [{ from, to }] }] }
//   → progress { reqId, done } … → result { reqId, result: [{ ok, error, json: [{ ok, error, from }] }] }  (same order as ops)
const fs = require('fs');
const path = require('path');

// Why a file operation failed, in words the page translates. On Windows a file another program has open
// (a reader, a sync or antivirus tool) can't be renamed or deleted: EBUSY, or EPERM/EACCES on a file we may
// otherwise change; those are "locked". A read-only disk is "read-only".
function reason(e, file) {
  if (e.code === 'EROFS') return 'read-only';
  if (e.code === 'EBUSY') return 'locked';
  if ((e.code === 'EPERM' || e.code === 'EACCES') && process.platform === 'win32' && file && writable(file)) return 'locked';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'no permission';
  return e.code || e.message;
}
function writable(file) { try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; } }
// A file that's locked for a moment (a thumbnail maker, a sync tool) usually frees up: try a few times
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function retryLocked(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!LOCK_CODES.has(e.code) || i >= 3) throw e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

// op.kind: 'rename' (default) | 'move' (into another folder, created if needed) — never overwriting —
// | 'delete' (a file) | 'rmdir' (a folder, only if empty)
async function run(ops, onProgress = () => {}) {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const r = { ok: false, error: null, json: [] };
    onProgress(i, op.from); // the file it's on now (if the disk hangs here, the server can say which)
    // (tests: a disk that stops answering on this file)
    if (process.env.THOTH_TEST_RENAME_HANG && path.basename(op.from) === process.env.THOTH_TEST_RENAME_HANG) await new Promise(() => {});
    if (op.kind === 'delete') {
      try { await retryLocked(() => fs.promises.unlink(op.from)); r.ok = true; } catch (e) { r.error = e.code === 'ENOENT' ? 'missing' : reason(e, op.from); }
    } else if (op.kind === 'rmtree') {
      // A whole folder (the server checked it's a work's folder inside its library, not the library itself)
      try { await retryLocked(() => fs.promises.rm(op.from, { recursive: true, force: false })); r.ok = true; } catch (e) { r.error = e.code === 'ENOENT' ? 'missing' : reason(e, op.from); }
    } else if (op.kind === 'rmdir') {
      try { await fs.promises.rmdir(op.from); r.ok = true; } catch (e) { r.error = e.code === 'ENOTEMPTY' || e.code === 'EEXIST' ? 'notEmpty' : reason(e); }
    } else if (op.kind !== 'move' && !fs.existsSync(op.from) && fs.existsSync(op.to)) {
      // Already has its new name on disk (the database was behind): nothing to do but say so
      r.ok = true; r.already = true;
    } else if (fs.existsSync(op.to) && op.from.toLowerCase() !== op.to.toLowerCase()) {
      // A case-only change ("chapter 1" → "Chapter 1") is fine; otherwise never overwrite
      r.error = 'exists';
    } else {
      try {
        if (op.kind === 'move') await fs.promises.mkdir(path.dirname(op.to), { recursive: true });
        try { await retryLocked(() => fs.promises.rename(op.from, op.to)); }
        catch (e) {
          if (e.code !== 'EXDEV' || op.kind !== 'move') throw e;
          // Another disk: copy (never over an existing file), then remove the original
          await fs.promises.copyFile(op.from, op.to, fs.constants.COPYFILE_EXCL);
          await fs.promises.unlink(op.from);
        }
        r.ok = true;
      } catch (e) { r.error = reason(e, op.from); }
    }
    if (r.ok) {
      for (const j of op.json || []) {
        if (j.to === j.from || fs.existsSync(j.to)) continue;
        try { await retryLocked(() => fs.promises.rename(j.from, j.to)); r.json.push({ ok: true, from: j.from }); } catch (e) { r.json.push({ ok: false, from: j.from, error: reason(e, j.from) }); }
      }
    }
    out.push(r);
    onProgress(i + 1, op.from, r); // after every file (the server shows it, and notices a disk that stopped answering)
  }
  return out;
}

if (require.main === module && process.send) {
  process.on('disconnect', () => process.exit(0));
  // One chunk of a job per message, in order (a job sends the next chunk when this one is answered)
  process.on('message', async msg => {
    if (!msg || msg.type !== 'rename') return;
    const { reqId } = msg;
    try { process.send({ type: 'result', reqId, result: await run(msg.ops || [], (done, file, r) => process.send({ type: 'progress', reqId, done, file, r })) }); }
    catch (e) { process.send({ type: 'error', reqId, message: e.message }); }
  });
  process.send({ type: 'ready' });
}

module.exports = { run };
