import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 3;

export function openDb(path = "jobhunt.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "schema.sql"),
    "utf8",
  );
  db.exec(schema); // CREATE IF NOT EXISTS — new DBs get the full current schema
  const v = db.pragma("user_version", { simple: true }) as number;
  if (v > 0 && v < 2) db.exec("ALTER TABLE jobs ADD COLUMN exp_required REAL");
  if (v > 0 && v < 3)
    db.exec("ALTER TABLE jobs ADD COLUMN llm_score REAL; ALTER TABLE jobs ADD COLUMN llm_reason TEXT");
  db.pragma(`user_version = ${VERSION}`);
  return db;
}
