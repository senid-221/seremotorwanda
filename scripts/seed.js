import 'dotenv/config';
import { config } from '../src/config.js';
import { closeDb, get, run } from '../src/db.js';

if (!config.adminPhone) {
  console.log('[seed] ADMIN_PHONE is not set in .env — nothing to do.');
  await closeDb();
  process.exit(0);
}

const existing = await get('SELECT id, name, is_admin FROM drivers WHERE phone = ?', config.adminPhone);

if (existing) {
  if (existing.is_admin) {
    console.log(`[seed] admin ${config.adminPhone} already exists.`);
  } else {
    await run("UPDATE drivers SET is_admin = 1, status = 'approved', reviewed_at = datetime('now') WHERE id = ?", existing.id);
    console.log(`[seed] promoted account ${config.adminPhone} to admin.`);
  }
} else {
  await run(
    `INSERT INTO drivers (phone, name, plate, vehicle_type, zone, status, is_admin, reviewed_at)
     VALUES (?, ?, ?, 'moto', 'Kigali', 'approved', 1, datetime('now'))`,
    config.adminPhone, 'SERE Moto Admin', 'ADMIN 001',
  );
  console.log(`[seed] created admin account ${config.adminPhone}. Sign in to change the name and plate.`);
}

await closeDb();
