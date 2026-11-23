// node test-providers-live.js <app dir> — every keyless provider against the real services
const path = require('path');
const { PROVIDERS, matchScore } = require(path.join(path.resolve(process.argv[2]), 'library', 'metadata', 'providers.js'));
const cases = [['One Piece', 1997], ['Solo Leveling', 2018], ['The Hobbit', 1937]];
(async () => {
  let fails = 0;
  for (const p of PROVIDERS) {
    if (p.needsKey) { console.log(`- ${p.name}: skipped (needs an API key)`); continue; }
    for (const [q, year] of cases) {
      const t0 = Date.now();
      try {
        const results = await p.search(q);
        const scored = results.map(r => ({ r, s: matchScore(q, r, year) })).sort((a, b) => b.s - a.s);
        const best = scored[0];
        if (!best || best.s < 0.85) { console.log(`  ${p.name.padEnd(13)} "${q}": no good match (${results.length} results; best ${best ? best.s + ' ' + best.r.title : '-'})`); continue; }
        const m = await p.fetch(best.r.id);
        const got = ['summary', 'status', 'year', 'type', 'publisher', 'authors', 'tags', 'rating', 'cover', 'readingDirection'].filter(k => m[k] != null && !(Array.isArray(m[k]) && !m[k].length));
        console.log(`  ${p.name.padEnd(13)} "${q}" → "${m.title}" (${m.type || '?'}, ${m.year || '?'}, score ${best.s}) fields: ${got.join(', ')}  [${Date.now() - t0} ms]`);
        if (!m.summary && !m.tags) fails++;
      } catch (e) {
        console.log(`  ${p.name.padEnd(13)} "${q}": ERROR ${e.message}`);
        fails++;
      }
    }
  }
  console.log(fails ? `\n${fails} problems` : '\nALL PROVIDERS ANSWERED');
})();
