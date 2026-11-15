import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createPool, type Db } from '../../src/db/pool.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/safe_savannah_test';

export async function dbAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

/** Fresh schema for each test file. Never point TEST_DATABASE_URL at real data. */
export async function freshDb(): Promise<Db> {
  if (!/test/i.test(TEST_DATABASE_URL)) throw new Error('Refusing to reset a database whose URL does not contain "test"');
  const db = createPool(TEST_DATABASE_URL, 5);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

export async function truncateAll(db: Db): Promise<void> {
  await db.query(
    'TRUNCATE events, event_actions, notification_jobs, notification_attempts, mock_sms_messages, app_flags, cameras, zone_status, operators RESTART IDENTITY CASCADE',
  );
}
