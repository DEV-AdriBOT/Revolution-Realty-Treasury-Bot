import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, shutdownDatabase } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const lockId = "824640042101";
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [lockId]);
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await fs.readdir(path.join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const pending = files.filter((file) => !applied.has(path.basename(file, ".sql")));
  if (check) {
    if (pending.length) throw new Error(`Pending migrations: ${pending.join(", ")}`);
    console.log("Migration check passed");
  } else {
    for (const file of pending) {
      const version = path.basename(file, ".sql");
      await client.query(await fs.readFile(path.join(root, "migrations", file), "utf8"));
      const recorded = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
      if (!recorded.rowCount) throw new Error(`Migration ${file} did not record version ${version}`);
      console.log(`Applied ${file}`);
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
  client.release();
  await shutdownDatabase();
}
