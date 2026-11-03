/* SERE Moto — Rwanda's administrative divisions, read-only.
   The dropdowns ask for the children of whatever the rider just picked, so one endpoint answers for
   all five levels. Nothing here writes: a division is law, not user input. */
import { Router } from 'express';
import {
  LEVELS, areaOf, atLevel, chain, children, count, countsByLevel, divisionAt,
  hasChildren, label, levelKey, levelOf, node, publicNode, ready, search,
} from '../locations.js';
import { ApiError, integerInRange, language, latitude, longitude, queryOrBody, divisionCode } from '../validate.js';

const router = Router();

const requireTree = () => {
  if (!ready()) {
    throw new ApiError(503, 'divisions_unavailable', 'The division database is not loaded on this server yet.');
  }
};

const lang = (req) => language(req.query.lang);
const limit = (raw) => integerInRange(raw ?? 300, 'limit', 1, 500);

/* A division as the client needs it: display name, the level it sits at, whether a dropdown should
   expect another row below it, and the path it hangs off so a result can be shown in one line. */
const shapeNode = (entry, reqLang, withLabel = true) => ({
  ...publicNode(entry, reqLang, false),
  parent: entry.parent,
  ...(withLabel ? { label: label(entry.code, reqLang) } : {}),
});

router.get('/api/locations/levels', (_req, res) => {
  requireTree();
  const counts = countsByLevel();
  res.json({
    levels: LEVELS.map((entry) => ({ ...entry, count: counts[entry.key] })),
    total: count(),
  });
});

/* ?parent=<code> → its children. ?level=<key> → everything at that level. Both take ?q= to narrow. */
router.get('/api/locations', (req, res) => {
  requireTree();
  const { parent, level, q } = req.query;
  const max = limit(req.query.limit);
  const needle = String(q || '').trim().toLowerCase();
  const reqLang = lang(req);
  let source;
  let parentNode = null;
  let answerLevel = null;
  if (parent) {
    parentNode = node(divisionCode(parent, 'parent'));
    if (!parentNode) throw new ApiError(404, 'division_not_found', 'No Rwandan division carries that code.');
    source = children(parentNode.code);
    answerLevel = levelKey(parentNode.level + 1);
  } else if (level) {
    const wanted = levelOf(level);
    if (!wanted) {
      throw new ApiError(422, 'invalid_level', `level must be one of: ${LEVELS.map((entry) => entry.key).join(', ')}`);
    }
    source = atLevel(wanted);
    answerLevel = levelKey(wanted);
  } else {
    throw new ApiError(422, 'invalid_query', 'Send either parent=<division code> or level=<province|district|sector|cell|village>.');
  }
  const matched = needle
    ? source.filter((entry) => `${entry.name} ${entry.nameRw}`.toLowerCase().includes(needle))
    : source;
  res.json({
    parent: parentNode ? parentNode.code : null,
    level: answerLevel,
    total: matched.length,
    truncated: matched.length > max,
    items: matched.slice(0, max).map((entry) => shapeNode(entry, reqLang, false)),
  });
});

/* One box for "type where you are going": matches across all five levels at once. */
router.get('/api/locations/search', (req, res) => {
  requireTree();
  const needle = queryOrBody(req, 'q');
  if (!needle || String(needle).trim().length < 2) {
    throw new ApiError(422, 'invalid_query', 'Search needs at least two letters.');
  }
  const wanted = req.query.level ? levelOf(req.query.level) : null;
  if (req.query.level && !wanted) throw new ApiError(422, 'invalid_level', `level must be one of: ${LEVELS.map((entry) => entry.key).join(', ')}`);
  const reqLang = lang(req);
  res.json({
    query: String(needle).trim(),
    items: search(needle, { level: req.query.level, limit: limit(req.query.limit) })
      .map((entry) => shapeNode(entry, reqLang)),
  });
});

/* The full path of one division — what a trip card or a rider profile shows. */
router.get('/api/locations/chain', (req, res) => {
  requireTree();
  const code = divisionCode(queryOrBody(req, 'code'), 'code');
  const found = node(code);
  if (!found) throw new ApiError(404, 'division_not_found', 'No Rwandan division carries that code.');
  const reqLang = lang(req);
  res.json({
    code,
    level: found.level,
    levelKey: levelKey(found.level),
    name: reqLang === 'rw' ? found.nameRw : found.name,
    label: label(code, reqLang),
    area: areaOf(code),
    hasChildren: hasChildren(code),
    chain: chain(code).map((entry) => ({
      code: entry.code,
      level: entry.level,
      levelKey: levelKey(entry.level),
      name: reqLang === 'rw' ? entry.nameRw : entry.name,
    })),
  });
});

/* Deepest honest answer for a GPS fix: a sector when the point is plausibly inside one, otherwise the
   district, otherwise the province. Not a boundary — the response says so and gives the distance to the centre. */
router.get('/api/locations/point', (req, res) => {
  requireTree();
  const lat = latitude(req.query.lat);
  const lng = longitude(req.query.lng);
  const reqLang = lang(req);
  const division = divisionAt(lat, lng);
  if (!division) {
    throw new ApiError(503, 'divisions_unmapped', 'This build has no division coordinates to place a point with.');
  }
  res.json({
    lat, lng,
    level: division.level,
    levelKey: division.levelKey,
    name: reqLang === 'rw' ? division.nameRw : division.name,
    label: reqLang === 'rw' ? division.labelRw : division.label,
    code: division.code,
    chain: division.chain.map((entry) => ({ ...entry, name: reqLang === 'rw' ? entry.nameRw : entry.name })),
    distance_to_centre_km: division.distanceKm,
    approximate: true,
  });
});

export default router;
