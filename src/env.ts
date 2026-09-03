import { readFileSync } from "node:fs";

// process.loadEnvFile never overrides existing vars — but shell profiles
// sometimes export EMPTY strings (e.g. `export KEY=$(grep ... other/.env)`
// against a file that moved), silently masking this repo's .env. This loader
// lets .env win whenever the current value is unset OR empty. Also tolerates
// quoted values and trailing inline comments.
export function loadEnv(path = ".env"): void {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v.match(/^"([^"]*)"|^'([^']*)'/);
    if (q) v = q[1] ?? q[2] ?? "";
    else v = v.replace(/\s+#.*$/, "").trim();
    if (!process.env[m[1]!]) process.env[m[1]!] = v;
  }
}
