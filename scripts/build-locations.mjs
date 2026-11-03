/* Builds data/locations.json — Rwanda's five administrative levels, ready to seed.
   Source: the IREME locations API (https://iremeairwanda-1.onrender.com/api/locations), which is
   the register this project's own division data lives in. Run this again when that register changes.

     node scripts/build-locations.mjs
     node scripts/build-locations.mjs --coords data/division-coords.json   # merge OSM centroids
*/
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const API = process.env.LOCATIONS_API || 'https://iremeairwanda-1.onrender.com/api/locations';
const LEVELS = ['provinces', 'districts', 'sectors', 'cells', 'villages'];
/* The document expects these; a different number means the register changed or a page was cut off. */
const EXPECTED = { provinces: 5, districts: 30, sectors: 416, cells: 2149, villages: 14837 };
const PARENT_KEY = { provinces: null, districts: 'provinceId', sectors: 'districtId', cells: 'sectorId', villages: 'cellId' };
/* The register spells every name once; these are the official Kinyarwanda forms of the five provinces. */
const PROVINCE_RW = {
  'eastern-province': "Intara y'Iburasirazuba",
  'kigali-city': 'Umujyi wa Kigali',
  'northern-province': "Intara y'Amajyaruguru",
  'southern-province': "Intara y'Amajyepfo",
  'western-province': "Intara y'Iburengerazuba",
};

const fetchItems = async (level) => {
  const response = await fetch(`${API}/${level}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'seremoto-build-locations/1.0' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`${level}: HTTP ${response.status}`);
  const body = await response.json();
  const items = body.items || body;
  if (!Array.isArray(items)) throw new Error(`${level}: response has no items array`);
  return items;
};

const coordsFile = process.argv.includes('--coords')
  ? process.argv[process.argv.indexOf('--coords') + 1]
  : null;

const byId = new Map();
const rows = {};
for (const level of LEVELS) {
  const items = await fetchItems(level);
  if (items.length !== EXPECTED[level]) {
    throw new Error(`${level}: register returned ${items.length} rows, expected ${EXPECTED[level]}`);
  }
  for (const item of items) {
    if (!item.code || !item.name) throw new Error(`${level}: row without a code or name: ${JSON.stringify(item)}`);
    if (byId.has(item.id)) throw new Error(`${level}: duplicate id ${item.id}`);
    byId.set(item.id, item);
  }
  rows[level] = items;
}

const codes = new Set([...byId.values()].map((item) => item.code));
if (codes.size !== byId.size) throw new Error('two divisions share one code');

const coords = coordsFile
  ? (JSON.parse(await readFile(path.join(ROOT, coordsFile), 'utf8')).coords || {})
  : {};

const build = async (level) => {
  const key = PARENT_KEY[level];
  const out = [];
  for (const item of rows[level]) {
    const name = String(item.name).trim();
    if (key) {
      const parent = byId.get(item[key]);
      if (!parent) throw new Error(`${level} ${item.code}: parent ${item[key]} is not in the register`);
      if (!item.code.startsWith(`${parent.code}-`)) {
        throw new Error(`${level} ${item.code}: not a child of ${parent.code}`);
      }
    }
    const point = coords[item.code];
    const row = [item.code, name];
    if (level === 'provinces') row.push(PROVINCE_RW[item.code] || name);
    if (point) row.push(Math.round(point.lat * 1e5) / 1e5, Math.round(point.lng * 1e5) / 1e5);
    else if (level === 'provinces' || level === 'districts' || level === 'sectors') row.push(null, null);
    out.push(row);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
};

const seed = {
  _readme: 'Rwanda administrative divisions. Rows are [code, name] plus, for provinces, [code, name, name_rw]. Provinces, districts and sectors also carry [lat, lng] when an OpenStreetMap centroid is known (null when it is not). Parentage comes from the code: a sector code is its district code, a hyphen and its own slug. Built by scripts/build-locations.mjs from ' + API,
  source: API,
  counts: { ...EXPECTED },
  provinces: await build('provinces'),
  districts: await build('districts'),
  sectors: await build('sectors'),
  cells: await build('cells'),
  villages: await build('villages'),
};

const target = path.join(ROOT, 'data', 'locations.json');
await writeFile(target, JSON.stringify(seed));
const bytes = (await readFile(target)).length;
console.log(`[locations] wrote ${path.relative(ROOT, target)} (${(bytes / 1024).toFixed(0)} KB)`);
for (const level of LEVELS) console.log(`  ${level}: ${seed[level].length}`);
const latIndex = (level) => (level === 'provinces' ? 3 : 2);
const withCoords = LEVELS.reduce((sum, level) => sum + seed[level].filter((row) => typeof row[latIndex(level)] === 'number').length, 0);
console.log(`  rows carrying an OSM centroid: ${withCoords}`);
