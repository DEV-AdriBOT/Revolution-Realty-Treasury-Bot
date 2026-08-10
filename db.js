// ---------------------------------------------------------------------------
// db.js — simple JSON-file persistence (no native deps). Holds per-guild config
// tickets, contracts and non-financial Discord state.
// ---------------------------------------------------------------------------
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { pool, withTransaction } from "./src/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
mkdirSync(DATA_DIR, { recursive: true });
const FILE = join(DATA_DIR, "data.json");

let data = {
  guilds: {},
  tickets: [],
  contracts: [],
  nextContractId: 1,
  pendingVerify: {},
  verified: {},
  listings: [],
  nextListingId: 1,
};
function normalize(input) {
    data = input;
    data.guilds ??= {};
    data.tickets ??= [];
    data.contracts ??= [];
    data.pendingVerify ??= {};
    data.verified ??= {};
    data.listings ??= [];
    data.nextContractId ??=
      (data.contracts.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;
    data.nextListingId ??=
      (data.listings.reduce((m, l) => Math.max(m, l.id), 0) || 0) + 1;
}

let saveChain = Promise.resolve();

export async function initLegacyStore() {
  const existing = await pool.query("SELECT payload FROM legacy_state WHERE singleton=true");
  if (existing.rowCount) {
    normalize(existing.rows[0].payload);
    await syncVerifiedShareholders();
    return { source: "postgres" };
  }
  let source = "empty";
  if (existsSync(FILE)) {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    normalize(parsed);
    const backupDir = process.env.BACKUP_DIR || join(DATA_DIR, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(FILE, join(backupDir, `data-${stamp}.json`));
    source = FILE;
  }
  await pool.query("INSERT INTO legacy_state(singleton,payload,imported_from) VALUES(true,$1,$2)", [data, source]);
  await syncVerifiedShareholders();
  return { source };
}

async function syncVerifiedShareholders() {
  for (const [discordId, info] of Object.entries(data.verified || {})) {
    if (!info.uuid || !info.ign) continue;
    await pool.query(
      `INSERT INTO shareholders(discord_id,owner_uuid,current_ign) VALUES($1,$2,$3)
       ON CONFLICT(discord_id) DO UPDATE SET owner_uuid=excluded.owner_uuid,current_ign=excluded.current_ign`,
      [discordId, info.uuid, info.ign]
    );
  }
}

function save() {
  saveChain = saveChain
    .catch(() => {})
    .then(() => pool.query("UPDATE legacy_state SET payload=$1,updated_at=now() WHERE singleton=true", [data]))
    .catch((error) => console.error("legacy state save failed", error.message));
}

export async function flushLegacyStore() { await saveChain; }

// --- Per-guild config (set by first-run setup) -----------------------------
export function getGuildConfig(guildId) {
  return data.guilds[guildId] ?? {};
}
export function setGuildConfig(guildId, fields) {
  data.guilds[guildId] = { ...(data.guilds[guildId] ?? {}), ...fields };
  save();
  return data.guilds[guildId];
}

// --- Tickets ---------------------------------------------------------------
export function createTicket(channelId, userId, type, now) {
  data.tickets.push({
    channel_id: channelId,
    user_id: userId,
    type, // "buy" | "sell"
    open: true,
    created_at: now,
  });
  save();
}

export function isTicketChannel(channelId) {
  return data.tickets.some((t) => t.channel_id === channelId && t.open);
}

export function getTicket(channelId) {
  return data.tickets.find((t) => t.channel_id === channelId) ?? null;
}

export function getOpenTicketByUser(userId) {
  return data.tickets.find((t) => t.user_id === userId && t.open) ?? null;
}

export function closeTicket(channelId) {
  const t = data.tickets.find((x) => x.channel_id === channelId && x.open);
  if (t) {
    t.open = false;
    save();
  }
  return t;
}

// --- Contracts -------------------------------------------------------------
export function createContract(obj) {
  const contract = { id: data.nextContractId++, ...obj };
  data.contracts.push(contract);
  save();
  return contract;
}

export function getContract(id) {
  return data.contracts.find((c) => c.id === id) ?? null;
}

// Persist after mutating a contract object returned by getContract().
export function saveContract() {
  save();
}

export function listContracts(filter = {}) {
  return data.contracts.filter((c) =>
    Object.entries(filter).every(([k, v]) => c[k] === v)
  );
}

// --- Listings --------------------------------------------------------------
export function createListing(obj) {
  const listing = { id: data.nextListingId++, ...obj };
  data.listings.push(listing);
  save();
  return listing;
}
export function getListing(id) {
  return data.listings.find((l) => l.id === id) ?? null;
}
export function saveListings() {
  save();
}
export function listListings(filter = {}) {
  return data.listings.filter((l) =>
    Object.entries(filter).every(([k, v]) => l[k] === v)
  );
}

// --- IGN verification ------------------------------------------------------
export function setPendingVerify(discordId, code, amount) {
  data.pendingVerify[discordId] = { code, amount, created_at: Date.now() };
  save();
}
export function getPendingVerify(discordId) {
  return data.pendingVerify[discordId] ?? null;
}
export function clearPendingVerify(discordId) {
  delete data.pendingVerify[discordId];
  save();
}
export async function setVerified(discordId, info) {
  const previous = data.verified[discordId];
  const pending = data.pendingVerify[discordId];
  data.verified[discordId] = { ...info, verified_at: Date.now() };
  delete data.pendingVerify[discordId];
  try {
    saveChain = saveChain.catch(() => {}).then(() => withTransaction(async (db) => {
      await db.query("UPDATE legacy_state SET payload=$1,updated_at=now() WHERE singleton=true", [data]);
      if (info.uuid && info.ign) {
        await db.query(
          `INSERT INTO shareholders(discord_id,owner_uuid,current_ign) VALUES($1,$2,$3)
           ON CONFLICT(discord_id) DO UPDATE SET owner_uuid=excluded.owner_uuid,current_ign=excluded.current_ign`,
          [discordId, info.uuid, info.ign]
        );
      }
    }));
    await saveChain;
  } catch (error) {
    if (previous) data.verified[discordId] = previous;
    else delete data.verified[discordId];
    if (pending) data.pendingVerify[discordId] = pending;
    throw error;
  }
  return data.verified[discordId];
}
export function getVerified(discordId) {
  return data.verified[discordId] ?? null;
}
// Has this IGN/UUID already been claimed by a different Discord user?
export function ignClaimedBy(uuid) {
  for (const [discordId, v] of Object.entries(data.verified)) {
    if (uuid && String(v.uuid).toLowerCase() === String(uuid).toLowerCase()) return discordId;
  }
  return null;
}
