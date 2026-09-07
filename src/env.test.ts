import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, setEnvVar } from "./env.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "env-")), ".env");

test("setEnvVar appends a new key and keeps existing content", () => {
  const p = tmp();
  writeFileSync(p, "# comment\nTWENTY_URL=http://x\n");
  setEnvVar("LLM_LIGHT", "opencode run -m opencode/muse-spark-1.3-contributor-free --variant xhigh", p);
  const t = readFileSync(p, "utf8");
  assert.match(t, /# comment/);
  assert.match(t, /TWENTY_URL=http:\/\/x/);
  assert.match(t, /^LLM_LIGHT="opencode run -m opencode\/muse-spark-1\.3-contributor-free --variant xhigh"$/m);
});

test("setEnvVar replaces in place rather than duplicating", () => {
  const p = tmp();
  writeFileSync(p, 'LLM_LIGHT="old cmd"\nOTHER=1\n');
  setEnvVar("LLM_LIGHT", "claude -p --model opus", p);
  const t = readFileSync(p, "utf8");
  assert.equal(t.match(/^LLM_LIGHT=/gm)?.length, 1);
  assert.match(t, /LLM_LIGHT="claude -p --model opus"/);
  assert.match(t, /OTHER=1/);
});

test("a written command survives loadEnv and splits back into argv", () => {
  const p = tmp();
  const cmd = "opencode run -m opencode/muse-spark-1.3-contributor-free --variant xhigh";
  setEnvVar("LLM_LIGHT", cmd, p);
  delete process.env.LLM_LIGHT;
  loadEnv(p);
  // deepEqual first: assert.equal's `asserts` signature narrows the variable
  // away, so reading it again afterwards no longer typechecks.
  assert.deepEqual((process.env.LLM_LIGHT ?? "").split(" "), [
    "opencode", "run", "-m", "opencode/muse-spark-1.3-contributor-free", "--variant", "xhigh",
  ]);
  assert.equal(process.env.LLM_LIGHT, cmd);           // quotes stripped, spaces intact
});

test("file with no trailing newline does not glue keys together", () => {
  const p = tmp();
  writeFileSync(p, "A=1");                              // no trailing \n
  setEnvVar("LLM_HEAVY", "claude -p", p);
  assert.match(readFileSync(p, "utf8"), /^A=1\nLLM_HEAVY="claude -p"\n$/);
});
