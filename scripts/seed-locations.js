/* Fill one database with the Rwandan division register from data/locations.json.
   Run it once per environment, from a checkout: a serverless function bundle does not carry the 1 MB
   register, and after this the app only ever reads the rows back out of Postgres. Re-running is safe —
   every row is written with ON CONFLICT DO UPDATE. */
import 'dotenv/config';
import { closeDb } from '../src/db.js';
import { seedFromFile, count } from '../src/locations.js';

const inserted = await seedFromFile();
console.log(`[seed-locations] ${Object.entries(inserted).map(([k, n]) => `${n} ${k}`).join(', ')} — ${count()} divisions in the register.`);
await closeDb();
