import { initLegacyStore, flushLegacyStore } from "../db.js";
import { shutdownDatabase } from "../src/database.js";

try {
  const result = await initLegacyStore();
  await flushLegacyStore();
  console.log(`Legacy state ready from ${result.source === "postgres" ? "existing PostgreSQL state" : "a backed-up source"}`);
} finally {
  await shutdownDatabase();
}
