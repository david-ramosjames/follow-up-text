import pg from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. On Railway, add a Postgres service and reference its DATABASE_URL.");
}

// Railway's Postgres presents a certificate that is not in Node's trust store.
// Local development over a unix socket or localhost needs no TLS at all.
const isLocal = /localhost|127\.0\.0\.1|@\/|host=\//.test(connectionString);
const sslDisabled = process.env.PGSSLMODE === "disable" || isLocal;

export const pool = new pg.Pool({
  connectionString,
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => console.error("Unexpected Postgres pool error", error));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function rows(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function one(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] ?? null;
}

// The state machine lives in Postgres functions that take and return jsonb, so
// every call through this helper is one atomic transition.
export async function rpc(fn, payload) {
  const result = await pool.query(`select ${fn}($1::jsonb) as result`, [JSON.stringify(payload)]);
  return result.rows[0]?.result ?? null;
}

export async function rpcSet(fn, arg) {
  const result = await pool.query(`select * from ${fn}($1)`, [arg]);
  return result.rows.map((row) => Object.values(row)[0]);
}

export async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await handler(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
