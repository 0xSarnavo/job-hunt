import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { extract, pluckJson } from "./llm.ts";
import { openDb } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "llm-test-"));
function stub(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const Funding = z.object({ company: z.string(), amount_usd_m: z.number() });

test("pluckJson survives prose and fences", () => {
  assert.equal(pluckJson('Sure! ```json\n{"a":1}\n``` hope that helps'), '{"a":1}');
});

test("extract validates prose-wrapped output from a weak model", () => {
  process.env.LLM_LIGHT = stub("good.sh", `echo 'Here you go: {"company":"Runable","amount_usd_m":21}'`);
  const out = extract(Funding, "Extract the funding event.", "Runable raised $21M.", {
    retries: 0,
    escalate: false,
  });
  assert.deepEqual(out, { company: "Runable", amount_usd_m: 21 });
});

test("light garbage escalates to heavy", () => {
  process.env.LLM_LIGHT = stub("bad.sh", `echo 'i am a very small model'`);
  process.env.LLM_HEAVY = stub("heavy.sh", `echo '{"company":"Runable","amount_usd_m":21}'`);
  const out = extract(Funding, "Extract the funding event.", "Runable raised $21M.", {
    retries: 0,
  });
  assert.equal(out.company, "Runable");
});

test("second call with same input never reaches a model", () => {
  const counter = join(dir, "calls");
  writeFileSync(counter, "");
  process.env.LLM_LIGHT = stub(
    "counting.sh",
    `echo x >> ${counter}\necho '{"company":"Yulu","amount_usd_m":93}'`,
  );
  const db = openDb(":memory:");
  for (let i = 0; i < 2; i++) {
    const out = extract(Funding, "Extract.", "Yulu raised $93M.", {
      retries: 0,
      escalate: false,
      db,
    });
    assert.equal(out.company, "Yulu");
  }
  assert.equal(readFileSync(counter, "utf8"), "x\n");
});
