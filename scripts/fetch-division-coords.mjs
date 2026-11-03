/* Builds data/division-coords.json — one map point per province, district and sector.
   Rwanda's own register (see build-locations.mjs) carries names and codes but no coordinates, and the
   live tracker needs to know which part of the country a rider's GPS fix falls in, so the points come
   from OpenStreetMap's administrative boundaries: level 4 = Intara, level 6 = Akarere, level 8 = Umurenge.
   Cells and villages are not mapped there, so they stay unpointed.

     node scripts/fetch-division-coords.mjs
     node scripts/build-locations.mjs --coords data/division-coords.json

   A level-8 relation carries no pointer to its district, so sectors are matched by name — and a name
   like Remera, Karama or Muganza belongs to several sectors in different districts. Where a name is
   shared, the pair whose district centre sits closest to the sector wins.
   © OpenStreetMap contributors (ODbL). A centre point is not a boundary — the app must say "around". */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const QUERY = `
[out:json][timeout:600];
area["ISO3166-1"="RW"][admin_level=2]->.rw;
relation["boundary"="administrative"]["admin_level"~"^(4|6|8)$"](area.rw);
out center tags;
`;

/* Names arrive as "Kirehe District", "Akarere ka Gasabo", "Umurenge wa Remera". Fold them to the bare
   place word, in the same slug shape a division code ends with. */
const slug = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/* OSM calls the province "City of Kigali" and the register calls it "Kigali City". */
const ALIAS = { 'city-of-kigali': 'kigali-city', 'umujyi-wa-kigali': 'kigali-city' };

const bare = (value) => {
  const key = slug(value)
    .replace(/^(akarere-ka|umurenge-wa|intara-y|umujyi-wa-|akagari-ka)-/, '')
    .replace(/^(akarere|intara|umurenge|akagari)-/, '')
    .replace(/-(sector|district|province)$/, '')
    .replace(/^(sector|district|province)-/, '')
    .replace(/^-+|-+$/g, '');
  return ALIAS[key] || key;
};

const groupBy = (rows, keyOf) => {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
};

const post = async (body) => {
  for (const url of ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'seremoto-division-coords/1.0' },
        body,
        signal: AbortSignal.timeout(300000),
      });
      const text = await response.text();
      if (!response.ok) {
        console.warn(`[coords] ${url} answered ${response.status}: ${text.slice(0, 140)}`);
        continue;
      }
      return JSON.parse(text);
    } catch (error) {
      console.warn(`[coords] ${url} failed: ${error.message}`);
    }
  }
  throw new Error('no Overpass mirror could answer; try again later');
};

const seed = JSON.parse(await readFile(path.join(ROOT, 'data', 'locations.json'), 'utf8'));
const payload = await post(`data=${encodeURIComponent(QUERY)}`);

const relations = [];
const seen = new Set();
for (const element of payload.elements) {
  if (element.type !== 'relation' || seen.has(element.id)) continue;
  seen.add(element.id);
  const tags = element.tags || {};
  relations.push({
    level: tags.admin_level == null ? null : String(tags.admin_level),
    name: tags.name ?? null,
    lat: element.center?.lat ?? null,
    lng: element.center?.lon ?? null,
  });
}

const coords = {};
const skipped = [];
const pointed = (code, relation) => {
  if (!relation || relation.lat === null) return false;
  coords[code] = { lat: relation.lat, lng: relation.lng };
  return true;
};

/* Provinces and districts are named once in the country, so a unique-name match is safe on its own. */
const byLevel = (level) => relations.filter((relation) => relation.level === String(level));

const matchByName = (level, rows) => {
  const found = byLevel(level);
  const ours = groupBy(rows, ([, name]) => bare(name));
  const theirs = groupBy(found, (relation) => bare(relation.name));
  let hit = 0;
  for (const [code, name] of rows) {
    const key = bare(name);
    if (ours.get(key).length > 1 || theirs.get(key).length > 1) {
      skipped.push(`${code}: "${name}" is not a unique name at level ${level}`);
      continue;
    }
    if (pointed(code, (theirs.get(key) || [])[0])) hit += 1;
    else skipped.push(`${code}: no level-${level} boundary named "${name}"`);
  }
  console.log(`[coords] level ${level}: ${hit} of ${rows.length} pointed by name`);
  return hit;
};

const ourProvinces = seed.provinces.map((row) => [row[0], row[1]]);
const ourDistricts = seed.districts.map((row) => [row[0], row[1]]);
const ourSectors = seed.sectors.map((row) => [row[0], row[1]]);
matchByName(4, ourProvinces);
matchByName(6, ourDistricts);

const kmBetween = (a, b) => Math.hypot(
  (a.lat - b.lat) * 111,
  (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180),
);

/* Sectors: pair each OSM sector centre with every register sector that shares its name, score the pair by
   how far the sector sits from its own district centre, then take the closest pairs first. A pair only
   counts while both sides are still unclaimed, so four sectors called Remera spread over four districts. */
const DISTRICT_REACH_KM = 90;
const sectorFound = byLevel(8).filter((relation) => relation.lat !== null && bare(relation.name));
const sectorsByName = groupBy(ourSectors, ([, name]) => bare(name));
const foundByName = groupBy(sectorFound, (relation) => bare(relation.name));
const shared = (key) => sectorsByName.get(key).length > 1 || foundByName.get(key).length > 1;

const pairs = [];
for (const relation of sectorFound) {
  const key = bare(relation.name);
  for (const [code] of sectorsByName.get(key) || []) {
    const district = coords[code.slice(0, code.lastIndexOf('-'))];
    if (!district) continue;
    pairs.push({ key, code, relation, km: kmBetween(district, relation) });
  }
}
pairs.sort((a, b) => a.km - b.km);

const takenRelation = new Set();
const takenCode = new Set();
let sectorHit = 0;
let sectorDisambiguated = 0;
for (const pair of pairs) {
  if (takenRelation.has(pair.relation) || takenCode.has(pair.code)) continue;
  if (pair.km > DISTRICT_REACH_KM) continue;
  if (!pointed(pair.code, pair.relation)) continue;
  takenRelation.add(pair.relation);
  takenCode.add(pair.code);
  sectorHit += 1;
  if (shared(pair.key)) sectorDisambiguated += 1;
}
console.log(`[coords] level 8: ${sectorHit} of ${ourSectors.length} sectors pointed (${sectorDisambiguated} where the name is shared)`);

const out = {
  _readme: "OpenStreetMap centre points for Rwanda's provinces, districts and sectors, keyed by the code in data/locations.json. Cells and villages are not mapped in OSM and have no point here. A centre is not a boundary. © OpenStreetMap contributors (ODbL), produced by scripts/fetch-division-coords.mjs.",
  source: 'https://overpass-api.de (OpenStreetMap)',
  attribution: 'Division coordinates: © OpenStreetMap contributors.',
  levels: { province: 4, district: 6, sector: 8 },
  coords,
};
const target = path.join(ROOT, 'data', 'division-coords.json');
await writeFile(target, JSON.stringify(out, null, 0));
console.log(`[coords] wrote ${path.relative(ROOT, target)} — ${Object.keys(coords).length} divisions carry a point`);
if (skipped.length) {
  console.log(`[coords] ${skipped.length} could not be placed, first few:`);
  for (const line of skipped.slice(0, 10)) console.log(`  ${line}`);
}
