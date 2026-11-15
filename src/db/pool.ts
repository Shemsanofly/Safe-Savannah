import pg from 'pg';

// Return bigint ids (int8) as JS numbers; event ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  pool.on('error', (err) => {
    process.stderr.write(JSON.stringify({ level: 'error', component: 'db', msg: err.message }) + '\n');
  });
  return pool;
}

export async function withTx<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
