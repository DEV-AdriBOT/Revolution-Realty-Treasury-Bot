import pg from "pg";
import { redact } from "./security.js";
import { publicBaseUrl } from "./public-url.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 8),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  ssl: process.env.PGSSLMODE === "disable" ? false : process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (error) => console.error("database pool error", redact(error)));

export async function withTransaction(fn, isolation = "READ COMMITTED") {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function ready() {
  await pool.query("SELECT 1");
  const required = ["DATABASE_URL", "PUBLIC_BASE_URL"];
  const mode = process.env.FINANCE_MODE || "disabled";
  if (mode !== "disabled") required.push("TOKEN_ENCRYPTION_KEYS", "TOKEN_ENCRYPTION_ACTIVE_VERSION", "TREASURY_BUSINESS_TOKEN");
  const missing = required.filter((name) => !process.env[name]);
  try { publicBaseUrl(); } catch { if (process.env.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL.https"); }
  if (mode !== "disabled") {
    const configured = (await pool.query("SELECT bool_or(business_account_id IS NOT NULL) account,bool_or(plugin_system IS NOT NULL AND plugin_system<>'') plugin FROM guild_config")).rows[0];
    if (!configured?.account) missing.push("guild_config.business_account_id");
    if (!configured?.plugin) missing.push("guild_config.plugin_system");
  }
  return { ok: missing.length === 0, missing };
}

export async function shutdownDatabase() {
  await pool.end();
}
