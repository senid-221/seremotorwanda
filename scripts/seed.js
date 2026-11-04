import 'dotenv/config';
import { config } from '../src/config.js';
import { closeDb, get, run } from '../src/db.js';

if (!config.adminEmail) {
  console.log('[seed] ADMIN_EMAIL is not set in .env — nothing to do.');
  await closeDb();
  process.exit(0);
}

const existing = await get('SELECT id, name, is_admin FROM drivers WHERE email = ?', config.adminEmail);

if (existing) {
  if (existing.is_admin) {
    console.log(`[seed] admin ${config.adminEmail} already exists.`);
  } else {
    await run('UPDATE drivers SET is_admin = 1 WHERE id = ?', existing.id);
    console.log(`[seed] promoted the account ${config.adminEmail} to admin.`);
  }
} else {
  /* The console is not seeded with a password nobody chose: the address in ADMIN_EMAIL becomes an
     admin the moment it signs up at /signup, so the operator creates their own account here. */
  console.log(`[seed] no rider holds ${config.adminEmail} yet. Sign up at /signup with that address —`
    + ' the first account to claim ADMIN_EMAIL is made an admin by the server itself.');
}

await closeDb();
