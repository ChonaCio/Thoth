// Server configuration: settings that belong to this server (not to a user or a browser), edited by
// administrators on the "Server settings" page and saved in data/config.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, 'data'));
const FILE = path.join(DATA_DIR, 'config.json');
const CPUS = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);

// name → { default, min, max }
const SCHEMA = {
  // Worker processes that read library files at the same time (each uses roughly 40 MB of memory).
  // Leave one core for the web server by default.
  scanWorkers: { default: Math.min(4, Math.max(1, CPUS - 1)), min: 1, max: Math.max(1, Math.min(16, CPUS * 2)) },
  // Files each worker process reads at the same time (helps on fast disks and network storage)
  scanConcurrency: { default: 4, min: 1, max: 32 }
};

const listeners = [];
let values = load();

function defaults() {
  const d = {};
  for (const [k, s] of Object.entries(SCHEMA)) d[k] = s.default;
  return d;
}
function clamp(key, v) {
  const s = SCHEMA[key];
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return s.default;
  return Math.min(s.max, Math.max(s.min, n));
}
function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[config] can't read ${FILE}: ${e.message}; using defaults`);
  }
  const v = defaults();
  for (const k of Object.keys(SCHEMA)) if (k in saved) v[k] = clamp(k, saved[k]);
  return v;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2));
  fs.renameSync(tmp, FILE);
}

// Validates and applies a partial update; returns the keys that changed. Throws { code: 'invalid' }.
function update(patch) {
  const changed = [];
  const next = Object.assign({}, values);
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SCHEMA[k]) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < SCHEMA[k].min || n > SCHEMA[k].max) {
      throw Object.assign(new Error(`${k} must be a whole number from ${SCHEMA[k].min} to ${SCHEMA[k].max}`), { status: 400, code: 'invalid', field: k });
    }
    if (next[k] !== n) { next[k] = n; changed.push(k); }
  }
  if (changed.length) {
    values = next;
    save();
    for (const fn of listeners) { try { fn(changed, values); } catch (e) { console.error('[config] listener:', e.message); } }
  }
  return changed;
}

module.exports = {
  get: () => Object.assign({}, values),
  update,
  onChange: fn => listeners.push(fn),
  describe: () => ({ values: Object.assign({}, values), schema: SCHEMA, cpus: CPUS }),
  CPUS
};
