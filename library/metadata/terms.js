// One name per genre/tag across metadata sites, files and folder sources: "Sci-Fi", "Sci Fi", "SciFi",
// "Science Fiction" and "science-fiction" are all "Sci-Fi". Two steps:
//   1. a key that ignores case, accents, spaces and punctuation ("Sci Fi" → "scifi"; "&" = "and")
//   2. known synonyms of that key → one standard name (SYNONYMS below)
// Unknown names keep the spelling of their first appearance (only repeats are dropped).
const SYNONYMS = {
  'Sci-Fi': ['scifi', 'sciencefiction', 'sf', 'scifiction'],
  'Slice of Life': ['sliceoflife', 'sol'],
  'Romantic Comedy': ['romcom', 'romanticcomedy', 'romancecomedy'],
  'Comedy': ['comedy', 'humor', 'humour', 'comedic'],
  'Shounen': ['shounen', 'shonen', 'shōnen'],
  'Shoujo': ['shoujo', 'shojo', 'shōjo'],
  'Seinen': ['seinen'],
  'Josei': ['josei'],
  "Boys' Love": ['boyslove', 'bl', 'yaoi', 'shounenai', 'shonenai'],
  "Girls' Love": ['girlslove', 'gl', 'yuri', 'shoujoai', 'shojoai'],
  'Martial Arts': ['martialarts', 'martialart', 'wuxia', 'kungfu'],
  'Sports': ['sports', 'sport'],
  'School Life': ['schoollife', 'school', 'schoolsetting'],
  'Historical': ['historical', 'history'],
  'Mystery': ['mystery', 'mysteries'],
  'Thriller': ['thriller', 'thrillers'],
  'Horror': ['horror'],
  'Psychological': ['psychological', 'psychology'],
  'Supernatural': ['supernatural', 'paranormal'],
  'Mecha': ['mecha', 'mechas', 'giantrobots'],
  'Robots': ['robots', 'robot', 'androids', 'android'],
  'Magical Girls': ['magicalgirls', 'magicalgirl', 'mahoushoujo', 'mahoshojo'],
  'Superhero': ['superhero', 'superheroes', 'superheros'],
  'Post-Apocalyptic': ['postapocalyptic', 'postapocalypse', 'apocalypse', 'apocalyptic'],
  'Time Travel': ['timetravel', 'timetraveling', 'timetravelling'],
  'Gender Bender': ['genderbender', 'genderswap', 'genderbend'],
  'Reincarnation': ['reincarnation', 'reincarnated'],
  'Isekai': ['isekai', 'anotherworld', 'transportedtoanotherworld'],
  'Vampires': ['vampires', 'vampire'],
  'Zombies': ['zombies', 'zombie'],
  'Demons': ['demons', 'demon'],
  'Monsters': ['monsters', 'monster'],
  'Monster Girls': ['monstergirls', 'monstergirl'],
  'Aliens': ['aliens', 'alien', 'extraterrestrials'],
  'Ghosts': ['ghosts', 'ghost'],
  'Video Games': ['videogames', 'videogame', 'gaming'],
  'Cooking': ['cooking', 'food', 'gourmet', 'culinary'],
  'Music': ['music', 'musical'],
  'Idols': ['idols', 'idol'],
  'Military': ['military'],
  'Crime': ['crime', 'criminal'],
  'Police': ['police'],
  'Detective': ['detective', 'detectives'],
  'Medical': ['medical', 'medicine', 'doctors'],
  'Tragedy': ['tragedy', 'tragic'],
  'Adventure': ['adventure', 'adventures'],
  'Action': ['action'],
  'Fantasy': ['fantasy'],
  'Dark Fantasy': ['darkfantasy'],
  'Drama': ['drama'],
  'Romance': ['romance', 'romantic'],
  'Ecchi': ['ecchi'],
  'Harem': ['harem'],
  'Reverse Harem': ['reverseharem'],
  'Magic': ['magic', 'sorcery'],
  'Samurai': ['samurai'],
  'Ninja': ['ninja', 'ninjas'],
  'Survival': ['survival'],
  'Delinquents': ['delinquents', 'delinquent'],
  'Office Workers': ['officeworkers', 'office', 'workplace'],
  'Villainess': ['villainess'],
  'Full Color': ['fullcolor', 'fullcolour', 'colored', 'coloured'],
  'Long Strip': ['longstrip', 'webtoon', 'webtoons', 'verticalscroll'],
  'Anthology': ['anthology', 'anthologies'],
  'Award Winning': ['awardwinning', 'awardwinner'],
  'Gore': ['gore', 'gory'],
  'Suspense': ['suspense']
};
const strip = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
// "Sci-Fi" → "scifi", "Action & Adventure" → "actionandadventure"
// A plural is the same name as its singular ("Pirates" = "Pirate"): a final "s" is ignored (not "ss")
const keyOf = s => {
  const k = strip(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  return k.length > 3 && /[^s]s$/.test(k) ? k.slice(0, -1) : k;
};
const BY_KEY = new Map();
for (const [name, keys] of Object.entries(SYNONYMS)) for (const k of keys) BY_KEY.set(keyOf(k), name);

const cache = new Map();
// The standard name of a genre/tag ("science fiction" → "Sci-Fi"); unknown ones are trimmed, spaces tidied
function canonical(name) {
  const raw = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  let v = cache.get(raw);
  if (v === undefined) {
    v = BY_KEY.get(keyOf(raw)) || raw;
    if (cache.size > 20000) cache.clear();
    cache.set(raw, v);
  }
  return v;
}
// Every list merged into one, standard names, no repeats (first spelling of unknown names wins)
function unify(...lists) {
  const out = [], seen = new Set();
  for (const list of lists) {
    for (const x of Array.isArray(list) ? list : []) {
      const name = canonical(x);
      const k = keyOf(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out;
}
// Genres and tags together: each name in one list only (a genre isn't repeated as a tag)
function unifyGenresTags(genreLists, tagLists) {
  const genres = unify(...genreLists);
  const g = new Set(genres.map(keyOf));
  return { genres, tags: unify(...tagLists).filter(t => !g.has(keyOf(t))) };
}

module.exports = { canonical, unify, unifyGenresTags, keyOf, SYNONYMS };
