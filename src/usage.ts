import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./db.ts";

// API usage ledger — every metered/limited vendor call increments a counter.
// Surfaced in the CRM by scripts/10-usage-sync.mts. Uses its own connection so
// call sites don't need a db handle.

export const LIMITS: Record<string, string> = {
  "tinyfish-search": "500/hr (free forever)",
  "tinyfish-fetch": "1,000/day (free forever)",
  firecrawl: "1,000/mo",
  adzuna: "~1,000/mo",
  jooble: "500 TOTAL grant",
  hunter: "50 searches/mo",
  prospeo: "75/mo",
  apollo: "600/day (org-enrich only)",
  reacher: "self-hosted (unlimited)",
  "opencode-llm": "free tier",
  "claude-llm": "subscription",
  "twenty-api": "100/min (self-hosted)",
};

let _db: Database.Database | null = null;
function ledger(): Database.Database {
  if (!_db) {
    mkdirSync(dirname(DB_PATH) || ".", { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`CREATE TABLE IF NOT EXISTS usage (
      vendor TEXT NOT NULL,
      day    TEXT NOT NULL,
      calls  INTEGER DEFAULT 0,
      PRIMARY KEY (vendor, day)
    )`);
  }
  return _db;
}

export function track(vendor: string, n = 1): void {
  try {
    ledger().prepare(
      `INSERT INTO usage (vendor, day, calls) VALUES (?, date('now'), ?)
       ON CONFLICT(vendor, day) DO UPDATE SET calls = calls + ?`,
    ).run(vendor, n, n);
  } catch {
    // usage tracking must never break the pipeline
  }
}
