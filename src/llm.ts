import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";

// The model is deliberately swappable and assumed weak; correctness lives here:
// schema-constrained prompts, strict validation, retry with the validator's
// error, escalation to the heavy tier, and forever-caching in `lookups`.
//
//   light — cheap extraction (funding items, HN posts, careers pages).
//           Default: an OpenCode Zen free model. Needs `opencode auth login`.
//   heavy — judgement calls (hiring-manager inference, draft personalisation).
//           Default: claude -p on the existing subscription.

export type Tier = "light" | "heavy";

function tierCmd(tier: Tier): string[] {
  const env = tier === "light" ? process.env.LLM_LIGHT : process.env.LLM_HEAVY;
  if (env) return env.split(" ");
  return tier === "light"
    ? ["opencode", "run", "-m", "opencode/mimo-v2.5-free"] // nemotron-*-free return empty output
    : ["claude", "-p"];
}

const TIMEOUT_MS = 120_000;

export function runLLM(prompt: string, tier: Tier): string {
  const [cmd, ...args] = tierCmd(tier);
  // Prompt as final argument: `opencode run` hangs on piped stdin.
  const res = spawnSync(cmd!, [...args, prompt], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw new Error(`${cmd} failed: ${res.error.message}`);
  if (res.status !== 0)
    throw new Error(`${cmd} exited ${res.status}: ${res.stderr?.slice(0, 500)}`);
  return res.stdout.trim();
}

// Weak models wrap JSON in fences or prose; take the outermost {...} or [...].
export function pluckJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("no JSON in output");
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("unterminated JSON in output");
  return text.slice(start, end + 1);
}

export interface ExtractOpts {
  tier?: Tier;
  retries?: number; // per tier
  escalate?: boolean; // retry exhausted on light → one heavy attempt
  db?: Database.Database; // enables forever-cache in `lookups`
  example?: unknown; // sample valid output — weak free models comply far better with one
}

export function extract<S extends z.ZodType>(
  schema: S,
  task: string,
  input: string,
  opts: ExtractOpts = {},
): z.infer<S> {
  const { tier = "light", retries = 2, escalate = true, db, example } = opts;

  // Cache on task+input only — extraction facts are model-independent,
  // so swapping models must not churn the cache (PLAN §5 ethos).
  const key =
    "llm:" + createHash("sha256").update(task).update("\0").update(input).digest("hex");
  if (db) {
    const hit = db.prepare("SELECT result FROM lookups WHERE key = ?").get(key) as
      | { result: string }
      | undefined;
    if (hit) return schema.parse(JSON.parse(hit.result));
  }

  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  let prompt =
    `${task}\n\nINPUT:\n${input}\n\n` +
    `Respond with ONLY a JSON value matching this JSON Schema — no prose, no code fences:\n${jsonSchema}` +
    (example ? `\nExample of a valid response: ${JSON.stringify(example)}` : "");

  const tiers: Tier[] = tier === "light" && escalate ? ["light", "heavy"] : [tier];
  let lastErr: unknown;
  for (const t of tiers) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = runLLM(prompt, t);
        const value = schema.parse(JSON.parse(pluckJson(raw)));
        db?.prepare(
          "INSERT OR REPLACE INTO lookups (key, provider, result, cost) VALUES (?, ?, ?, 0)",
        ).run(key, `llm:${t}:${tierCmd(t).join(" ")}`, JSON.stringify(value));
        return value;
      } catch (err) {
        lastErr = err;
        prompt += `\n\nYour previous output was invalid (${String(err).slice(0, 300)}). Return ONLY valid JSON matching the schema.`;
      }
    }
  }
  throw new Error(`extract failed after all attempts: ${String(lastErr)}`);
}
