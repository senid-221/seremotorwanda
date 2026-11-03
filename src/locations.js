/* Rwanda's administrative divisions, served from memory.
   The whole tree (5 Intara, 30 Uturere, 416 Imirenge, 2149 Utugari, 14837 Imidugudu) is 17,437 rows,
   small enough to hold in a Map, so the dropdowns, the rider filters and the live tracker answer
   without touching the network. The rows live in Neon; data/locations.json is where they come from. */
import fs from 'node:fs';
import path from 'node:path';
import { all, run, transaction } from './db.js';
import { haversineKm } from './osm.js';

const SEED_FILE = path.resolve(import.meta.dirname, '..', 'data', 'locations.json');

/* The names follow the law: Umujyi wa Kigali is one province and its three districts are cities. */
export const LEVELS = [
  { level: 1, key: 'province', en: 'Province', enPlural: 'Provinces', rw: 'Intara', rwPlural: 'Intara' },
  { level: 2, key: 'district', en: 'District', enPlural: 'Districts', rw: 'Akarere', rwPlural: 'Uturere' },
  { level: 3, key: 'sector', en: 'Sector', enPlural: 'Sectors', rw: 'Umurenge', rwPlural: 'Imirenge' },
  { level: 4, key: 'cell', en: 'Cell', enPlural: 'Cells', rw: 'Akagari', rwPlural: 'Utugari' },
  { level: 5, key: 'village', en: 'Village', enPlural: 'Villages', rw: 'Umudugudu', rwPlural: 'Imidugudu' },
];

const KEY_BY_LEVEL = new Map(LEVELS.map((entry) => [entry.level, entry.key]));
const LEVEL_BY_KEY = new Map(LEVELS.map((entry) => [entry.key, entry.level]));
export const levelKey = (level) => KEY_BY_LEVEL.get(level) || null;
export const levelOf = (key) => LEVEL_BY_KEY.get(String(key).toLowerCase()) || null;

const byCode = new Map();
const childCodes = new Map();
const atEachLevel = new Map(LEVELS.map((entry) => [entry.level, []]));
let centroidIndex = [];

const lower = (value) => String(value || '').toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, 'en');

export const reload = async () => {
  byCode.clear();
  childCodes.clear();
  for (const list of atEachLevel.values()) list.length = 0;
  centroidIndex = [];
  const rows = await all('SELECT code, level, name, name_rw AS "nameRw", parent_code AS parent, lat, lng FROM locations');
  for (const row of rows) {
    const node = { ...row, parent: row.parent || null, lat: row.lat ?? null, lng: row.lng ?? null };
    byCode.set(node.code, node);
    atEachLevel.get(node.level).push(node);
    const siblings = childCodes.get(node.parent) || [];
    siblings.push(node);
    childCodes.set(node.parent, siblings);
    if (node.lat !== null && node.lng !== null) centroidIndex.push(node);
  }
  for (const list of atEachLevel.values()) list.sort(byName);
};

/* Parentage is read off the code: a sector code is its district code, a hyphen, its own slug.
   scripts/build-locations.mjs checks that rule against the register's own parent links, and no code
   in the country has two possible parents, so the longest known prefix is always the right one. */
const parentOf = (code, known) => {
  let cut = code.lastIndexOf('-');
  while (cut > 0) {
    const candidate = code.slice(0, cut);
    if (known.has(candidate)) return candidate;
    cut = candidate.lastIndexOf('-');
  }
  return null;
};

