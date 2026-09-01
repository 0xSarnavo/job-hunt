// STEP 9 — the connect list: latest funded companies + the people to reach,
// each marked with WHERE it came from (funded:techcrunch.com etc).
// Pure DB aggregation — no Claude anywhere in this path; if an LLM is ever
// added here, it must stay on OpenCode free models (LLM_LIGHT).
// Output: connect-list.md (regenerated each run).

import { writeFileSync } from "node:fs";
import { openDb } from "../src/db.ts";

process.chdir(new URL("..", import.meta.url).pathname);
try { process.loadEnvFile(".env"); } catch {}
const db = openDb();

const companies = db.prepare(`
  SELECT name, domain, source, stage, funding, headcount FROM companies
  WHERE pitch = 1 ORDER BY first_seen DESC`).all() as any[];

let md = `# Connect list — funded companies\n\nGenerated ${new Date().toISOString().slice(0, 16)}. Source column = where the signal came from.\nMark **Fetch Email = YES** in Twenty on anyone you want an address for.\n\n`;
md += `| company | from | funding | headcount | careers |\n|---|---|---|---|---|\n`;
for (const c of companies)
  md += `| **${c.name}** | ${c.source ?? "?"} | ${c.funding ?? "?"} | ${c.headcount ?? "?"} | https://${c.domain}/careers |\n`;

for (const c of companies) {
  const people = db.prepare(
    "SELECT name, title, persona_tier, linkedin FROM people WHERE lower(company)=lower(?) ORDER BY CASE persona_tier WHEN 'founder' THEN 0 WHEN 'hiring_manager' THEN 1 ELSE 2 END",
  ).all(c.name) as any[];
  md += `\n## ${c.name} — ${c.funding ?? ""} (${c.headcount ?? "?"} people, via ${c.source ?? "?"})\n\n`;
  if (!people.length) { md += `_no people found yet — run 5-people.mts_\n`; continue; }
  md += `| person | title | tier | linkedin |\n|---|---|---|---|\n`;
  for (const p of people) md += `| ${p.name} | ${p.title} | ${p.persona_tier} | ${p.linkedin} |\n`;
}

writeFileSync("connect-list.md", md);
console.log(`connect-list.md: ${companies.length} funded companies, ${db.prepare("SELECT count(*) n FROM people WHERE lower(company) IN (SELECT lower(name) FROM companies WHERE pitch=1)").pluck().get()} people`);
