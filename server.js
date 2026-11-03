import 'dotenv/config';
import { config } from './src/config.js';
import { databaseName } from './src/db.js';
import app from './src/app.js';

app.listen(config.port, config.host, () => {
  console.log(`[seremoto] API on http://${config.host}:${config.port} (db: ${databaseName()})`);
});
