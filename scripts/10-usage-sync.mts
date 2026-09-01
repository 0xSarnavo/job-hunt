// STEP 10 — API usage → CRM. One "API Usage" row per vendor in Twenty:
// used today / this month / total, against its free limit. Counters come from
// the usage ledger (src/usage.ts) which every vendor call site increments.
import { openDb } from "../src/db.ts";
import { LIMITS } from "../src/usage.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
const db = openDb();
db.exec(`CREATE TABLE IF NOT EXISTS usage (
  vendor TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER DEFAULT 0, PRIMARY KEY (vendor, day)
)`);

const U = process.env.TWENTY_URL!, K = process.env.TWENTY_API_KEY!;
const twenty = async (method: string, path: string, body?: unknown) => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await fetch(`${U}/rest/${path}`, {
    method, headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : (console.error(`${path}: ${res.status} ${(await res.text()).slice(0, 150)}`), null);
};

const rows = db.prepare(`
  SELECT vendor,
    SUM(CASE WHEN day = date('now') THEN calls ELSE 0 END) today,
    SUM(CASE WHEN day >= date('now', 'start of month') THEN calls ELSE 0 END) month,
    SUM(calls) total
  FROM usage GROUP BY vendor`).all() as any[];

const existing = (await twenty("GET", "apiUsages?limit=60"))?.data?.apiUsages ?? [];
const byName = new Map(existing.map((e: any) => [e.name, e.id]));

for (const vendor of new Set([...rows.map((r) => r.vendor), ...Object.keys(LIMITS)])) {
  const r = rows.find((x) => x.vendor === vendor) ?? { today: 0, month: 0, total: 0 };
  const body = {
    name: vendor,
    usedToday: r.today, usedMonth: r.month, usedTotal: r.total,
    freeLimit: LIMITS[vendor] ?? "?",
  };
  const id = byName.get(vendor);
  if (id) await twenty("PATCH", `apiUsages/${id}`, body);
  else await twenty("POST", "apiUsages", body);
  console.log(`${vendor.padEnd(16)} today ${String(r.today).padStart(4)}  month ${String(r.month).padStart(5)}  total ${String(r.total).padStart(5)}  (${body.freeLimit})`);
}
