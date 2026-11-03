import express from 'express';
import path from 'node:path';
import { config, kycHealth, missingConfig } from './config.js';
import { databaseName, dbHealth, get } from './db.js';
import { ApiError } from './validate.js';
import { providerHealth } from './payments/index.js';
import authRouter from './routes/auth.js';
import driversRouter from './routes/drivers.js';
import adminRouter from './routes/admin.js';
import passengerRouter from './routes/passenger.js';
import requestsRouter from './routes/requests.js';
import fareRouter from './routes/fare.js';
import paymentsRouter from './routes/payments.js';
import webhooksRouter from './routes/webhooks.js';
import kycRouter from './routes/kyc.js';
import locationsRouter from './routes/locations.js';
import { divisionHealth, ensureSeeded } from './locations.js';
import { storageHealth } from './storage.js';
import { LANDING_HTML } from './landing.js';

const app = express();
/* A host with a disk seeds the division register into an empty database itself; a serverless bundle has no
   data/locations.json to read, so run `npm run seed:locations` once against it instead. */
await ensureSeeded();
app.disable('x-powered-by');
app.use(express.json({
  limit: '64kb',
  verify: (req, _res, buffer) => {
    if (buffer && buffer.length) req.rawBody = buffer.toString('utf8');
  },
}));

app.get('/api/health', async (_req, res) => {
  const { tables } = await dbHealth();
  res.json({
    ok: true,
    database: databaseName(),
    tables,
    drivers: (await get('SELECT COUNT(*) AS count FROM drivers')).count,
    requests: (await get('SELECT COUNT(*) AS count FROM ride_requests')).count,
    payments: (await get('SELECT COUNT(*) AS count FROM payments')).count,
    providers: providerHealth(),
    kyc: kycHealth(),
    divisions: divisionHealth(),
    storage: storageHealth(),
    adminConfigured: Boolean(config.adminPhone),
    commissionPercent: config.commissionPercent,
  });
});

/* The landing page is served from src/landing.js rather than from public/index.html, because a serverless
   bundle only carries what the JS import graph reaches — and Vercel routes `/` to this function anyway.
   One code path, so the test suite exercises the copy a customer actually gets. */
app.get('/', (_req, res) => res.type('html').send(LANDING_HTML));
app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }));
app.use(authRouter, driversRouter, fareRouter, adminRouter, passengerRouter, requestsRouter, paymentsRouter, webhooksRouter, kycRouter, locationsRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((error, req, res, _next) => {
  if (error instanceof ApiError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  const message = String(error.message || error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON' });
  }
  console.error(`[seremoto] ${req.method} ${req.path} failed:`, message);
  res.status(500).json({ error: 'server_error', message: 'The server could not complete the request' });
});

const problems = missingConfig();
if (problems.length) {
  console.warn(`[seremoto] missing configuration: ${problems.join(', ')} — those features will return 503`);
}

export default app;
