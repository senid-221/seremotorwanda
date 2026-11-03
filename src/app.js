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

const app = express();
/* The 17,437 Rwandan divisions go into the database the first time it is opened without them. */
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

app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }));
/* Where the deploy has no public/ on disk — a serverless bundle — the landing page still has to answer
   `/`, and this is the copy the bundler could trace. express.static wins wherever the files are there. */
app.get('/', (_req, res) => res.type('html').send(LANDING_HTML));
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
