import { Command } from "commander";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Profile } from "./types.ts";
import { openDb } from "./db.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env yet — keyless sources still work
}

export function loadProfile(path = "profile.yaml"): Profile {
  return Profile.parse(parse(readFileSync(path, "utf8")));
}

const program = new Command("jobhunt");

const todo = (verb: string) => () => {
  console.log(`${verb}: not implemented yet (see TOOLING.md build order)`);
};

program.command("signal").description("pull new postings + funding events").action(todo("signal"));
program.command("match").description("score postings against profile.yaml").action(todo("match"));
program.command("people").description("find contacts for matched companies").action(todo("people"));
program.command("enrich").description("run the email waterfall").action(todo("enrich"));
program.command("queue").description("print the LinkedIn connect queue").action(todo("queue"));
program.command("poll").description("diff connections list for acceptances").action(todo("poll"));
program.command("draft").description("create Gmail drafts for warm/cold touches").action(todo("draft"));
program
  .command("status")
  .description("pipeline counts")
  .action(() => {
    const db = openDb();
    for (const t of ["companies", "jobs", "people", "touches", "applications", "lookups"]) {
      const { n } = db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number };
      console.log(`${t}: ${n}`);
    }
  });

program.parse();
