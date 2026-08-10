import { withTransaction, shutdownDatabase } from "../src/database.js";

const properties = [
  ["S084", "summerock", [["Servalot", 8000], ["summerock", 2000]]],
  ["C202", "summerock", [["summerock", 10000]]],
  ["C451", "summerock", [["summerock", 10000]]],
  ["C453", "summerock", [["summerock", 10000]]],
  ["C452", "summerock", [["summerock", 10000]]],
  ["C454", "summerock", [["summerock", 10000]]],
  ["C492", "summerock", [["summerock", 10000]]],
  ["S102", "summerock", [["Servalot", 5000], ["summerock", 5000]]],
  ["C353", "summerock", [["summerock", 10000]]],
  ["C193", "summerock", [["summerock", 10000]], "REVIEW_REQUIRED", "Pending C193/C194 project/merge"],
  ["C613", "Servalot", [["Servalot", 10000]]],
  ["C448", "Servalot", [["Servalot", 5000], ["summerock", 5000]]],
  ["C449", "Servalot", [["Servalot", 5000], ["summerock", 5000]]],
  ["C022", "Servalot", [["Servalot", 10000]]],
  ["C021", "Servalot", [["Servalot", 10000]]],
  ["C020", "Servalot", [["Servalot", 10000]]],
  ["C018", "Servalot", [["Servalot", 10000]]],
  ["C090", "Servalot", [["Servalot", 10000]]],
  ["C100", "Servalot", [["Servalot", 5000], ["summerock", 5000]]],
  ["C355", "Servalot", [["Servalot", 5000], ["summerock", 5000]]],
  ["C194", "Servalot", [["Servalot", 10000]], "REVIEW_REQUIRED", "Pending C193/C194 project/merge"],
  ["C356", "Servalot", [["Servalot", 5000], ["summerock", 5000]]],
];

const apply = process.argv.includes("--apply");
console.log(`Property import ${apply ? "APPLY" : "PREVIEW"}: ${properties.length} regions`);
for (const [region, landlord, shares, status = "DISABLED", notes = null] of properties) {
  console.log(`${region.padEnd(5)} landlord=${landlord.padEnd(10)} status=${status.padEnd(15)} ${shares.map(([name, bp]) => `${name} ${bp / 100}%`).join(", ")}${notes ? ` - ${notes}` : ""}`);
}

if (apply) {
  await withTransaction(async (db) => {
    const shareholders = (await db.query("SELECT id,lower(current_ign) ign FROM shareholders WHERE lower(current_ign) IN ('servalot','summerock') FOR UPDATE")).rows;
    const ids = new Map(shareholders.map((row) => [row.ign, row.id]));
    if (!ids.has("servalot") || !ids.has("summerock")) throw new Error("Servalot and summerock must be created with verified UUID/Discord IDs before applying the import");
    const existing = (await db.query("SELECT region FROM properties WHERE region=ANY($1::text[]) ORDER BY region FOR UPDATE", [properties.map(([region]) => region)])).rows;
    if (existing.length) throw new Error(`Initial import is all-or-nothing; these regions already exist: ${existing.map((row) => row.region).join(", ")}`);
    for (const [region, landlord, shares, status = "DISABLED", notes = null] of properties) {
      const inserted = await db.query("INSERT INTO properties(region,landlord_shareholder_id,status,notes) VALUES($1,$2,$3,$4) RETURNING id", [region, ids.get(landlord.toLowerCase()), status, notes]);
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,created_by,reason) VALUES($1,1,'INITIAL_IMPORT','Authoritative initial property import') RETURNING id", [inserted.rows[0].id])).rows[0];
      for (const [name, basisPoints] of shares) await db.query("INSERT INTO ownership_allocations(ownership_version_id,shareholder_id,basis_points) VALUES($1,$2,$3)", [version.id, ids.get(name.toLowerCase()), basisPoints]);
      if (!(await db.query("SELECT ownership_total_is_10000($1) ok", [version.id])).rows[0].ok) throw new Error(`Invalid allocation total for ${region}`);
    }
    await db.query("INSERT INTO audit_events(actor_type,event_type,entity_type,entity_id,metadata) VALUES('SYSTEM','PROPERTY_IMPORT','PROPERTY_SET','initial',$1)", [{ count: properties.length }]);
  }, "SERIALIZABLE");
  console.log("Property import applied. Non-review properties remain DISABLED until manager approval.");
}
await shutdownDatabase();
