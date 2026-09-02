import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 6;

// Everything generated lives under data/ (gitignored — the repo is public).
export const DB_PATH = process.env.JOBHUNT_DB ?? "data/jobhunt.db";

export function openDb(path = DB_PATH): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path) || ".", { recursive: true });
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
  if (v < 4)
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_people_unique ON people(lower(company), lower(name))");
  if (v > 0 && v < 5)
    db.exec("ALTER TABLE companies ADD COLUMN pitch INTEGER DEFAULT 0");
  // v6: portfolio_companies table + data/ home — both handled by schema.sql / DB_PATH
  db.pragma(`user_version = ${VERSION}`);
  return db;
}
