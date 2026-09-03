// Sets up the Twenty CRM data model to mirror the SQLite schema (PLAN §9).
// Idempotent: skips fields that already exist. Run: npm run setup-crm

import { loadEnv } from "./env.ts";
loadEnv();

const URL_ = process.env.TWENTY_URL;
const KEY = process.env.TWENTY_API_KEY;
if (!URL_ || !KEY) throw new Error("TWENTY_URL / TWENTY_API_KEY missing in .env");

async function gql(endpoint: "metadata" | "graphql", query: string): Promise<any> {
  const res = await fetch(`${URL_}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as any;
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

const opt = (value: string, label: string, color: string, position: number) =>
  `{value:"${value}", label:"${label}", color:"${color}", position:${position}}`;

type FieldSpec = { name: string; label: string; type: string; options?: string; description?: string };

const MODEL: Record<string, FieldSpec[]> = {
  company: [
    { name: "actor", label: "Actor", type: "TEXT", description: "which agent/human created or last touched this record" },
    { name: "fundingStage", label: "Funding Stage", type: "SELECT", options: `[${[
      opt("PRE_SEED", "Pre-seed", "purple", 0), opt("SEED", "Seed", "turquoise", 1),
      opt("SERIES_A", "Series A", "blue", 2), opt("SERIES_B", "Series B", "sky", 3),
      opt("SERIES_C_PLUS", "Series C+", "green", 4), opt("UNKNOWN", "Unknown", "gray", 5)].join(",")}]` },
    { name: "fundingNote", label: "Funding Note", type: "TEXT", description: "e.g. $21M Series A co-led by Nexus, Aug 2026" },
    { name: "ats", label: "ATS", type: "SELECT", options: `[${[
      opt("GREENHOUSE", "Greenhouse", "green", 0), opt("LEVER", "Lever", "blue", 1),
      opt("ASHBY", "Ashby", "purple", 2), opt("WORKABLE", "Workable", "sky", 3),
      opt("SMARTRECRUITERS", "SmartRecruiters", "turquoise", 4), opt("OTHER", "Other", "yellow", 5),
      opt("NONE_FOUND", "None found", "gray", 6)].join(",")}]` },
    { name: "signalSource", label: "Signal Source", type: "TEXT", description: "where we first saw this company (entrackr, hn, remotive, ...)" },
    { name: "research", label: "Research", type: "TEXT", description: "what they do + what the candidate can do for them (step 6 output)" },
    { name: "headcount", label: "Headcount", type: "NUMBER", description: "employee count (Apollo enrich / YC directory team size)" },
    { name: "feedbackNote", label: "Feedback Note", type: "TEXT", description: "why this company is irrelevant — 15-feedback pulls it and the pipeline stops suggesting similar" },
  ],
  person: [
    { name: "actor", label: "Actor", type: "TEXT" },
    { name: "personaTier", label: "Persona Tier", type: "SELECT", options: `[${[
      opt("FOUNDER", "Founder/CTO", "purple", 0), opt("HIRING_MANAGER", "Hiring Manager", "blue", 1),
      opt("PEER", "Future Peer", "turquoise", 2), opt("RECRUITER", "Recruiter", "gray", 3)].join(",")}]` },
    { name: "emailStatus", label: "Email Status", type: "SELECT", options: `[${[
      opt("VALID", "Valid", "green", 0), opt("RISKY", "Risky", "yellow", 1),
      opt("INVALID", "Invalid", "red", 2), opt("UNVERIFIED", "Unverified", "gray", 3)].join(",")}]` },
    { name: "emailProvenance", label: "Email Provenance", type: "TEXT", description: "vendor + confidence, e.g. prospeo:82 verified 2026-09-01" },
    { name: "linkedinNote", label: "LinkedIn Note", type: "TEXT", description: "drafted connect note, ≤300 chars (LinkedIn's cap)" },
    { name: "dmDraft", label: "DM Draft", type: "TEXT", description: "≤150-word message for after they accept" },
    { name: "fetchEmail", label: "Fetch Email", type: "SELECT", options: `[${[
      opt("NO", "No", "gray", 0), opt("YES", "Yes — fetch", "blue", 1),
      opt("DONE", "Done", "green", 2), opt("FAILED", "Failed", "red", 3)].join(",")}]` },
  ],
  opportunity: [
    { name: "actor", label: "Actor", type: "TEXT" },
    { name: "jobTitle", label: "Job Title", type: "TEXT" },
    { name: "jobUrl", label: "Job URL", type: "TEXT" },
    { name: "applyLink", label: "Apply Link", type: "LINKS" },
    { name: "postedAt", label: "Posted At", type: "DATE_TIME" },
    { name: "expAsk", label: "Exp Ask", type: "TEXT", description: "years of experience the posting asks for, when above the profile's stretch" },
    { name: "llmScore", label: "LLM Score", type: "NUMBER", description: "second-pass judgment from the free-model judge (step 2)" },
    { name: "llmReason", label: "LLM Reason", type: "TEXT" },
    { name: "matchScore", label: "Match Score", type: "NUMBER" },
    { name: "appliedAt", label: "Applied At", type: "DATE_TIME" },
    { name: "channel", label: "Channel", type: "SELECT", options: `[${[
      opt("EMAIL", "Email", "blue", 0), opt("LINKEDIN", "LinkedIn", "sky", 1),
      opt("BOTH", "Both", "green", 2)].join(",")}]` },
    { name: "feedbackNote", label: "Feedback Note", type: "TEXT", description: "why this role is irrelevant (move to CLOSED too) — 15-feedback pulls it and the judge learns" },
  ],
};

// Outreach pipeline states for the opportunity kanban.
// SENT → (no reply, 3 touches max) → STOPPED happens automatically (8-followups);
// APPLIED / INTERVIEWING / OFFER you move yourself as things progress.
const STAGE_OPTIONS = `[${[
  opt("QUEUED", "Queued", "gray", 0), opt("INVITED", "Invited", "sky", 1),
  opt("WARM", "Warm", "yellow", 2), opt("DRAFTED", "Drafted", "purple", 3),
  opt("SENT", "Sent", "blue", 4), opt("APPLIED", "Applied", "turquoise", 5),
  opt("REPLIED", "Replied", "green", 6), opt("INTERVIEWING", "Interviewing", "orange", 7),
  opt("OFFER", "Offer", "green", 8), opt("STOPPED", "Stopped", "gray", 9),
  opt("CLOSED", "Closed", "red", 10)].join(",")}]`;

// Click-not-type rejection reasons (multi-select) — 15-feedback reads these.
const FEEDBACK_OPTIONS = `[${[
  opt("TOO_SENIOR", "Too senior", "orange", 0), opt("WRONG_ROLE", "Wrong role type", "red", 1),
  opt("WRONG_DOMAIN", "Wrong domain", "purple", 2), opt("WRONG_LOCATION", "Location/geo", "sky", 3),
  opt("AGENCY_STAFFING", "Agency / staffing", "yellow", 4), opt("COMP_TOO_LOW", "Comp too low", "pink", 5),
  opt("COMPANY_DEAD", "Company inactive", "gray", 6), opt("NOT_A_FIT", "Not a fit (gut)", "blue", 7),
  opt("OTHER", "Other (see note)", "turquoise", 8)].join(",")}]`;

const objects = await gql("metadata",
  `query { objects(paging:{first:100}) { edges { node { id nameSingular isActive } } } }`);
const objId: Record<string, string> = {};
for (const e of objects.objects.edges)
  if (e.node.isActive) objId[e.node.nameSingular] = e.node.id;

// --- custom objects: the CRM's five-object model is
//     Job Portals / Investor Portfolios / Companies / People / Opportunities
//     (+ API Usage as an ops sidecar). Created idempotently here; their
//     fields ride the same MODEL loop below.
const CUSTOM_OBJECTS = [
  { nameSingular: "jobPortal", namePlural: "jobPortals", labelSingular: "Job Portal", labelPlural: "Job Portals",
    icon: "IconWorldSearch", description: "every place the pipeline pulls job postings or funding signals from (src/registry.ts)" },
  { nameSingular: "investorPortfolio", namePlural: "investorPortfolios", labelSingular: "Investor Portfolio", labelPlural: "Investor Portfolios",
    icon: "IconBuildingBank", description: "accelerators & VC programs whose member companies we track (YC, a16z, ...)" },
];
for (const o of CUSTOM_OBJECTS) {
  if (objId[o.nameSingular]) { console.log(`ok    object ${o.nameSingular} (exists)`); continue; }
  const created = await gql("metadata",
    `mutation { createOneObject(input:{object:{
      nameSingular:"${o.nameSingular}", namePlural:"${o.namePlural}",
      labelSingular:"${o.labelSingular}", labelPlural:"${o.labelPlural}",
      icon:"${o.icon}", description:${JSON.stringify(o.description)}
    }}) { id } }`);
  objId[o.nameSingular] = created.createOneObject.id;
  console.log(`+++   object ${o.nameSingular} created`);
}

MODEL.jobPortal = [
  { name: "actor", label: "Actor", type: "TEXT" },
  { name: "portalUrl", label: "Portal URL", type: "LINKS" },
  { name: "kind", label: "Kind", type: "SELECT", options: `[${[
    opt("ATS_API", "ATS API", "blue", 0), opt("FEED", "Feed", "green", 1),
    opt("AGGREGATOR_API", "Aggregator API", "sky", 2), opt("VC_BOARD", "VC Board", "purple", 3),
    opt("FUNDING_RSS", "Funding RSS", "yellow", 4), opt("SCRAPE", "Scrape", "orange", 5),
    opt("COMPANY_BOARD", "Company Board", "turquoise", 6)].join(",")}]` },
  { name: "status", label: "Status", type: "SELECT", options: `[${[
    opt("ACTIVE", "Active", "green", 0), opt("PLANNED", "Planned", "yellow", 1),
    opt("LATER", "Later", "gray", 2)].join(",")}]` },
  { name: "whatItGives", label: "What It Gives", type: "TEXT" },
  { name: "sourceSlug", label: "Source Slug", type: "TEXT", description: "matches jobs.source / companies.source prefixes in SQLite" },
  { name: "jobsIngested", label: "Jobs Ingested", type: "NUMBER", description: "rows in the local jobs table from this portal" },
];
MODEL.investorPortfolio = [
  { name: "actor", label: "Actor", type: "TEXT" },
  { name: "kind", label: "Kind", type: "SELECT", options: `[${[
    opt("ACCELERATOR", "Accelerator", "purple", 0), opt("VC", "VC", "blue", 1),
    opt("DIRECTORY", "Directory", "green", 2)].join(",")}]` },
  { name: "portfolioUrl", label: "Portfolio URL", type: "LINKS" },
  { name: "jobsBoardUrl", label: "Jobs Board URL", type: "LINKS" },
  { name: "scrapeStatus", label: "Scrape Status", type: "SELECT", options: `[${[
    opt("SCRAPED", "Scraped", "green", 0), opt("PLANNED", "Planned", "yellow", 1)].join(",")}]` },
  { name: "companiesTracked", label: "Companies Tracked", type: "NUMBER", description: "rows in local portfolio_companies for this program" },
  { name: "companiesInCrm", label: "Companies In CRM", type: "NUMBER", description: "how many of those were pushed as CRM Companies" },
  { name: "notes", label: "Notes", type: "TEXT" },
];

// Structured feedback (multi-select) + the 3-touch outreach ladder fields.
MODEL.company!.push(
  { name: "feedbackReason", label: "Feedback Reason", type: "MULTI_SELECT", options: FEEDBACK_OPTIONS,
    description: "click why this company is irrelevant — 15-feedback learns from it" });
MODEL.opportunity!.push(
  { name: "feedbackReason", label: "Feedback Reason", type: "MULTI_SELECT", options: FEEDBACK_OPTIONS,
    description: "click why this role is irrelevant — the judge learns from it" },
  { name: "touches", label: "Touches", type: "NUMBER", description: "outreach messages sent (max 3, then auto-STOPPED)" },
  { name: "interviewAt", label: "Interview At", type: "DATE_TIME", description: "next interview — set it and 8-followups makes a prep task" });
MODEL.person!.push(
  { name: "outreachStage", label: "Outreach Stage", type: "SELECT", options: `[${[
    opt("QUEUED", "Queued", "gray", 0), opt("CONNECTED", "Connected", "sky", 1),
    opt("TOUCH_1", "Touch 1", "blue", 2), opt("TOUCH_2", "Touch 2", "purple", 3),
    opt("TOUCH_3", "Touch 3", "yellow", 4), opt("REPLIED", "Replied", "green", 5),
    opt("STOPPED", "Stopped", "red", 6)].join(",")}]` },
  { name: "lastTouchAt", label: "Last Touch At", type: "DATE_TIME" },
  { name: "nextFollowUpAt", label: "Next Follow-up At", type: "DATE_TIME" });

for (const [obj, fields] of Object.entries(MODEL)) {
  const id = objId[obj];
  if (!id) { console.log(`SKIP ${obj}: object not found`); continue; }
  const existing = await gql("metadata",
    `query { object(id:"${id}") { fields(paging:{first:200}) { edges { node { name } } } } }`);
  const have = new Set(existing.object.fields.edges.map((e: any) => e.node.name));
  for (const f of fields) {
    if (have.has(f.name)) { console.log(`ok    ${obj}.${f.name} (exists)`); continue; }
    const extras = [
      f.options ? `options:${f.options}` : "",
      f.description ? `description:${JSON.stringify(f.description)}` : "",
    ].filter(Boolean).join(", ");
    await gql("metadata",
      `mutation { createOneField(input:{field:{name:"${f.name}", label:"${f.label}", type:${f.type}, objectMetadataId:"${id}"${extras ? ", " + extras : ""}}}) { id } }`);
    console.log(`+++   ${obj}.${f.name} created`);
  }
}

// Custom object: API Usage — one row per vendor, synced by scripts/10-usage-sync.mts.
if (!objId["apiUsage"]) {
  const created = await gql("metadata",
    `mutation { createOneObject(input:{object:{
      nameSingular:"apiUsage", namePlural:"apiUsages",
      labelSingular:"API Usage", labelPlural:"API Usages",
      icon:"IconApi", description:"per-vendor API call counters (free-tier budgets)"
    }}) { id } }`);
  objId["apiUsage"] = created.createOneObject.id;
  console.log("+++   object apiUsage created");
  for (const f of [
    { name: "usedToday", label: "Used Today", type: "NUMBER" },
    { name: "usedMonth", label: "Used This Month", type: "NUMBER" },
    { name: "usedTotal", label: "Used Total", type: "NUMBER" },
    { name: "freeLimit", label: "Free Limit", type: "TEXT" },
  ])
    await gql("metadata",
      `mutation { createOneField(input:{field:{name:"${f.name}", label:"${f.label}", type:${f.type}, objectMetadataId:"${objId["apiUsage"]}"}}) { id } }`);
  console.log("+++   apiUsage fields created");
}

// Relation: Company → Investor Portfolio (MANY_TO_ONE; portfolio side shows "Companies").
try {
  const compFields = await gql("metadata",
    `query { object(id:"${objId.company}") { fields(paging:{first:200}) { edges { node { name } } } } }`);
  const haveRel = compFields.object.fields.edges.some((e: any) => e.node.name === "investorPortfolio");
  if (haveRel) console.log("ok    company.investorPortfolio relation (exists)");
  else {
    await gql("metadata",
      `mutation { createOneField(input:{field:{
        name:"investorPortfolio", label:"Investor Portfolio", type:RELATION, icon:"IconBuildingBank",
        objectMetadataId:"${objId.company}",
        relationCreationPayload:{
          type:"MANY_TO_ONE",
          targetObjectMetadataId:"${objId.investorPortfolio}",
          targetFieldLabel:"Companies",
          targetFieldIcon:"IconBuildingSkyscraper"
        }
      }}) { id } }`);
    console.log("+++   company.investorPortfolio relation created");
  }
} catch (err) {
  console.log(`warn  relation company→investorPortfolio failed: ${String(err).slice(0, 300)}`);
}

// Keep SELECT options of existing fields in sync with the MODEL above
// (createOneField only runs for missing fields — new options need an update).
for (const [obj, fieldName] of [["jobPortal", "kind"], ["investorPortfolio", "kind"]] as const) {
  try {
    const spec = MODEL[obj]!.find((f) => f.name === fieldName)!;
    const fields = await gql("metadata",
      `query { object(id:"${objId[obj]}") { fields(paging:{first:200}) { edges { node { id name options } } } } }`);
    const f = fields.object.fields.edges.find((e: any) => e.node.name === fieldName)?.node;
    if (!f) continue;
    const wanted = (spec.options!.match(/value:"([A-Z_]+)"/g) ?? []).length;
    if ((f.options?.length ?? 0) >= wanted) { console.log(`ok    ${obj}.${fieldName} options up to date`); continue; }
    await gql("metadata",
      `mutation { updateOneField(input:{id:"${f.id}", update:{options:${spec.options}}}) { id } }`);
    console.log(`+++   ${obj}.${fieldName} options refreshed`);
  } catch (err) {
    console.log(`warn  could not refresh ${obj}.${fieldName} options: ${String(err).slice(0, 150)}`);
  }
}

// Deactivate what the five-object model doesn't use (reversible in Settings →
// Data model). Objects: notes are unused; tasks stay (6-emails/8-followups
// create them). Fields: sales-CRM leftovers on our repurposed objects.
const DEACTIVATE_FIELDS: [string, string][] = [
  ["company", "annualRevenue"],
  ["opportunity", "amount"],
  ["opportunity", "closeDate"],
];
for (const [obj, fieldName] of DEACTIVATE_FIELDS) {
  try {
    const fields = await gql("metadata",
      `query { object(id:"${objId[obj]}") { fields(paging:{first:200}) { edges { node { id name isActive } } } } }`);
    const f = fields.object.fields.edges.find((e: any) => e.node.name === fieldName)?.node;
    if (!f || !f.isActive) { console.log(`ok    ${obj}.${fieldName} already inactive/absent`); continue; }
    await gql("metadata",
      `mutation { updateOneField(input:{id:"${f.id}", update:{isActive:false}}) { id } }`);
    console.log(`---   ${obj}.${fieldName} deactivated`);
  } catch (err) {
    console.log(`warn  could not deactivate ${obj}.${fieldName}: ${String(err).slice(0, 150)}`);
  }
}
// note: unused. workflow/dashboard: Twenty features this pipeline doesn't use —
// deactivating tidies the sidebar down to the five-object model (+ Tasks, API Usage).
for (const objName of ["note", "workflow", "dashboard"]) {
  try {
    if (!objId[objName]) continue;
    await gql("metadata",
      `mutation { updateOneObject(input:{id:"${objId[objName]}", update:{isActive:false}}) { id } }`);
    console.log(`---   object ${objName} deactivated (unused)`);
  } catch (err) {
    console.log(`warn  could not deactivate ${objName} object: ${String(err).slice(0, 150)}`);
  }
}

// Repoint the opportunity kanban stages at our outreach states.
try {
  const fields = await gql("metadata",
    `query { object(id:"${objId.opportunity}") { fields(paging:{first:200}) { edges { node { id name type } } } } }`);
  const stage = fields.object.fields.edges.find((e: any) => e.node.name === "stage");
  if (stage) {
    await gql("metadata",
      `mutation { updateOneField(input:{id:"${stage.node.id}", update:{options:${STAGE_OPTIONS}, defaultValue:"'QUEUED'"}}) { id } }`);
    console.log("+++   opportunity.stage options → QUEUED/INVITED/WARM/DRAFTED/SENT/REPLIED/CLOSED");
  }
} catch (err) {
  console.log(`warn  could not update opportunity.stage options: ${String(err).slice(0, 200)}`);
}

console.log("CRM model ready.");
