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
  pitch       INTEGER DEFAULT 0,  -- 1 = proactive GTM-pitch target (funded, 5-50 headcount)
  first_seen  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  url         TEXT PRIMARY KEY,
  company     TEXT,
  title       TEXT NOT NULL,
  location    TEXT,
  posted_at   TEXT,
  source      TEXT,
  description TEXT,              -- plain text; feeds scoring, drafts, and tailor-cv
  exp_required REAL,             -- years the posting asks for (null = not stated)
  llm_score   REAL,              -- second-pass score from the free-model judge (step 2)
  llm_reason  TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_unique ON people(lower(company), lower(name));

CREATE TABLE IF NOT EXISTS touches (
  id          INTEGER PRIMARY KEY,
  person      INTEGER REFERENCES people(id),
  channel     TEXT,              -- linkedin|email
  state       TEXT,              -- queued|invited|warm|drafted|sent|replied|closed
  actor       TEXT,              -- who moved this state: claude-code|opencode|cron|human|...
  sent_at     TEXT,
  accepted_at TEXT,
  replied_at  TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  job        TEXT REFERENCES jobs(url),
  applied_at TEXT,
  channel    TEXT
);

-- Investor-program directory (YC batches, a16z portfolio, ...). Full lists live
-- here; only the relevant slice is pushed to the CRM (scripts/12-portfolios.mts).
CREATE TABLE IF NOT EXISTS portfolio_companies (
  program     TEXT NOT NULL,     -- registry slug: yc | a16z | ...
  name        TEXT NOT NULL,
  domain      TEXT,
  batch       TEXT,              -- e.g. "Fall 2026" (YC); investment stage tags for VCs
  status      TEXT,              -- Active | Acquired | Inactive | Exits | ...
  url         TEXT,              -- company website
  one_liner   TEXT,
  first_seen  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (program, name)
);

CREATE TABLE IF NOT EXISTS lookups (
  key         TEXT PRIMARY KEY,  -- e.g. "hunter:jane@acme.com", "fetch:https://..."
  provider    TEXT,
  result      TEXT,              -- JSON
  cost        REAL DEFAULT 0,
  observed_at TEXT DEFAULT (datetime('now'))
);

-- schema version is managed in db.ts (PRAGMA user_version); migrations live there too.
