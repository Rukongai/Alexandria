import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

async function runMigrations() {
  console.log('Running migrations...');

  await migrate(db, {
    migrationsFolder: new URL('./migrations', import.meta.url).pathname,
  });

  console.log('Migrations complete.');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
