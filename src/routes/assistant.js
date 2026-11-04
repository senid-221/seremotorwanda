/* SERE Moto — the booking interview, worded by a real model and answered by real data.

   The interview has always asked where the passenger is, one question per screen. This route decides
   how that question is *said* and what the app *answers* when the passenger types something, while
   every fact it leans on is computed here first: the places on offer come from the division register,
   the rider count from the same live-nearby search the list on screen uses, the price from the RURA
   table. The model is shown those facts and is only allowed to phrase them, so a confident invention
   has nothing to attach to.

   Nothing is simulated. Without AI_API_KEY the route answers 503 ai_not_configured and the page keeps
   asking its own scripted questions; a provider that refuses answers 502 ai_unavailable with its own
   reason, which the page also treats as "keep the scripted question". Either way the passenger is
   never shown a question that came from nobody. */
import { Router } from 'express';
import { config, aiConfigured } from '../config.js';
import { all } from '../db.js';
import { pointDistanceKm } from '../osm.js';
import { fareFor, FARE_RULE } from '../fares.js';
import { atLevel, children, divisionBrief, node } from '../locations.js';
import { ApiError, language, numberInRange, parseNear, text } from '../validate.js';
import { phraseJson } from '../ai.js';

const router = Router();

const STAGES = ['province', 'district', 'sector', 'cell', 'village', 'ready'];
const LEVEL_BY_STAGE = { province: 1, district: 2, sector: 3, cell: 4, village: 5 };
const NEAR_KM = 2;
const MAX_PLACES = 12;
const ASK_LIMIT = 90;
const NOTE_LIMIT = 200;

const SPEECH = {
  rw: 'Kinyarwanda',
  en: 'English',
};

/* The places a passenger could tap next — straight out of the register, never out of the model. */
function placeNames(parentCode, stage, lang) {
  const codes = parentCode ? children(parentCode) : [];
  const entries = codes.length
    ? codes.map((code) => node(code)).filter(Boolean)
    : atLevel(LEVEL_BY_STAGE[stage] || 0);
  return entries
    .slice(0, MAX_PLACES)
    .map((entry) => (lang === 'rw' ? entry.nameRw : entry.name));
}

/* Who can actually take this trip right now, measured the same way the list on screen measures it. */
async function nearbyRiders(origin, lang) {
  if (!origin) return null;
  const rows = await all(
    `SELECT name, lat, lng FROM drivers
     WHERE status = 'approved' AND is_online = 1 AND on_trip = 0 AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  const close = rows
    .map((row) => ({ name: row.name, distanceKm: pointDistanceKm(origin, { lat: row.lat, lng: row.lng }) }))
    .filter((row) => row.distanceKm <= NEAR_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    count: close.length,
    max_km: NEAR_KM,
    nearest: close.length ? { name: close[0].name, distanceKm: close[0].distanceKm } : null,
    lang,
  };
}

function systemPrompt({ lang, stage, picked, places, riders, fare }) {
  const speech = SPEECH[lang] || 'English';
  const asked = {
    province: 'the province (Intara) the passenger is standing in',
    district: 'the district (Akarere) inside the province they just named',
    sector: 'the sector (Umurenge) inside the district they just named',
    cell: 'the cell (Akagari) inside the sector they just named',
    village: 'the village (Umudugudu) inside the cell they just named, and say they may also continue without it',
    ready: 'where the passenger wants to go, now that their area is known',
  }[stage];
  const facts = [
    `SERVICE: SEREMOTO, booking motorcycles and cars with drivers in Rwanda.`,
    `STAGE: ask for ${asked}.`,
    `PLACES ON OFFER (the only places that exist at this step): ${places.length ? places.join(', ') : 'none listed'}`,
    `PASSENGER'S AREA SO FAR: ${picked.length ? picked.map((row) => row.label).join(' > ') : 'nothing answered yet'}`,
    riders
      ? `RIDERS WITHIN ${riders.max_km} KM RIGHT NOW: ${riders.count}${riders.nearest ? `, closest is ${riders.nearest.name} at ${riders.nearest.distanceKm} km` : ''}`
      : 'RIDERS NEARBY: unknown, the passenger has not shared a GPS position',
    fare
      ? `PRICE: ${FARE_RULE}; a ${fare.distanceKm} km motorcycle trip is ${fare.fareRwf} RWF`
      : 'PRICE: the RURA table applies, but no distance is measured yet',
  ].join('\n');

  return [
    'You are the booking assistant inside SERE Moto, a motorcycle and delivery booking app in Rwanda.',
    `Speak only ${speech}. The passenger is on a cheap phone at the roadside: one short line, no greeting beyond what is asked below, no markdown, no emoji.`,
    'You phrase questions and answers. You never invent a place, a price, a rider, a distance or a waiting time: the FACTS block is the whole of what you know, and a fact you were not given is a fact you do not have.',
    'Prices are set by the regulator (RURA) and quoted in Rwandan francs. If asked about money, repeat the PRICE line or say the fare is calculated once the destination is known.',
    'On the very first question of the interview (STAGE province), open the line by introducing yourself as the SEREMOTO assistant made by IRAGUHA Vincent, then ask the question.',
    'Answer with a JSON object: {"ask": "<the question to show as the heading>", "note": "<one short line answering what the passenger asked, or an empty string>"}.',
    `Keep "ask" under ${ASK_LIMIT} characters and "note" under ${NOTE_LIMIT}. Never put the choices in "ask": the app shows them as tappable rows already.`,
    '',
    'FACTS:',
    facts,
  ].join('\n');
}

