import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { config } from './config/index.js';
import { db, pool } from './db/index.js';
import { runSeed } from './db/seed.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Run database migrations before accepting traffic
  try {
    await migrate(db, {
      migrationsFolder: new URL('./db/migrations', import.meta.url).pathname,
    });
    app.log.info({ service: 'Server' }, 'Database migrations complete');
  } catch (err) {
    app.log.error({ service: 'Server', err }, 'Database migration failed');
    await pool.end();
    process.exit(1);
  }

  // Seed default data — non-fatal if it fails (data may already exist)
  try {
    await runSeed(app.log);
    app.log.info({ service: 'Server' }, 'Database seed complete');
  } catch (err) {
    app.log.warn({ service: 'Server', err }, 'Database seed failed — continuing startup');
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { service: 'Server', port: config.port, host: config.host, env: config.nodeEnv },
      'Alexandria backend started',
    );
  } catch (err) {
    app.log.error({ service: 'Server', err }, 'Failed to start server');
    await pool.end();
    process.exit(1);
  }
}

main();
