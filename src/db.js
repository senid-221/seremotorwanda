/* SERE Moto — Neon Postgres data layer.
   Every query in this project was written against SQLite's `?` placeholders and synchronous
   prepare/run calls. This module keeps those call sites readable: `?` is translated to `$n`,
   timestamps stay the same TEXT format (see the datetime() shim in schema.js), and the exported
   helpers are async so routes can await them. */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';
import { SCHEMA_SQL } from './schema.js';

const { Pool, types } = pg;

/* pg returns int8/numeric as strings to avoid precision loss. Every COUNT/SUM here is a row count
   or Rwandan francs, so numbers are what the JSON layers and comparisons expect. */
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

if (!config.databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Point it at your Neon connection string, e.g. '
    + 'postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/seremoto?sslmode=require',
  );
}

const sslOption = () => {
  if (config.databaseSsl === 'disable') return false;
  if (['require', 'true', '1'].includes(config.databaseSsl)) return { rejectUnauthorized: false };
  return undefined;
};

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslOption(),
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'sere-moto',
});

pool.on('error', (error) => {
  console.error('[seremoto] idle database connection failed:', error.message);
});

/* `?` → `$n`, but only outside quoted strings and comments: LIKE patterns and JSON payloads may
   legitimately contain a question mark. */
export const translate = (sql) => {
  let output = '';
  let index = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      output += char;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            output += quote + quote;
            i += 2;
            continue;
          }
          output += quote;
          i += 1;
          break;
        }
        output += sql[i];
        i += 1;
      }
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      output += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '?') {
      index += 1;
      output += `$${index}`;
      i += 1;
      continue;
    }
    output += char;
    i += 1;
  }
  return output;
};

/* A transaction callback can call the same all/get/run helpers as the rest of the app; the active
   client travels with the async context instead of being threaded through every function. */
const transactionClient = new AsyncLocalStorage();

const query = (sql, params) => {
  const client = transactionClient.getStore();
  return (client || pool).query(translate(sql), params);
};

export const all = async (sql, ...params) => (await query(sql, params)).rows;

export const get = async (sql, ...params) => (await query(sql, params)).rows[0];

/* run() keeps the shape callers already rely on: rowCount as `changes`, plus the RETURNING row so
   `lastInsertRowid` still works on inserts that ask for their id. */
export const run = async (sql, ...params) => {
  const result = await query(sql, params);
  return {
    changes: result.rowCount ?? 0,
    rows: result.rows,
    lastInsertRowid: result.rows[0]?.id,
  };
};

export const transaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionClient.run(client, () => fn());
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/* Columns added after a database was first created. Postgres supports IF NOT EXISTS here, so an
   older database is upgraded in place instead of being rebuilt. */
const ensureColumns = async (table, additions) => {
  for (const [name, ddl] of additions) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${ddl}`);
  }
};

const bootstrap = async () => {
  await pool.query(SCHEMA_SQL);

  await ensureColumns('drivers', [
    /* email and password_hash are NOT listed here: they are added inside the schema's own upgrade
       block, because the UNIQUE constraint over `email` is applied in that same block and Postgres
       refuses a constraint on a column that does not exist yet. Anything added after this call is
       one statement too late for it. */
    ['lat', 'DOUBLE PRECISION'],
    ['lng', 'DOUBLE PRECISION'],
    ['loc_at', 'TEXT'],
    ['on_trip', 'INTEGER NOT NULL DEFAULT 0'],
    ['tin_status', "TEXT NOT NULL DEFAULT 'unchecked'"],
    ['id_status', "TEXT NOT NULL DEFAULT 'unchecked'"],
    ['phone_status', "TEXT NOT NULL DEFAULT 'unchecked'"],
    ['kyc_at', 'TEXT'],
    ['loc_code', 'TEXT'],
    ['loc_level', 'INTEGER'],
    ['province_code', 'TEXT'],
    ['district_code', 'TEXT'],
    ['sector_code', 'TEXT'],
    ['live_code', 'TEXT'],
  ]);

  await ensureColumns('ride_requests', [
    ['distance_source', 'TEXT'],
    ['fare_basis', 'TEXT'],
    ['passenger_id', 'INTEGER REFERENCES passengers (id) ON DELETE SET NULL'],
  ]);

  /* A trip recorded as a guest still belongs to the passenger who verifies that phone number. */
  const claimed = await run(
    `UPDATE ride_requests
        SET passenger_id = (SELECT p.id FROM passengers p WHERE p.phone = ride_requests.client_phone)
      WHERE passenger_id IS NULL
        AND EXISTS (SELECT 1 FROM passengers p WHERE p.phone = ride_requests.client_phone)`,
  );
  if (claimed.changes) {
    console.log(`[seremoto] linked ${claimed.changes} earlier bookings to passenger accounts`);
  }
};

await bootstrap();

export const dbHealth = async () => {
  const { tables } = await get(
    `SELECT COUNT(*) AS tables FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  return { database: databaseName(), tables };
};

export const databaseName = () => {
  try {
    const parsed = new URL(config.databaseUrl);
    return parsed.pathname.replace(/^\//, '') || 'postgres';
  } catch {
    return 'postgres';
  }
};

export const closeDb = () => pool.end();