/* A reply is only usable if it is wording. Anything longer than the slot, or carrying a second
   document, is dropped so the page keeps the question it already knows how to ask. */
function usable(value, limit) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!line || line.length > limit) return '';
  if (/[{}<>`]|https?:\/\//.test(line)) return '';
  return line;
}

router.post('/api/assistant', async (req, res) => {
  const lang = language(req.body.locale);
  const stage = String(req.body.stage || 'province').toLowerCase();
  if (!STAGES.includes(stage)) throw new ApiError(422, 'invalid_stage', `stage must be one of: ${STAGES.join(', ')}`);
  const question = req.body.question ? text(req.body.question, 'question', { min: 2, max: 300 }) : '';
  if (!aiConfigured()) {
    throw new ApiError(503, 'ai_not_configured', 'SERE Moto has no language model configured, so the booking page asks its own questions.');
  }

  const rawPicked = Array.isArray(req.body.picked) ? req.body.picked.slice(0, 5) : [];
  const picked = rawPicked
    .map((row) => divisionBrief(row?.code, lang))
    .filter(Boolean)
    .map((row) => ({ code: row.code, levelKey: row.levelKey, label: row.label }));
  const parent = picked.length ? picked[picked.length - 1].code : null;
  const places = placeNames(parent, stage, lang);
  const origin = req.body.near ? parseNear(req.body.near) : null;
  const riders = await nearbyRiders(origin, lang);

  let fare = null;
  if (req.body.destination && req.body.distance_km !== undefined) {
    const destination = text(req.body.destination, 'destination', { min: 2, max: 120 });
    const km = numberInRange(req.body.distance_km, 'distance_km', 0.1, 200);
    fare = { destination, distanceKm: Math.round(km * 10) / 10, fareRwf: fareFor(km, 'moto', null).fareRwf };
  }

  const reply = await phraseJson({
    system: systemPrompt({ lang, stage, picked, places, riders, fare }),
    user: question ? `The passenger typed: "${question}"` : 'Ask the next question.',
  });

  const ask = usable(reply.ask, ASK_LIMIT);
  const note = usable(reply.note, NOTE_LIMIT);
  if (!ask && !note) {
    throw new ApiError(502, 'ai_unavailable', 'The language model sent no usable wording for this step.');
  }
  res.json({
    ask: ask || null,
    note: note || null,
    stage,
    locale: lang,
    model: config.ai.model,
    facts: {
      places,
      riders,
      fare: fare ? { distanceKm: fare.distanceKm, fareRwf: fare.fareRwf } : null,
    },
  });
});

export const assistantHealth = () => ({
  configured: aiConfigured(),
  model: aiConfigured() ? config.ai.model : null,
  stages: STAGES,
});

export default router;
