import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// data/PENDING.md — the gitignored "what's left and why" note. Scripts that stop
// at a cap or quota rewrite their own section here so nothing is silently dropped.

const FILE = "data/PENDING.md";
const HEADER = `# Pending work (auto-maintained)

What each step left undone and why (caps, quotas, decisions). Sections are
rewritten by their scripts on every run — human notes go OUTSIDE the markers.
`;

export function notePending(section: string, lines: string[]): void {
  mkdirSync("data", { recursive: true });
  let text = "";
  try { text = readFileSync(FILE, "utf8"); } catch { text = HEADER; }
  const begin = `<!-- BEGIN ${section} -->`, end = `<!-- END ${section} -->`;
  const block = `${begin}\n## ${section} — ${new Date().toISOString().slice(0, 16)}\n${lines.map((l) => `- ${l}`).join("\n")}\n${end}`;
  const re = new RegExp(`${begin}[\\s\\S]*?${end}`);
  text = re.test(text) ? text.replace(re, block) : `${text.trimEnd()}\n\n${block}\n`;
  writeFileSync(FILE, text);
}
