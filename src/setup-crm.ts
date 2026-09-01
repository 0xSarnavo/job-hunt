// Sets up the Twenty CRM data model to mirror the SQLite schema (PLAN §9).
// Idempotent: skips fields that already exist. Run: npm run setup-crm

try {
  process.loadEnvFile(".env");
} catch {}

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
  ],
  opportunity: [
    { name: "actor", label: "Actor", type: "TEXT" },
    { name: "jobTitle", label: "Job Title", type: "TEXT" },
    { name: "jobUrl", label: "Job URL", type: "TEXT" },
    { name: "applyLink", label: "Apply Link", type: "LINKS" },
    { name: "postedAt", label: "Posted At", type: "DATE_TIME" },
    { name: "expAsk", label: "Exp Ask", type: "TEXT", description: "years of experience the posting asks for, when above the profile's stretch" },
    { name: "matchScore", label: "Match Score", type: "NUMBER" },
    { name: "appliedAt", label: "Applied At", type: "DATE_TIME" },
    { name: "channel", label: "Channel", type: "SELECT", options: `[${[
      opt("EMAIL", "Email", "blue", 0), opt("LINKEDIN", "LinkedIn", "sky", 1),
      opt("BOTH", "Both", "green", 2)].join(",")}]` },
  ],
};

// Outreach pipeline states for the opportunity kanban (mirrors touches.state).
const STAGE_OPTIONS = `[${[
  opt("QUEUED", "Queued", "gray", 0), opt("INVITED", "Invited", "sky", 1),
  opt("WARM", "Warm", "yellow", 2), opt("DRAFTED", "Drafted", "purple", 3),
  opt("SENT", "Sent", "blue", 4), opt("REPLIED", "Replied", "green", 5),
  opt("CLOSED", "Closed", "red", 6)].join(",")}]`;

const objects = await gql("metadata",
  `query { objects(paging:{first:60}) { edges { node { id nameSingular isActive } } } }`);
const objId: Record<string, string> = {};
for (const e of objects.objects.edges)
  if (e.node.isActive) objId[e.node.nameSingular] = e.node.id;

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
