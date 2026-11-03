/* Test suites need a real Postgres server because the API talks to nothing else. When TEST_DATABASE_URL
   is set the suites use that database directly; otherwise this boots an in-process PGlite database behind
   the Postgres wire protocol, so `npm test` needs no Neon credentials and leaves no rows behind. */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = path.join(import.meta.dirname, '..');

export async function startPostgres({ maxConnections = 8 } = {}) {
  if (process.env.TEST_DATABASE_URL) {
    return {
      url: process.env.TEST_DATABASE_URL,
      label: 'TEST_DATABASE_URL',
      external: true,
      async stop() {},
    };
  }

  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections });
  await server.start();
  const address = server.getServerConn();
  const port = Number(String(address).split(':').pop());

  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    label: address,
    external: false,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

export const scratchEnv = (pg, extra = {}) => ({
  ...process.env,
  DATABASE_URL: pg.url,
  DATABASE_SSL: 'disable',
  DATABASE_POOL_MAX: '4',
  ...extra,
});

/* Seeding must be asynchronous: an in-process PGlite server serves the seed child over TCP, and
   execFileSync would block this process's event loop for exactly as long as the child waits. */
export async function runSeed(env) {
  const seed = spawn(process.execPath, ['scripts/seed.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  seed.stdout.on('data', (chunk) => { output += chunk; });
  seed.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    seed.on('error', reject);
    seed.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`scripts/seed.js exited with ${code}:\n${output}`);
  return output;
}
