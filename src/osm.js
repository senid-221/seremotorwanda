import { config } from './config.js';
import { get, run } from './db.js';

const EARTH_RADIUS_KM = 6371;
/* Straight roads are rare in Kigali's hills, so an unmeasured trip is scaled to a plausible road distance. */
const ROAD_FACTOR = 1.35;

export function haversineKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { 'User-Agent': config.osm.userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(config.osm.timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const cacheable = (name) => String(name).trim().toLowerCase().slice(0, 80);

/* Kigali is where SERE Moto sells first, and a bare "Remera" otherwise matches a town in Musanze. */
const KIGALI_CENTRE = { lat: -1.9539, lng: 30.0586 };
const PLACE_MAX_KM = 25;

const search = async (query, viewbox) => {
  const box = viewbox
    ? `&viewbox=${viewbox.join(',')}&bounded=0`
    : '';
  const url = `${config.osm.geocodingUrl}/search?format=jsonv2&limit=5&countrycodes=rw&q=${encodeURIComponent(query)}${box}`;
  let found;
  try {
    found = await fetchJson(url);
  } catch (error) {
    console.warn(`[seremoto] geocoding "${query}" failed: ${error.message}`);
    return [];
  }
  if (!Array.isArray(found)) return [];
  return found
    .map((hit) => ({ lat: Number(hit.lat), lng: Number(hit.lon), label: String(hit.display_name || query).slice(0, 300) }))
    .filter((hit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lng));
};

const nearest = (list, point) => list
  .map((hit) => ({ ...hit, distanceKm: haversineKm(point, hit) }))
  .sort((a, b) => a.distanceKm - b.distanceKm)[0] || null;

/* Zone names are stable, so a place is geocoded once per search area and reused for every later trip. */
export async function geocode(name, near) {
  const key = cacheable(name);
  if (!key) return null;
  const anchor = near || KIGALI_CENTRE;
  const cacheKey = near ? `${key}@${anchor.lat.toFixed(2)},${anchor.lng.toFixed(2)}` : key;
  const cached = await get('SELECT lat, lng, label FROM places WHERE key = ?', cacheKey);
  if (cached) return { lat: cached.lat, lng: cached.lng, label: cached.label, source: 'cache' };

  const viewbox = [anchor.lng - 0.5, anchor.lat + 0.5, anchor.lng + 0.5, anchor.lat - 0.5];
  let hit = nearest(await search(`${name}, Rwanda`, viewbox), anchor);
  if (!hit || hit.distanceKm > PLACE_MAX_KM) {
    /* The name is known locally but not near us, so ask for it inside Kigali before giving up. */
    const fallback = nearest(await search(`${name}, Kigali`), anchor);
    if (fallback && (!hit || fallback.distanceKm < hit.distanceKm)) hit = fallback;
  }
  if (!hit) return null;
  await run(
    `INSERT INTO places (key, lat, lng, label, created_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
       label = excluded.label, created_at = excluded.created_at`,
    cacheKey, hit.lat, hit.lng, hit.label,
  );
  return { lat: hit.lat, lng: hit.lng, label: hit.label, source: 'nominatim', fromQueryKm: Math.round(hit.distanceKm * 10) / 10 };
}

const routeKey = (a, b) => [a, b].map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).sort().join(';');

export async function roadKm(from, to) {
  const key = routeKey(from, to);
  const cached = await get('SELECT distance_km FROM routes WHERE key = ?', key);
  if (cached) return { distanceKm: cached.distance_km, source: 'cache' };
  const url = `${config.osm.routingUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false&steps=false`;
  try {
    const found = await fetchJson(url);
    const leg = found.routes && found.routes[0];
    if (!leg || !Number.isFinite(leg.distance)) return null;
    const distanceKm = Math.round((leg.distance / 1000) * 100) / 100;
    await run(
      `INSERT INTO routes (key, distance_km, created_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET distance_km = excluded.distance_km, created_at = excluded.created_at`,
      key, distanceKm,
    );
    return { distanceKm, source: 'osrm' };
  } catch (error) {
    console.warn(`[seremoto] routing failed: ${error.message}`);
    return null;
  }
}

/* Distance between two place names, measured on real roads when OSM can answer, estimated when it cannot. */
export async function journeyDistance(fromName, toName, near) {
  /* Sequential: Nominatim's public instance asks for no more than one request per second. */
  const from = await geocode(fromName, near);
  if (!from) return null;
  const to = await geocode(toName, near);
  if (!to) return null;
  const measured = await roadKm(from, to);
  if (measured) return { ...measured, from: from.label, to: to.label };
  return {
    distanceKm: Math.round(haversineKm(from, to) * ROAD_FACTOR * 100) / 100,
    source: 'estimated',
    from: from.label,
    to: to.label,
  };
}

/* Two raw points (the client's own GPS position to a rider) never need the network. */
export const pointDistanceKm = (from, to) => Math.round(haversineKm(from, to) * 100) / 100;

export const attribution = 'Distances and zones: OpenStreetMap contributors (OSRM / Nominatim).';
