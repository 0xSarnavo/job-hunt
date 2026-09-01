-- PLAN §9. Migrations: bump PRAGMA user_version, append ALTERs below the marker.

CREATE TABLE IF NOT EXISTS companies (
  domain      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  stage       TEXT,
  funding     TEXT,
  ats         TEXT,               -- greenhouse|lever|ashby|workable|...|unknown
  ats_token   TEXT,               -- verified board slug/token
  headcount   INTEGER,
  source      TEXT,
  first_seen  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  url         TEXT PRIMARY KEY,
  company     TEXT,
  title       TEXT NOT NULL,
  location    TEXT,
  posted_at   TEXT,
  source      TEXT,
  match_score REAL,
  matched_at  TEXT,
  rejected    TEXT               -- reject reason from hard filters, NULL = alive
);

CREATE TABLE IF NOT EXISTS people (
  id           INTEGER PRIMARY KEY,
  company      TEXT,
  name         TEXT NOT NULL,
  title        TEXT,
  persona_tier TEXT,             -- founder|hiring_manager|peer|recruiter
  linkedin     TEXT,
  email        TEXT,
  email_status TEXT,             -- valid|risky|invalid|unverified
  provenance   TEXT              -- JSON: per-field {source, confidence, observed_at}
);

CREATE TABLE IF NOT EXISTS touches (
  id          INTEGER PRIMARY KEY,
  person      INTEGER REFERENCES people(id),
  channel     TEXT,              -- linkedin|email
  state       TEXT,              -- queued|invited|warm|drafted|sent|replied|closed
  sent_at     TEXT,
  accepted_at TEXT,
  replied_at  TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  job        TEXT REFERENCES jobs(url),
  applied_at TEXT,
  channel    TEXT
);

CREATE TABLE IF NOT EXISTS lookups (
  key         TEXT PRIMARY KEY,  -- e.g. "hunter:jane@acme.com", "fetch:https://..."
  provider    TEXT,
  result      TEXT,              -- JSON
  cost        REAL DEFAULT 0,
  observed_at TEXT DEFAULT (datetime('now'))
);

PRAGMA user_version = 1;
-- migrations below --