export const seedFromFile = async (file = SEED_FILE) => {
  if (!fs.existsSync(file)) throw new Error(`divisions file missing: ${file}`);
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  /* Provinces carry a Kinyarwanda name; provinces, districts and sectors carry a centroid.
     Deeper levels are [code, name] only, so unpack per level instead of guessing from length. */
  const readRow = {
    1: (row) => ({ name: row[1], nameRw: row[2] || row[1], lat: row[3], lng: row[4] }),
    2: (row) => ({ name: row[1], nameRw: row[1], lat: row[2], lng: row[3] }),
    3: (row) => ({ name: row[1], nameRw: row[1], lat: row[2], lng: row[3] }),
    4: (row) => ({ name: row[1], nameRw: row[1] }),
    5: (row) => ({ name: row[1], nameRw: row[1] }),
  };
  const LEVEL_ROWS = [[1, 'provinces'], [2, 'districts'], [3, 'sectors'], [4, 'cells'], [5, 'villages']];
  const inserted = {};
  const levelCodes = new Map(LEVEL_ROWS.map(([level]) => [level, new Set()]));

  await transaction(async () => {
    for (const [level, key] of LEVEL_ROWS) {
      /* Only codes from the level directly above can be a parent. */
      const parentLevel = levelCodes.get(level - 1) || new Set();
      const rows = [];
      for (const row of seed[key] || []) {
        const [code] = row;
        const { name, nameRw, lat, lng } = readRow[level](row);
        const parent = level === 1 ? null : parentOf(code, parentLevel);
        if (level > 1 && !parent) throw new Error(`${code}: no level-${level - 1} parent found in the seed file`);
        rows.push([code, level, name, nameRw, parent, lat ?? null, lng ?? null]);
        levelCodes.get(level).add(code);
        inserted[levelKey(level)] = (inserted[levelKey(level)] || 0) + 1;
      }
      /* One round trip per 500 divisions instead of one per row: Neon is a network hop away. */
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await run(
          `INSERT INTO locations (code, level, name, name_rw, parent_code, lat, lng)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
           ON CONFLICT (code) DO UPDATE SET level = excluded.level, name = excluded.name,
             name_rw = excluded.name_rw, parent_code = excluded.parent_code,
             lat = excluded.lat, lng = excluded.lng`,
          ...chunk.flat(),
        );
      }
    }
  });
  await reload();
  return inserted;
};

