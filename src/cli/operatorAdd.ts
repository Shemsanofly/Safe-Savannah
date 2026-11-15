import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { upsertOperator } from '../store/operators.js';
import { flag, parseArgs } from './args.js';

const { flags } = parseArgs();
const id = flag(flags, 'id');
const name = flag(flags, 'name');
const pin = flag(flags, 'pin');
if (!id || !name || !pin) {
  console.error('Usage: npm run operator:add -- --id duty1 --name "Asha (duty manager)" --pin 4821');
  process.exit(2);
}
const db = createPool(loadConfig().DATABASE_URL, 1);
try {
  await migrate(db);
  await upsertOperator(db, { id, name, pin });
  console.log(`Operator "${id}" saved.`);
} finally {
  await db.end();
}
