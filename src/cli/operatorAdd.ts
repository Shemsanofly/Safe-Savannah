import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { countActiveSupervisors, upsertOperator, type Role } from '../store/operators.js';
import { flag, parseArgs } from './args.js';

const { flags } = parseArgs();
const id = flag(flags, 'id');
const name = flag(flags, 'name');
const pin = flag(flags, 'pin');
const roleArg = flag(flags, 'role');
if (!id || !name || !pin || (roleArg && roleArg !== 'officer' && roleArg !== 'supervisor')) {
  console.error('Usage: npm run operator:add -- --id duty1 --name "Asha (duty manager)" --pin 4821 [--role officer|supervisor]');
  console.error('The first operator defaults to supervisor so someone can manage accounts from the Settings screen.');
  process.exit(2);
}
const db = createPool(loadConfig().DATABASE_URL, 1);
try {
  await migrate(db);
  const role: Role | undefined = (roleArg as Role | undefined) ?? ((await countActiveSupervisors(db)) === 0 ? 'supervisor' : undefined);
  await upsertOperator(db, { id, name, pin, role });
  const saved = await db.query<{ role: string }>('SELECT role FROM operators WHERE id = $1', [id]);
  console.log(`Operator "${id}" saved as ${saved.rows[0]?.role}.`);
} finally {
  await db.end();
}