/* A fresh database gets the divisions without anyone remembering a second command. */
export const ensureSeeded = async () => {
  await reload();
  if (byCode.size) return { seeded: false, count: byCode.size };
  if (!fs.existsSync(SEED_FILE)) {
    console.warn('[seremoto] data/locations.json is missing — the division dropdowns will stay empty');
    return { seeded: false, count: 0 };
  }
  const inserted = await seedFromFile();
  const total = Object.values(inserted).reduce((sum, n) => sum + n, 0);
  console.log(`[seremoto] loaded Rwanda's divisions: ${Object.entries(inserted).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return { seeded: true, count: total, inserted };
};

export const ready = () => byCode.size > 0;
export const count = () => byCode.size;
export const countsByLevel = () => {
  const out = {};
  for (const entry of LEVELS) out[entry.key] = atEachLevel.get(entry.level).length;
  return out;
};

export const node = (code) => byCode.get(String(code || '')) || null;

/* Province first, the node itself last. [] when the code is not a division. */
export const chain = (code) => {
  let cursor = node(code);
  if (!cursor) return [];
  const walk = [];
  while (cursor && walk.length < 8) {
    walk.unshift(cursor);
    cursor = cursor.parent ? byCode.get(cursor.parent) : null;
  }
  return walk;
};

export const isWithin = (code, ancestorCode) => {
  if (!code || !ancestorCode) return false;
  if (code === ancestorCode) return true;
  return chain(code).some((entry) => entry.code === ancestorCode);
};

/* "Gashora, Bugesera, Eastern Province" — short enough for a dropdown, complete for a trip card. */
export const label = (code, lang = 'en') => chain(code)
  .map((entry) => (lang === 'rw' ? entry.nameRw : entry.name))
  .join(', ');

/* The one object a client needs to draw a division: the leaf it sits on plus the whole chain above
   it, both in the requested language. Unknown or empty codes answer null so callers can skip the row. */
export const divisionBrief = (code, lang = 'en') => {
  const walk = chain(code);
  if (!walk.length) return null;
  const leaf = walk[walk.length - 1];
  return {
    code: leaf.code,
    level: leaf.level,
    levelKey: levelKey(leaf.level),
    name: lang === 'rw' ? leaf.nameRw : leaf.name,
    label: label(leaf.code, lang),
    path: walk.map((entry) => ({
      code: entry.code,
      level: entry.level,
      levelKey: levelKey(entry.level),
      name: lang === 'rw' ? entry.nameRw : entry.name,
    })),
  };
};

export const hasChildren = (code) => (childCodes.get(code) || []).length > 0;
export const children = (code) => childCodes.get(code) || [];
export const atLevel = (level) => atEachLevel.get(level) || [];

/* Prefix hits beat contains hits, and a shallow division beats a deep one, so "ki" still puts
   Kigali City above a village called Kinyana. */
export const search = (rawQuery, { level = null, limit = 25 } = {}) => {
  const needle = lower(rawQuery).trim();
  if (!needle) return [];
  const wanted = level ? levelOf(level) : null;
  const prefix = [];
  const contains = [];
  for (const entry of byCode.values()) {
    if (wanted && entry.level !== wanted) continue;
    const name = lower(entry.name);
    const nameRw = lower(entry.nameRw);
    if (name.startsWith(needle) || nameRw.startsWith(needle)) prefix.push(entry);
    else if (name.includes(needle) || nameRw.includes(needle)) contains.push(entry);
  }
  const rank = (a, b) => a.level - b.level || byName(a, b);
  return [...prefix.sort(rank), ...contains.sort(rank)].slice(0, limit);
};

/* The nearest centroid at a given level — an approximation on purpose. The seed carries a point per
   province, district and sector, never a boundary polygon, so callers must say "around", not "in". */
export const nearest = (lat, lng, level = 3) => {
  const pool = centroidIndex.filter((entry) => entry.level === level);
  if (!pool.length) return null;
  let best = null;
  let bestKm = Infinity;
  for (const entry of pool) {
    const km = haversineKm({ lat, lng }, { lat: entry.lat, lng: entry.lng });
    if (km < bestKm) { bestKm = km; best = entry; }
  }
  return best ? { node: best, distanceKm: Math.round(bestKm * 10) / 10 } : null;
};

/* What a profile row stores: the leaf plus the three shallow ancestors, so a rider can be filtered
   by district in SQL without walking the tree per request. */
export const areaOf = (code) => {
  const walk = chain(code);
  if (!walk.length) return null;
  const at = (level) => walk.find((entry) => entry.level === level)?.code || null;
  const leaf = walk[walk.length - 1];
  return {
    code: leaf.code,
    level: leaf.level,
    province: at(1),
    district: at(2),
    sector: at(3),
    cell: at(4),
    village: at(5),
  };
};

/* What a point is, as far as the centroid index can honestly say.
   Kigali City's sectors are not drawn in OpenStreetMap, so a fix there is answered as the district it sits
   in rather than as some other Remera 30 km away: a sector only wins when it is both close and inside the
   district that is itself nearest. Beyond that the answer drops to district, then to province. */
const SECTOR_REACH_KM = 15;
const DISTRICT_REACH_KM = 50;

const deepEnough = (sector, district) => sector
  && sector.distanceKm <= SECTOR_REACH_KM
  && district
  && chain(sector.node.code).some((entry) => entry.code === district.node.code);

export const divisionAt = (lat, lng) => {
  const sector = nearest(lat, lng, 3);
  const district = nearest(lat, lng, 2);
  const province = nearest(lat, lng, 1);
  const found = (deepEnough(sector, district) && sector)
    || (district && district.distanceKm <= DISTRICT_REACH_KM ? district : null)
    || province;
  if (!found) return null;
  const entry = found.node;
  return {
    code: entry.code,
    level: entry.level,
    levelKey: levelKey(entry.level),
    name: entry.name,
    nameRw: entry.nameRw,
    label: label(entry.code, 'en'),
    labelRw: label(entry.code, 'rw'),
    chain: chain(entry.code).map((step) => ({
      code: step.code, level: step.level, key: levelKey(step.level), name: step.name, nameRw: step.nameRw,
    })),
    distanceKm: found.distanceKm,
    approximate: true,
  };
};

export const publicNode = (entry, lang = 'en', withLabel = true) => ({
  code: entry.code,
  level: entry.level,
  levelKey: levelKey(entry.level),
  name: lang === 'rw' ? entry.nameRw : entry.name,
  ...(withLabel ? { label: label(entry.code, lang) } : {}),
  hasChildren: hasChildren(entry.code),
});

/* Reported by /api/health so an operator can see the tree loaded without opening a dropdown. */
export const divisionHealth = () => ({
  loaded: byCode.size,
  levels: countsByLevel(),
  centroids: centroidIndex.length,
  seededFrom: fs.existsSync(SEED_FILE) ? path.basename(SEED_FILE) : null,
});

